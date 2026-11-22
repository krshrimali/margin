// API used by both the Vite dev server (as middleware) and the production server.
//   GET  /api/health
//   GET  /api/board?name=default      -> saved board JSON (or 404)
//   PUT  /api/board?name=default      -> save board JSON
//   POST /api/ask                     -> NDJSON stream: status / delta / done / error events
//
// An ask runs in two steps:
//   1. Select: a fast model looks at the new content and the list of earlier answers on the
//      board and picks the ones that are relevant (and whether this is a direct follow-up).
//   2. Answer: the main model gets the images, the board structure and the full text of only
//      the selected answers. A direct follow-up continues (a fork of) that answer's session.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.resolve(process.env.WHITEBOARD_DATA || path.join(ROOT, "data"));
const BOARDS_DIR = path.join(DATA_DIR, "boards");
const ASKS_DIR = path.join(DATA_DIR, "asks");
// Default directory Claude runs in. The UI can override it per board ("Project folder").
const CLAUDE_CWD = path.resolve(process.env.CLAUDE_CWD || path.join(DATA_DIR, "workspace"));
// Plugin with the skills the answering agent can load (e.g. board-diagrams).
const AGENT_PLUGIN_DIR = path.join(ROOT, "agent-plugin");
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "";
const SELECT_MODEL = process.env.CLAUDE_SELECT_MODEL || "haiku";
const CLAUDE_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS || 10 * 60 * 1000);
const SELECT_TIMEOUT_MS = 30 * 1000;
// Fallback when Claude is out of budget / rate limited: "codex" (default) or "none".
const FALLBACK = (process.env.WHITEBOARD_FALLBACK || "codex").toLowerCase();
const CODEX_BIN = process.env.CODEX_BIN || "codex";
const CODEX_MODEL = process.env.CODEX_MODEL || "";
// For testing the fallback: skip Claude entirely.
const FORCE_CODEX = process.env.WHITEBOARD_FORCE_CODEX === "1";
// While Claude is out of budget, skip it until its limit resets.
let claudeBlockedUntil = 0;
let claudeBlockedReason = "";
const MAX_BODY = 60 * 1024 * 1024;

for (const d of [BOARDS_DIR, ASKS_DIR, CLAUDE_CWD]) fs.mkdirSync(d, { recursive: true });

const safeName = (n) => (String(n || "default").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "default");
// Board metadata (title, element count) lives next to the board file.
const metaPath = (id) => path.join(BOARDS_DIR, `${id}.meta.json`);
async function readMeta(id) {
  try {
    return JSON.parse(await fsp.readFile(metaPath(id), "utf8"));
  } catch {
    return {};
  }
}
async function writeMeta(id, patch) {
  await fsp.writeFile(metaPath(id), JSON.stringify({ ...(await readMeta(id)), ...patch }));
}
async function uniqueId(title) {
  const base = String(title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "board";
  let id = base;
  for (let i = 2; fs.existsSync(path.join(BOARDS_DIR, `${id}.excalidraw`)); i++) id = `${base}-${i}`;
  return id;
}

const expandHome = (p) => (p.startsWith("~") ? path.join(process.env.HOME || "", p.slice(1)) : p);

function send(res, status, body) {
  const data = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": typeof body === "string" ? "text/plain" : "application/json" });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ------------------------------------------------------------------ claude --
/**
 * Run `claude -p` with a stream-json user message (text + inline images) and
 * stream-json output. Calls onEvent for every output line; resolves with the
 * final result message.
 */
function runClaude({ content, args, cwd, timeoutMs, onEvent, onChild }) {
  return new Promise((resolve, reject) => {
    const fullArgs = [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
      "--dangerously-skip-permissions", ...args,
    ];
    const child = spawn(CLAUDE_BIN, fullArgs, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    onChild?.(child);
    let buf = "";
    let err = "";
    let result = null;
    let rejected = null;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Claude timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type === "result") result = ev;
        if (ev.type === "rate_limit_event" && ev.rate_limit_info?.status === "rejected") rejected = ev.rate_limit_info;
        onEvent?.(ev);
      }
    });
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`Could not start "${CLAUDE_BIN}": ${e.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (result && !result.is_error) return resolve(result);
      if (signal) return reject(new Error("cancelled"));
      const msg = (result && (result.result || result.subtype)) || err.trim() || `claude exited with code ${code}`;
      const e = new Error(String(msg).slice(0, 2000));
      e.budget = !!rejected || [402, 429, 529].includes(Number(result?.api_error_status)) || BUDGET_RE.test(String(msg));
      e.resetsAt = rejected?.resetsAt ? rejected.resetsAt * 1000 : null;
      reject(e);
    });
    child.stdin.end(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
  });
}

// Messages Claude Code gives when the account is out of usage, credits or capacity.
const BUDGET_RE =
  /usage limit|hit your (?:\w+ )?limit|limit reached|rate.?limit|credit balance|out of (?:credits|budget|extra usage)|insufficient (?:credit|fund|quota)|quota|billing|overloaded|\b(?:402|429|529)\b/i;

function markClaudeBlocked(e) {
  const transient = !e.resetsAt && /overloaded|\b529\b/i.test(e.message); // capacity blip, not budget
  claudeBlockedUntil = e.resetsAt && e.resetsAt > Date.now() ? e.resetsAt : Date.now() + (transient ? 2 : 15) * 60 * 1000;
  claudeBlockedReason = e.message.slice(0, 200);
  console.warn(`[claude] out of budget until ${new Date(claudeBlockedUntil).toLocaleTimeString()}: ${claudeBlockedReason}`);
}
const claudeAvailable = () => !FORCE_CODEX && Date.now() >= claudeBlockedUntil;
const canFallback = () => FALLBACK === "codex";

// ------------------------------------------------------------------- codex --
/**
 * Run `codex exec` non-interactively. Images are attached as files. Resolves
 * with { text, threadId } where text is Codex's final message.
 */
function runCodex({ prompt, images, cwd, schema, timeoutMs, onStatus, onChild, workDir }) {
  return new Promise(async (resolve, reject) => {
    const args = ["exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-C", cwd];
    if (CODEX_MODEL) args.push("-m", CODEX_MODEL);
    if (schema) {
      const f = path.join(workDir, "codex-schema.json");
      await fsp.writeFile(f, JSON.stringify(schema));
      args.push("--output-schema", f, "--ephemeral");
    }
    for (const img of images) args.push("--image", img);
    args.push("--", "-"); // prompt from stdin
    const child = spawn(CODEX_BIN, args, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    onChild?.(child);
    let buf = "", err = "", text = "", threadId = null, failure = null;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Codex timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === "thread.started") threadId = ev.thread_id;
        else if (ev.type === "item.completed" && ev.item?.type === "agent_message") text = ev.item.text || text;
        else if (ev.type === "item.started" && ev.item?.type === "command_execution")
          onStatus?.(`Running ${String(ev.item.command || "").replace(/\s+/g, " ").slice(0, 60)}…`);
        else if (ev.type === "item.started" && ev.item?.type === "web_search") onStatus?.("Searching the web…");
        else if (ev.type === "turn.failed" || ev.type === "error") failure = ev.error?.message || ev.message || JSON.stringify(ev).slice(0, 300);
      }
    });
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`Could not start "${CODEX_BIN}": ${e.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal) return reject(new Error("cancelled"));
      if (code === 0 && text) return resolve({ text, threadId });
      reject(new Error(`Codex failed: ${failure || err.trim().split("\n").slice(-3).join(" ") || `exit code ${code}`}`.slice(0, 1500)));
    });
    child.stdin.end(prompt);
  });
}

const imageBlock = (b64) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: b64 } });

function imageBlocks(focusB64, contextB64, marksB64) {
  const blocks = [];
  if (focusB64) blocks.push({ type: "text", text: "FOCUS image:" }, imageBlock(focusB64));
  blocks.push({ type: "text", text: focusB64 ? "CONTEXT image (surroundings):" : "BOARD image:" }, imageBlock(contextB64));
  if (marksB64) blocks.push({ type: "text", text: "MARKS image (same as above, with labelled regions R1, R2… and your cards C1, C2…):" }, imageBlock(marksB64));
  return blocks;
}

// --------------------------------------------------------------- step 1 ----
const SELECT_SCHEMA = {
  type: "object",
  properties: {
    relevant: { type: "array", items: { type: "string" }, description: "ids of relevant earlier answers" },
    followUpOf: { type: ["string", "null"], description: "id of the answer this directly continues, or null" },
    reason: { type: "string" },
  },
  required: ["relevant", "followUpOf"],
};

async function selectContext({ prior, focusB64, contextB64, summary, question, onChild, engine = "claude", imagePaths, workDir }) {
  const list = prior
    .map((p) => {
      const excerpt = p.text.replace(/\s+/g, " ").slice(0, 450);
      return `[${p.id}] ${p.askedAt}${p.question ? ` · typed question: "${p.question}"` : ""} · ${p.dist === 0 ? "touching the focus" : `${p.dist}px from the focus`}
  answer: ${excerpt}${p.text.length > 450 ? " …" : ""}${p.diagram ? `\n  its diagram's labels: ${p.diagram}` : ""}`;
    })
    .join("\n");
  const text = `You pick context for another assistant. On a whiteboard, the user just wrote or drew new content (FOCUS image; the CONTEXT image shows what's around it, where violet "✦ Claude" cards and the diagrams under them are earlier answers). The other assistant will answer it.

Earlier answers on the board:
${list}

Board structure (typed text only; handwriting is in the images):
${summary || "(none)"}
${question?.trim() ? `Typed request: "${question.trim()}"\n` : ""}
Choose the earlier answers the assistant must see to answer well and not repeat itself. Include an answer when the new content:
- points at, circles, underlines or replies to it or to something in its diagram,
- asks a follow-up about it,
- asks something it already covers, or is on the same topic.
Leave out unrelated answers. Handwriting can be hard to read, so when unsure, include. At most 5.
followUpOf: the single id the new content directly continues (it points at or replies to that card or its diagram), otherwise null.`;
  let out, cost = 0;
  if (engine === "codex") {
    // OpenAI structured outputs: every property required, no extras.
    const schema = { ...SELECT_SCHEMA, required: ["relevant", "followUpOf", "reason"], additionalProperties: false };
    const r = await runCodex({
      prompt: `The attached images are, in order: ${focusB64 ? "FOCUS, CONTEXT" : "BOARD"}.\n\n${text}`,
      images: imagePaths, cwd: CLAUDE_CWD, schema, timeoutMs: SELECT_TIMEOUT_MS * 2, onChild, workDir,
    });
    out = JSON.parse(r.text);
  } else {
    const res = await runClaude({
      content: [...imageBlocks(focusB64, contextB64), { type: "text", text }],
      args: ["--model", SELECT_MODEL, "--tools", "", "--no-session-persistence", "--json-schema", JSON.stringify(SELECT_SCHEMA)],
      cwd: CLAUDE_CWD,
      timeoutMs: SELECT_TIMEOUT_MS,
      onChild,
    });
    out = res.structured_output || JSON.parse(res.result);
    cost = res.total_cost_usd || 0;
  }
  const ids = new Set(prior.map((p) => p.id));
  return {
    relevant: (out.relevant || []).filter((id) => ids.has(id)).slice(0, 5),
    followUpOf: ids.has(out.followUpOf) ? out.followUpOf : null,
    reason: out.reason || "",
    cost,
    engine,
  };
}

// --------------------------------------------------------------- step 2 ----
const SCOPE_LABEL = {
  selection: "the part of the board the user selected",
  new: "what the user wrote or drew since your last answer",
  viewport: "the page the user is looking at",
  board: "the entire board",
};

const INK_HELP = `You can also draw on the board with a pen, in your own colour, to explain things the way a teacher marks up a page. Point at regions by their labels from the MARKS image.
Ink commands (a JSON array inside <ink></ink>):
  {"do":"circle","target":"R3","note":"bottleneck"}      circle something (note optional)
  {"do":"underline","target":"R5"}                       underline a key phrase
  {"do":"check","target":"R2"}                           tick something that's right
  {"do":"cross","target":"R4","note":"wrong order"}      mark something wrong
  {"do":"strike","target":"R6"}                          cross out something that should go
  {"do":"arrow","from":"R2","to":"R7","label":"retry"}   draw a missing connection
  {"do":"bracket","targets":["R1","R2"],"note":"same step"}  group several regions
  {"do":"note","near":"R6","text":"add a cache here"}    a handwritten note with an arrow to R6
  {"do":"write","text":"..."}                            a handwritten explanation (up to 40 words) written beside your card
Notes are short handwriting, at most 8 words, and are placed in free space automatically. Give each region at most one note; several notes on the same region are merged into one list. When the user asks you to explain by hand or write things out, use "write". Use at most 8 commands.
If the user asks you to draw a diagram or flowchart, put it in <diagram>. It is drawn by hand in your ink colour. Use ink when pointing at specific parts of the drawing explains it better than words, as in reviews, corrections, "this one" or "missing link". Then keep the card text shorter, because the ink carries the message. Plain questions with nothing to point at need no ink.`;

function regionText(regions) {
  if (!regions?.length) return "";
  return regions
    .slice(0, 140)
    .map((r) => `${r.id}: ${r.kind}${r.label ? ` "${r.label}"` : ""}${r.focus ? " [NEW]" : ""}`)
    .join("\n");
}

function buildPrompt({ hasFocus, summary, question, scope, earlier, cwd, resumed, regions, engine = "claude" }) {
  const images = hasFocus
    ? `- FOCUS image: ${SCOPE_LABEL[scope] || SCOPE_LABEL.new}. Respond to this.
- CONTEXT image: the surrounding board, for context only.`
    : `- BOARD image: ${SCOPE_LABEL[scope] || "the board"}. Respond to it.`;
  const earlierText = earlier.length
    ? earlier.map((p, i) => `${i + 1}. [${p.askedAt}]${p.question ? ` typed question: "${p.question}"` : ""}\n${p.text}`).join("\n\n")
    : "(none relevant)";

  return `${resumed ? "The user has added something new to the board in reply to your answer above.\n\n" : ""}You live inside a hand-drawn whiteboard app. The user writes and draws on the board, mostly by hand, and asks you to respond. Your reply goes on the board as a card next to their content.

${engine === "codex" ? `The attached images, in order: ${hasFocus ? "FOCUS, CONTEXT" : "BOARD"}${regions?.length ? ", MARKS" : ""}.` : "The images attached above:"}
${images}${regions?.length ? "\n- MARKS image: the same board with labelled regions R1, R2… and your cards C1, C2…" : ""}
Violet cards labelled "✦ Claude" are your earlier answers.

Your earlier answers that are relevant here (picked from everything on the board). Do NOT repeat them:
${earlierText}

Typed text, shapes and arrows extracted from the board (handwriting is not included; [NEW] = added since your last answer):
${summary || "(none)"}
${regions?.length ? `\nLabelled regions in the MARKS image:\n${regionText(regions)}\n\n${INK_HELP}\n` : ""}
${question?.trim() ? `\nThe user also typed: "${question.trim()}"\n` : ""}
How to respond:
- Work out the intent from the content itself:
  - A question: answer it.
  - A diagram, flow or design: review it. Say what's wrong or missing and give concrete fixes.
  - Notes or a plan: help with what they're working toward.
  - An arrow, circle or note pointing at one of your earlier cards or diagrams: a follow-up about it.
- If an earlier answer already covers something, don't repeat it. Write one line such as "Covered in my earlier card on X" and add only what's new.
- Start with the answer itself. Don't restate the question, and don't open with "What I see".
- Keep it short: at most about 120 words, in short bullets. The user can ask for more detail.
- Use plain text only, with no markdown (#, **, backticks, tables or links). Use "- " bullets, "1." lists and, rarely, a short CAPITALISED label.
- Add a diagram only when the user asks you to draw, or is designing a system, flow or process and a corrected version would help more than words. Never add one for plain Q&A. When you do, put a Mermaid flowchart, sequenceDiagram, stateDiagram-v2, classDiagram or erDiagram with at most 10 nodes inside <diagram></diagram>.${engine === "claude" ? " Before writing it, load the board-diagrams skill: it lists the shapes, arrows and styles that survive conversion onto the board, and templates." : ""} It is laid out automatically, so keep it simple to avoid overlaps:
  - no subgraphs (put the group in the node label instead, e.g. "GPU (graphics card)"),
  - edge labels of 3 words or fewer; put numbers and details in node labels,
  - one arrow per pair of nodes, using "-->" (a single "<-->" is fine for two-way),
  - prefer "flowchart TD"; use LR only for a short left-to-right pipeline.
- Tools: most answers need none. Only when the board refers to a specific codebase, file or project should you look it up. Your working directory (the user's project folder) is ${cwd}.

Output format (exactly):
<answer>
...your answer...
</answer>
<diagram>
...optional mermaid, omit the whole tag if none...
</diagram>${regions?.length ? `
<ink>
[...optional ink commands, omit the whole tag if none...]
</ink>` : ""}`;
}

function stripMarkdown(s) {
  return s
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*\*\s+/gm, "- ");
}

/** The visible answer text, also while it is still streaming. */
function visibleAnswer(text) {
  const start = text.search(/<answer>/i);
  if (start < 0) return "";
  let body = text.slice(start + "<answer>".length);
  const end = body.search(/<\/answer>/i);
  if (end >= 0) body = body.slice(0, end);
  else body = body.replace(/<\/?a?n?s?w?e?r?$/i, ""); // hide a half-streamed closing tag
  return stripMarkdown(body.trim());
}

function parseAnswer(text) {
  let answer = visibleAnswer(text);
  if (!answer) answer = stripMarkdown(text.replace(/<diagram>[\s\S]*?<\/diagram>/i, "").trim());
  const m = text.match(/<diagram>([\s\S]*?)<\/diagram>/i);
  let diagram = m ? m[1].replace(/^\s*```(?:mermaid)?\s*/i, "").replace(/```\s*$/, "").trim() : null;
  let ink = [];
  const im = text.match(/<ink>([\s\S]*?)<\/ink>/i);
  if (im) {
    try {
      const raw = im[1].replace(/^\s*```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
      const parsed = JSON.parse(raw || "[]");
      ink = (Array.isArray(parsed) ? parsed : parsed.commands || []).filter((c) => c && typeof c === "object").slice(0, 12);
    } catch (e) {
      console.warn("could not parse <ink>:", e.message);
    }
  }
  return { answer, diagram: diagram || null, ink };
}

function toolStatus(block) {
  const i = block.input || {};
  const short = (s) => String(s || "").replace(/\s+/g, " ").slice(0, 60);
  switch (block.name) {
    case "Read": return `Reading ${short(path.basename(i.file_path || ""))}`;
    case "Grep": return `Searching for "${short(i.pattern)}"`;
    case "Glob": return `Looking for ${short(i.pattern)}`;
    case "Bash": return `Running ${short(i.command)}`;
    case "WebSearch": return `Searching the web: ${short(i.query)}`;
    case "WebFetch": return `Reading ${short(i.url)}`;
    case "Skill": return /diagram/i.test(i.skill || "") ? "Reading the diagram guide" : `Loading ${short(i.skill)}`;
    default: return `Using ${block.name}`;
  }
}

// -------------------------------------------------------------- handler ----
async function handleAsk(req, res) {
  const body = JSON.parse(await readBody(req));
  const { image, focusImage, summary, question, scope } = body;
  const prior = Array.isArray(body.prior) ? body.prior.slice(0, 30) : [];
  const png = (d) => /^data:image\/png;base64,(.+)$/.exec(d || "")?.[1];
  const contextB64 = png(image);
  const focusB64 = png(focusImage);
  const marksB64 = png(body.marksImage);
  const regions = Array.isArray(body.regions) ? body.regions : [];
  if (!contextB64) return send(res, 400, { error: "image (PNG data URL) is required" });

  let cwd = CLAUDE_CWD;
  if (body.cwd?.trim()) {
    cwd = path.resolve(expandHome(body.cwd.trim()));
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return send(res, 400, { error: `Project folder not found: ${cwd}` });
  }

  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}`;
  const dir = path.join(ASKS_DIR, id);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, "board.png"), Buffer.from(contextB64, "base64"));
  if (focusB64) await fsp.writeFile(path.join(dir, "focus.png"), Buffer.from(focusB64, "base64"));
  if (marksB64) await fsp.writeFile(path.join(dir, "marks.png"), Buffer.from(marksB64, "base64"));

  res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache" });
  const emit = (ev) => !res.writableEnded && res.write(JSON.stringify(ev) + "\n");
  const children = new Set();
  const track = (c) => {
    children.add(c);
    c.on("close", () => children.delete(c));
  };
  let cancelled = false;
  res.on("close", () => {
    if (!res.writableFinished) {
      cancelled = true;
      for (const c of children) c.kill("SIGTERM");
    }
  });

  const selectImages = [focusB64 && path.join(dir, "focus.png"), path.join(dir, "board.png")].filter(Boolean);
  const answerImages = [...selectImages, marksB64 && path.join(dir, "marks.png")].filter(Boolean);
  const started = Date.now();
  const log = { id, scope, question, cwd, prior: prior.map((p) => p.id) };
  console.log(`[ask ${id}] scope=${scope} prior=${prior.length} cwd=${cwd}`);
  try {
    // ---- step 1: pick relevant earlier answers
    let selection = { relevant: prior.map((p) => p.id), followUpOf: null, reason: "few answers, all passed", cost: 0 };
    if (prior.length > 2) {
      emit({ type: "status", text: "Picking relevant context…" });
      const selArgs = { prior, focusB64, contextB64, summary, question, onChild: track, imagePaths: selectImages, workDir: dir };
      try {
        if (claudeAvailable()) {
          try {
            selection = await selectContext(selArgs);
          } catch (e) {
            if (!e.budget || !canFallback() || cancelled) throw e;
            markClaudeBlocked(e);
            emit({ type: "status", text: "Claude is out of budget, switching to Codex…" });
            selection = await selectContext({ ...selArgs, engine: "codex" });
          }
        } else if (canFallback()) {
          selection = await selectContext({ ...selArgs, engine: "codex" });
        } else throw new Error(`Claude is out of budget until ${new Date(claudeBlockedUntil).toLocaleTimeString()}`);
      } catch (e) {
        if (cancelled) throw e;
        console.warn(`[ask ${id}] context selection failed, using nearest answers:`, e.message);
        const nearest = [...prior].sort((a, b) => a.dist - b.dist).slice(0, 3).map((p) => p.id);
        selection = { relevant: nearest, followUpOf: null, reason: `fallback: ${e.message}`, cost: 0 };
      }
    }
    log.selection = selection;
    const earlier = prior.filter((p) => selection.relevant.includes(p.id));
    emit({ type: "context", ids: selection.relevant, followUpOf: selection.followUpOf });

    // ---- step 2: answer (continuing the followed-up answer's session when possible)
    const parent = prior.find((p) => p.id === selection.followUpOf);
    const canResume = parent?.sessionId && (parent.engine || "claude") === "claude" && path.resolve(parent.cwd || CLAUDE_CWD) === cwd;
    const answer = async (resume) => {
      const prompt = buildPrompt({ hasFocus: !!focusB64, summary, question, scope, earlier, cwd, resumed: resume, regions: marksB64 ? regions : [] });
      await fsp.writeFile(path.join(dir, "prompt.txt"), prompt);
      const args = ["--add-dir", dir, "--plugin-dir", AGENT_PLUGIN_DIR];
      if (CLAUDE_MODEL) args.push("--model", CLAUDE_MODEL);
      if (resume) args.push("--resume", parent.sessionId, "--fork-session");
      args.push("--include-partial-messages");
      let text = "";
      let lastSent = "";
      let lastAt = 0;
      let lastDiagram = "";
      return runClaude({
        content: [...imageBlocks(focusB64, contextB64, marksB64), { type: "text", text: prompt }],
        args,
        cwd,
        timeoutMs: CLAUDE_TIMEOUT_MS,
        onChild: track,
        onEvent: (ev) => {
          if (ev.type === "stream_event" && ev.event?.type === "content_block_delta" && ev.event.delta?.type === "text_delta") {
            text += ev.event.delta.text;
            const vis = visibleAnswer(text);
            if (vis && vis !== lastSent && Date.now() - lastAt > 120) {
              lastSent = vis;
              lastAt = Date.now();
              emit({ type: "delta", answer: vis });
            }
            // Stream the diagram too: send it every time another full line has arrived.
            const dm = text.match(/<diagram>([\s\S]*?)(?:<\/diagram>|$)/i);
            if (dm) {
              const closed = /<\/diagram>/i.test(text);
              const body = dm[1].replace(/^\s*```(?:mermaid)?\s*/i, "");
              const complete = (closed ? body.replace(/```\s*$/, "") : body.slice(0, body.lastIndexOf("\n") + 1)).trim();
              if (complete && complete !== lastDiagram && complete.split("\n").length >= 2) {
                lastDiagram = complete;
                emit({ type: "diagram", mermaid: complete });
              }
            }
          } else if (ev.type === "assistant") {
            for (const b of ev.message?.content || []) if (b.type === "tool_use") emit({ type: "status", text: toolStatus(b) + "…" });
          }
        },
      });
    };
    const answerWithCodex = async () => {
      const prompt = buildPrompt({ hasFocus: !!focusB64, summary, question, scope, earlier, cwd, resumed: false, regions: marksB64 ? regions : [], engine: "codex" });
      await fsp.writeFile(path.join(dir, "prompt.txt"), prompt);
      const r = await runCodex({
        prompt, images: answerImages, cwd, timeoutMs: CLAUDE_TIMEOUT_MS, onChild: track, workDir: dir,
        onStatus: (t) => emit({ type: "status", text: t }),
      });
      const vis = visibleAnswer(r.text);
      if (vis) emit({ type: "delta", answer: vis });
      return { result: r.text, session_id: r.threadId, engine: "codex" };
    };

    let result;
    if (claudeAvailable()) {
      emit({ type: "status", text: canResume ? "Continuing that thread…" : "Answering…" });
      try {
        try {
          result = await answer(canResume);
        } catch (e) {
          if (!canResume || cancelled || e.budget) throw e;
          console.warn(`[ask ${id}] resume failed, answering fresh:`, e.message);
          result = await answer(false);
        }
        result.engine = "claude";
      } catch (e) {
        if (!e.budget || !canFallback() || cancelled) throw e;
        markClaudeBlocked(e);
        emit({ type: "status", text: "Claude is out of budget, switching to Codex…" });
        result = await answerWithCodex();
      }
    } else if (canFallback()) {
      emit({
        type: "status",
        text: FORCE_CODEX ? "Answering with Codex…" : `Claude is out of budget until ${new Date(claudeBlockedUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}, using Codex…`,
      });
      result = await answerWithCodex();
    } else {
      throw new Error(`Claude is out of budget until ${new Date(claudeBlockedUntil).toLocaleTimeString()} (${claudeBlockedReason})`);
    }
    const parsed = parseAnswer(result.result || "");
    log.result = result;
    log.engine = result.engine;
    const costUsd = (result.total_cost_usd || 0) + (selection.cost || 0);
    console.log(`[ask ${id}] done in ${((Date.now() - started) / 1000).toFixed(1)}s, context ${selection.relevant.length}/${prior.length}`);
    emit({
      type: "done",
      id,
      ...parsed,
      durationMs: Date.now() - started,
      costUsd,
      sessionId: result.session_id ?? null,
      engine: result.engine,
      cwd,
      contextIds: selection.relevant,
      followUpOf: selection.followUpOf,
    });
  } catch (e) {
    console.error(`[ask ${id}] ${cancelled ? "cancelled by user" : `failed: ${e.message}`}`);
    log.error = String(e.stack || e);
    emit({ type: "error", error: cancelled ? "cancelled" : e.message });
  } finally {
    await fsp.writeFile(path.join(dir, "result.json"), JSON.stringify(log, null, 2)).catch(() => {});
    res.end();
  }
}

export async function apiHandler(req, res, next) {
  const url = new URL(req.url, "http://localhost");
  if (!url.pathname.startsWith("/api/")) return next?.();
  try {
    if (url.pathname === "/api/health") {
      return send(res, 200, {
        ok: true, claudeCwd: CLAUDE_CWD, model: CLAUDE_MODEL || "default", selectModel: SELECT_MODEL, fallback: FALLBACK,
        claudeBlockedUntil: claudeAvailable() ? null : FORCE_CODEX ? "forced" : new Date(claudeBlockedUntil).toISOString(),
      });
    }
    if (url.pathname === "/api/board") {
      const file = path.join(BOARDS_DIR, `${safeName(url.searchParams.get("name"))}.excalidraw`);
      if (req.method === "GET") {
        if (!fs.existsSync(file)) return send(res, 404, { error: "not found" });
        res.writeHead(200, { "content-type": "application/json" });
        return fs.createReadStream(file).pipe(res);
      }
      if (req.method === "PUT" || req.method === "POST") {
        const body = await readBody(req);
        const parsed = JSON.parse(body); // validate
        const tmp = `${file}.tmp`;
        await fsp.writeFile(tmp, body);
        await fsp.rename(tmp, file);
        const id = safeName(url.searchParams.get("name"));
        await writeMeta(id, { elements: (parsed.elements || []).filter((e) => !e.isDeleted).length });
        return send(res, 200, { ok: true, savedAt: Date.now() });
      }
    }
    // ---------------------------------------------------------------- boards
    // A board is data/boards/<id>.excalidraw, with optional <id>.meta.json
    // ({ title }) and <id>.png (thumbnail). Deleted boards go to data/trash/.
    if (url.pathname === "/api/boards" && req.method === "GET") {
      const files = (await fsp.readdir(BOARDS_DIR)).filter((f) => f.endsWith(".excalidraw"));
      const boards = await Promise.all(
        files.map(async (f) => {
          const id = f.slice(0, -".excalidraw".length);
          const st = await fsp.stat(path.join(BOARDS_DIR, f));
          const meta = await readMeta(id);
          return {
            id,
            title: meta.title || (id === "default" ? "My board" : id),
            updated: st.mtimeMs,
            elements: meta.elements ?? null,
            thumb: fs.existsSync(path.join(BOARDS_DIR, `${id}.png`)) ? Math.round(fs.statSync(path.join(BOARDS_DIR, `${id}.png`)).mtimeMs) : null,
          };
        }),
      );
      boards.sort((a, b) => b.updated - a.updated);
      return send(res, 200, { boards });
    }
    if (url.pathname === "/api/boards" && req.method === "POST") {
      const { title = "Untitled board", from } = JSON.parse((await readBody(req)) || "{}");
      const id = await uniqueId(title);
      const src = from ? path.join(BOARDS_DIR, `${safeName(from)}.excalidraw`) : null;
      if (src && fs.existsSync(src)) {
        await fsp.copyFile(src, path.join(BOARDS_DIR, `${id}.excalidraw`));
        const thumb = path.join(BOARDS_DIR, `${safeName(from)}.png`);
        if (fs.existsSync(thumb)) await fsp.copyFile(thumb, path.join(BOARDS_DIR, `${id}.png`));
      } else {
        await fsp.writeFile(
          path.join(BOARDS_DIR, `${id}.excalidraw`),
          JSON.stringify({ type: "excalidraw", version: 2, source: "claude-whiteboard", elements: [], appState: {}, files: {} }),
        );
      }
      await writeMeta(id, { title: String(title).slice(0, 120), elements: from ? (await readMeta(safeName(from))).elements ?? null : 0 });
      return send(res, 200, { id });
    }
    const m = /^\/api\/boards\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
    if (m) {
      const id = m[1];
      const file = path.join(BOARDS_DIR, `${id}.excalidraw`);
      if (!fs.existsSync(file)) return send(res, 404, { error: "no such board" });
      if (req.method === "PATCH") {
        const { title } = JSON.parse(await readBody(req));
        await writeMeta(id, { title: String(title || "").trim().slice(0, 120) || id });
        return send(res, 200, { ok: true });
      }
      if (req.method === "DELETE") {
        const trash = path.join(DATA_DIR, "trash", `${id}-${Date.now()}`);
        await fsp.mkdir(trash, { recursive: true });
        for (const ext of [".excalidraw", ".meta.json", ".png"]) {
          const f = path.join(BOARDS_DIR, id + ext);
          if (fs.existsSync(f)) await fsp.rename(f, path.join(trash, id + ext));
        }
        return send(res, 200, { ok: true, trash });
      }
    }
    if (url.pathname === "/api/board/thumb") {
      const file = path.join(BOARDS_DIR, `${safeName(url.searchParams.get("name"))}.png`);
      if (req.method === "GET") {
        if (!fs.existsSync(file)) return send(res, 404, { error: "no thumbnail" });
        res.writeHead(200, { "content-type": "image/png", "cache-control": "no-cache" });
        return fs.createReadStream(file).pipe(res);
      }
      if (req.method === "PUT") {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        await fsp.writeFile(file, Buffer.concat(chunks));
        return send(res, 200, { ok: true });
      }
    }

    if (url.pathname === "/api/ask" && req.method === "POST") return await handleAsk(req, res);
    send(res, 404, { error: "unknown endpoint" });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: e.message });
  }
}
