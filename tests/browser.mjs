import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { startServer } from "./server.mjs";
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM });
const server = await startServer();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem("whiteboard.editMode", JSON.stringify("ask")));
  let failSave = false;
  let saved = { elements: [], appState: {}, files: {} }, answer, request;
  await page.route("**/api/board?*", async (route) => {
    if (failSave && route.request().method() === "PUT") return route.fulfill({ status: 503, json: {} });
    const response = await route.fetch();
    if (response.ok() && route.request().method() === "PUT") saved = route.request().postDataJSON();
    await route.fulfill({ response });
  });
  await page.route("**/api/board/thumb?*", (route) => route.fulfill({ json: {} }));
  await page.route("**/api/ask", async (route) => {
    request = route.request().postDataJSON();
    const preview = answer.draw ? { type: "draw", items: answer.draw } : answer.diagram ? { type: "diagram", mermaid: answer.diagram } : null;
    const records = [{ type: "delta", answer: answer.answer }, preview, { type: "done", durationMs: 2500, costUsd: 0.012, ...answer }].filter(Boolean);
    await route.fulfill({ contentType: "application/x-ndjson", body: records.map((r) => JSON.stringify(r)).join("\n") + "\n" });
  });
  await page.goto(server.url + "/?board=visual-verification");
  await page.locator(".excalidraw canvas").first().waitFor();
  async function ask(question, payload) {
    answer = payload;
    await page.locator(".claude-caret").click();
    const field = page.locator(".claude-pop textarea");
    await field.fill(question);
    await Promise.all([page.waitForResponse("**/api/ask"), field.press("Control+Enter")]);
    await page.waitForFunction(() => !document.querySelector(".run-status"), { timeout: 20000 });
    await page.keyboard.press("Control+s");
    for (let i = 0; i < 60 && !saved.elements.some((e) => e.customData?.askId === payload.id); i++) await page.waitForTimeout(100);
    const elements = saved.elements.filter((e) => e.customData?.askId === payload.id);
    assert(elements.length, `No saved elements for ${payload.id}. Errors: ${errors.join(", ")}`);
    assert(elements.every((e) => !e.customData.claudePending));
    return elements;
  }
  const first = "if let Some(x) = value {\n  if x > 0 { use_it(x); }\n}";
  const second = "if let Some(x) = value\n  && x > 0 { use_it(x); }";
  const comparison = await ask("Draw a whiteboard comparing nested if let with let chains", {
    id: "comparison", answer: "A later condition can use the binding established by an earlier one.",
    draw: [{ layout: "comparison", title: "Let chains run left to right", panels: [
      { label: "Nested checks", body: first, code: true }, { label: "Let chain", body: second, code: true },
    ] }],
  });
  assert.match(request.image, /^data:image\/png;base64,/);
  assert.equal(request.summary, "");
  assert.equal(comparison.filter((e) => e.text === "Let chains run left to right").length, 1);
  const panels = comparison.filter((e) => e.id.includes("-panel-"));
  assert.equal(panels.length, 2);
  assert.equal(panels[0].width, panels[1].width);
  assert.equal(panels[0].y, panels[1].y);
  assert(panels[0].x + panels[0].width < panels[1].x);
  for (const body of [first, second]) assert(comparison.some((e) => e.text === body));
  assert(comparison.find((e) => e.customData.role === "text").y > panels[0].y + panels[0].height);

  const flow = await ask("Draw how cache misses reach the origin", {
    id: "flow", answer: "Only cache misses need a trip to the origin.",
    diagram: "%% title: Cache misses reach the origin\nflowchart TD\nA[Browser] --> B[Edge cache]\nB --> C{Hit?}\nC -->|yes| D[Return cached copy]\nC -->|no| E[Fetch origin]",
  });
  assert(flow.some((e) => e.text === "Cache misses reach the origin"));
  assert.equal(flow.filter((e) => e.type === "arrow").length, 4);
  assert(!flow.some((e) => e.customData.role === "bg"));
  const bounds = (elements) => [
    Math.min(...elements.map((e) => e.x)), Math.min(...elements.map((e) => e.y)),
    Math.max(...elements.map((e) => e.x + e.width)), Math.max(...elements.map((e) => e.y + e.height)),
  ];
  const [ax, ay, bx, by] = bounds(comparison);
  const [cx, cy, dx, dy] = bounds(flow);
  assert(bx <= cx || dx <= ax || by <= cy || dy <= ay, "Drawing overlaps the prior comparison");

  const semantic = await page.evaluate(async () => {
    const { elements } = await window.__wbDebug.diagramElements("flowchart TD\nsubgraph private[Internal network]\nA[API] -->|only when approval expires| B[Refresh]\nend\nB --> C[Return]", { width: 380, height: 700 });
    return elements.filter((e) => e.type === "text").map((e) => (e.originalText || e.text).replace(/\s+/g, " "));
  });
  assert(semantic.includes("only when approval expires"));
  assert(semantic.includes("Internal network"));

  const walkthrough = await ask("Walk me through DNS", {
    id: "steps", answer: "A resolver finds the server address.",
    draw: [{ title: "DNS finds the address" }, { step: 1, say: "The browser asks its resolver." },
      { id: "b", shape: "rounded", at: [0, 0], text: "Browser" },
      { step: 2, say: "The resolver returns an address." }, { id: "r", shape: "rounded", at: [1, 0], text: "Resolver" },
      { shape: "arrow", from: "b", to: "r" }],
  });
  assert(walkthrough.some((e) => e.customData.narration?.length === 2));
  assert(walkthrough.some((e) => e.customData.step === 2 && e.opacity > 0));
  await page.getByText("The browser asks its resolver.", { exact: true }).waitFor();
  await page.keyboard.press("Escape");

  const text = await ask("What is a resolver?", { id: "text", answer: "A DNS resolver finds an IP address for a domain." });
  assert(text.some((e) => e.customData.role === "bg"));
  assert(!text.some((e) => e.customData.visualReply));

  const invalid = await ask("Draw a comparison", {
    id: "fallback", answer: "Here is the textual fallback.",
    draw: [{ layout: "comparison", title: "Incomplete", panels: [{ label: "One", body: "Only one panel" }] }],
  });
  assert(invalid.some((e) => e.text === "Here is the textual fallback."));
  assert(!invalid.some((e) => e.customData.visualReply));
  await ask("Draw a short visual to test undo", {
    id: "undo", answer: "The browser caches the lookup.",
    draw: [{ title: "The browser keeps the result" }, { shape: "rounded", at: [0, 0], text: "DNS cache" }],
  });
  const undo = page.getByRole("button", { name: "Undo", exact: true });
  assert(await undo.isEnabled());
  await undo.click();
  await page.waitForTimeout(700);
  await page.keyboard.press("Control+s");
  for (let i = 0; i < 50 && saved.elements.some((e) => e.customData?.askId === "undo"); i++) await page.waitForTimeout(100);
  assert(!saved.elements.some((e) => e.customData?.askId === "undo"), "Undo did not remove the visual");
  assert(saved.elements.some((e) => e.customData?.askId === "comparison"), "Undo removed earlier content");
  const geometry = await page.evaluate(() => {
    const draw = (items, viewportWidth = 400) => window.__wbDebug.buildDrawing(items, { prefix: "check", viewportWidth }).elements;
    const nodes = ["a", "b"].map((id) => ({ id, shape: "rounded", at: [0, 0], text: id }));
    const edge = { shape: "arrow", from: "a", to: "b" };
    const repairs = draw([edge, ...nodes]);
    let missing = false;
    try { draw([edge, nodes[0]]); } catch { missing = true; }
    const panels = draw([{ layout: "comparison", title: "Compare", panels: [{ label: "A", body: "short" }, { label: "B", body: "x".repeat(120), code: true }] }]).filter((e) => e.type === "rectangle");
    const boxes = repairs.filter((e) => e.type === "rectangle");
    const process = draw([{ layout: "process", title: "Cache", stages: [{ id: "a", text: "Read" }, { id: "b", text: "Return" }] }]);
    return {
      edge: repairs.some((e) => e.type === "arrow" && e.startBinding && e.endBinding), missing,
      separate: boxes[0].y + boxes[0].height < boxes[1].y,
      fits: panels.every((e) => e.width < 400) && panels[0].y + panels[0].height < panels[1].y,
      process: process.some((e) => e.type === "arrow"),
    };
  });
  assert.deepEqual(geometry, { edge: true, missing: true, separate: true, fits: true, process: true });
  await page.evaluate(() => {
    const api = window.excalidrawAPI;
    const { elements } = window.__wbDebug.buildDrawing([{ shape: "rounded", at: [0,0], text: "Original" }], { prefix: "user" });
    api.updateScene({ elements: [...api.getSceneElements(), ...elements], appState: { selectedElementIds: { [elements[0].id]: true } } });
  });
  await ask("Rename the selected label", { id: "proposal", answer: "Suggested a rename.", edits: [{ do: "relabel", target: "R1", text: "Proposed" }] });
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page.getByAltText("Proposed result").waitFor();
  await Promise.all([page.waitForResponse((r) => r.request().method() === "PUT" && r.url().includes("/api/board?")), page.keyboard.press("Control+s")]);
  assert(saved.elements.some((e) => e.text === "Original"));
  assert(!saved.elements.some((e) => e.text === "Proposed"));
  assert.equal(saved.proposals.length, 1);
  await page.reload();
  await page.getByRole("button", { name: "Accept all" }).click();
  await page.waitForFunction(() => window.excalidrawAPI.getSceneElements().some((e) => e.text === "Proposed"));
  failSave = true;
  await page.keyboard.press("Control+s");
  await page.getByText("Save failed (HTTP 503)", { exact: true }).waitFor();
  failSave = false;
  const endpoint = server.url + "/api/board?name=race";
  const initial = await fetch(endpoint, { method: "PUT", headers: { "If-None-Match": "*" }, body: JSON.stringify({ elements: [] }) });
  const revision = initial.headers.get("etag");
  assert(revision);
  const writes = await Promise.all([1, 2].map((n) => fetch(endpoint, { method: "PUT", headers: { "If-Match": revision }, body: JSON.stringify({ elements: [], n }) })));
  assert.deepEqual(writes.map((r) => r.status).sort(), [200, 409]);
  // A failed initial read must never create a blank replacement.
  const failedLoad = await browser.newPage();
  let overwrites = 0;
  await failedLoad.route("**/api/board?*", (route) => {
    if (route.request().method() === "PUT") overwrites++;
    return route.fulfill({ status: 503, json: { error: "Temporary read failure" } });
  });
  await failedLoad.goto(server.url + "/?board=race");
  await failedLoad.getByRole("alert").waitFor();
  await failedLoad.keyboard.press("Control+s");
  assert.equal(overwrites, 0);
  await failedLoad.close();
  assert.deepEqual(errors, []);
  console.log("Passed comparison, blank-board submission, occupied-board Mermaid layout, walkthrough, text card, invalid drawing fallback, layout regressions, preview persistence, failed saves, and conflicting writes.");
} finally {
  await browser.close();
  await server.close();
}
