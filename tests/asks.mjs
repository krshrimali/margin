import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "./server.mjs";

const temp = await mkdtemp(path.join(tmpdir(), "margin-cli-test-"));
const bin = path.join(temp, "model");
const calls = path.join(temp, "calls.jsonl");
await writeFile(bin, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
(async () => {
  let input = "";
  for await (const part of process.stdin) input += part;
  fs.appendFileSync(process.env.TEST_CALLS, JSON.stringify({args, input}) + "\\n");
  console.log(JSON.stringify(input.includes("simulate usage limit")
    ? {type:"result", is_error:true, result:"usage limit reached"}
    : {type:"result", result:"<answer>Done</answer>", total_cost_usd:0.01}));
})();
`, { mode: 0o755 });
const server = await startServer({ CLAUDE_BIN: bin, CODEX_BIN: bin, TEST_CALLS: calls, WHITEBOARD_FORCE_CODEX: "", WHITEBOARD_FALLBACK: "codex" });
try {
  async function ask(params) {
    const response = await fetch(server.url + "/api/ask", { method: "POST", body: JSON.stringify({
      image: "data:image/png;base64,AA==", prior: [], question: "Draw a comparison", ...params,
    }) });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    return text.trim().split("\n").map(JSON.parse).at(-1);
  }
  const invocations = async () => (await readFile(calls, "utf8")).trim().split("\n").map(JSON.parse);
  const prior = [1, 2, 3, 4].map((n) => ({ id: String(n), text: "Earlier", dist: n }));
  assert.equal((await ask({ maxBudget: 0.5, prior })).type, "done");
  let recorded = await invocations();
  assert.equal(recorded.length, 1);
  assert(recorded[0].args.includes("--restricted"));
  assert.equal(recorded[0].args[recorded[0].args.indexOf("--tools") + 1], "");
  assert.equal(recorded[0].args[recorded[0].args.indexOf("--max-budget-usd") + 1], "0.5");

  const original = await ask({ links: ["https://example.org/article"], attachments: [{ name: "source.txt", data: "data:text/plain;base64,Ym9hcmQ=" }] });
  assert(original.inputRef);
  const replay = await ask({ replayId: original.inputRef });
  assert(replay.inputRef);
  recorded = await invocations();
  const input = recorded.at(-1);
  const folder = input.args[input.args.indexOf("--add-dir") + 1];
  assert.equal(await readFile(path.join(folder, "attachments", "1-source.txt"), "utf8"), "board");
  assert(input.input.includes("https://example.org/article"));

  const refused = await ask({ question: "simulate usage limit", maxBudget: 0.5 });
  assert.equal(refused.type, "error");
  assert.match(refused.error, /cannot enforce/i);
  assert.equal((await invocations()).length, 4);
  console.log("Passed restricted drawing tools, whole-ask cap, capped fallback, and attachment/link replay.");
} finally {
  await server.close();
  await rm(temp, { recursive: true, force: true });
}
