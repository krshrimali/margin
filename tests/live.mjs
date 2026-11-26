// Opt-in: two real prompts per engine. Writes PNGs to a new temporary directory.
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer } from "./server.mjs";
const output = await mkdtemp(path.join(tmpdir(), "margin-live-"));
console.log("Screenshots:", output);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM });
try {
  const results = await Promise.allSettled(["claude", "codex"].map(async (engine) => {
    const server = await startServer({ WHITEBOARD_FORCE_CODEX: engine === "codex" ? "1" : "", WHITEBOARD_FALLBACK: engine === "codex" ? "codex" : "none", CLAUDE_TIMEOUT_MS: "90000" });
    try {
      for (const [i, question] of ["Draw a side-by-side comparison of nested Rust if let and let chains.", "Draw an annotated example explaining the guard in a Rust let chain."].entries()) {
        const page = await browser.newPage({ reducedMotion: "reduce", viewport: { width: i ? 420 : 1280, height: 850 } });
        try {
          await page.goto(server.url + "/?board=sample-" + i);
          await page.locator(".claude-caret").click();
          const field = page.locator(".claude-pop textarea");
          await field.fill(question);
          const [response] = await Promise.all([page.waitForResponse("**/api/ask"), field.press("Control+Enter")]);
          const records = (await response.text()).trim().split("\n").map(JSON.parse);
          const error = records.find((e) => e.type === "error");
          assert(!error, error?.error);
          const done = records.find((e) => e.type === "done");
          assert.equal(done?.engine, engine);
          await page.waitForFunction(() => window.excalidrawAPI.getSceneElements().some((e) => e.customData?.visualReply && !e.customData.claudePending));
          await page.waitForTimeout(500);
          await page.screenshot({ path: path.join(output, engine + "-" + i + ".png") });
          console.log(engine, done.draw?.[0]?.layout || "diagram", done.answer);
        } finally { await page.close(); }
      }
    } finally { await server.close(); }
  }));
  for (const result of results) if (result.status === "rejected") { console.error(result.reason); process.exitCode = 1; }
} finally { await browser.close(); }
