import {
  exportToBlob,
  convertToExcalidrawElements,
  getCommonBounds,
  getVisibleSceneBounds,
  elementsOverlappingBBox,
  CaptureUpdateAction,
  FONT_FAMILY,
  ROUNDNESS,
} from "@excalidraw/excalidraw";
import { regionsFor, markElements, renderInk } from "./ink.js";

export const SCOPES = {
  auto: "Auto",
  selection: "Selection",
  viewport: "Visible page",
  board: "Whole board",
};
export const SCOPE_HINTS = {
  auto: "Your selection if you have one, otherwise whatever you wrote since Claude's last answer (plus what's around it).",
  selection: "Only the selected elements.",
  viewport: "Everything currently on screen.",
  board: "The entire board.",
};

const VIOLET = "#6741d9";
const CARD_BG = "#f3f0ff";
const CARD_W = 520; // text width
const PAD = 16; // card padding around the text
const GAP = 48; // distance between the answer and other content
const CONTEXT_MARGIN = 700; // scene px of surroundings included around new ink

const rid = () => Math.random().toString(36).slice(2, 12);
const live = (api) => api.getSceneElements().filter((e) => !e.isDeleted);
const isPending = (el) => !!el.customData?.claudePending;
const isClaude = (el) => !!el.customData?.claude || isPending(el);

// Answer-card text element (new cards carry role "text"; older cards are recognised by their background).
function cardTextOf(el, byId) {
  if (!el.customData?.claude) return null;
  if (el.customData.role === "text") return el.text;
  if (!el.customData.role && el.type === "rectangle" && el.backgroundColor === CARD_BG) {
    const b = el.boundElements?.find((b) => b.type === "text");
    return b ? byId.get(b.id)?.text ?? null : null;
  }
  return null;
}
const askedAtOf = (el) => el.customData?.askedAt ?? el.updated ?? 0;

// ------------------------------------------------------------ geometry ----
const boundsOf = (els) => {
  const [minX, minY, maxX, maxY] = getCommonBounds(els);
  return { minX, minY, maxX, maxY };
};
const grow = (b, m) => [b.minX - m, b.minY - m, b.maxX + m, b.maxY + m];
const centre = (b) => [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
const rectDist = (a, b) => {
  const dx = Math.max(0, a.minX - b.maxX, b.minX - a.maxX);
  const dy = Math.max(0, a.minY - b.maxY, b.minY - a.maxY);
  return Math.hypot(dx, dy);
};

/**
 * Close a set of elements over the things that belong with them, so a
 * partially visible box never loses its label: bound text <-> container,
 * group members, frame children, and arrow labels.
 */
function expand(picked, all) {
  const ids = new Set(picked.map((e) => e.id));
  const groups = new Set(picked.flatMap((e) => e.groupIds || []));
  const frames = new Set(picked.filter((e) => e.type === "frame" || e.type === "magicframe").map((e) => e.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of all) {
      if (ids.has(e.id)) continue;
      const belongs =
        (e.containerId && ids.has(e.containerId)) ||
        e.boundElements?.some((b) => b.type === "text" && ids.has(b.id)) ||
        e.groupIds?.some((g) => groups.has(g)) ||
        (e.frameId && frames.has(e.frameId));
      if (belongs) {
        ids.add(e.id);
        e.groupIds?.forEach((g) => groups.add(g));
        changed = true;
      }
    }
  }
  return all.filter((e) => ids.has(e.id));
}

// ------------------------------------------------------------- targets ----
/** User content added or changed since Claude last answered on this board. */
function newInk(all) {
  const cards = all.filter((e) => e.customData?.claude);
  const last = cards.length ? Math.max(...cards.map(askedAtOf)) : 0;
  return all.filter((e) => !isClaude(e) && (e.updated ?? 0) > last + 500);
}

/**
 * Returns { scope, context, focus }:
 *   context – what goes in the overview snapshot
 *   focus   – what Claude should respond to (selection or new ink); may be empty
 */
function selectTargets(api, scope) {
  const all = live(api).filter((e) => !isPending(e));
  const appState = api.getAppState();
  const selected = all.filter((e) => appState.selectedElementIds?.[e.id]);
  const visible = () => elementsOverlappingBBox({ elements: all, bounds: getVisibleSceneBounds(appState), type: "overlap" });
  const fresh = newInk(all);

  if ((scope === "auto" || scope === "selection") && selected.length) {
    const focus = expand(selected, all);
    const around = elementsOverlappingBBox({ elements: all, bounds: grow(boundsOf(focus), CONTEXT_MARGIN), type: "overlap" });
    return { scope: "selection", focus, context: expand([...focus, ...around], all) };
  }
  if (scope === "auto" && fresh.length) {
    const focus = expand(fresh, all).filter((e) => !isClaude(e));
    const around = elementsOverlappingBBox({ elements: all, bounds: grow(boundsOf(focus), CONTEXT_MARGIN), type: "overlap" });
    return { scope: "new", focus, context: expand([...focus, ...around], all) };
  }
  let context = scope === "board" ? all : visible();
  if (!context.length) context = all;
  context = expand(context, all);
  const ids = new Set(context.map((e) => e.id));
  const focus = fresh.filter((e) => ids.has(e.id));
  return { scope: scope === "board" ? "board" : "viewport", focus: focus.length < context.filter((e) => !isClaude(e)).length ? focus : [], context };
}

// ------------------------------------------------------------- summary ----
function summarize(elements, focusIds) {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const labelOf = (el) => {
    if (!el) return null;
    if (el.type === "text") return el.text;
    const b = el.boundElements?.find((b) => b.type === "text");
    const t = b && byId.get(b.id);
    return t ? t.text : null;
  };
  const q = (s) => JSON.stringify((s || "").replace(/\s+/g, " ").trim().slice(0, 200));
  const lines = [];
  let strokes = 0, newStrokes = 0, images = 0;
  for (const el of elements) {
    if (isClaude(el)) continue; // earlier answers are passed separately, in full
    const tag = focusIds.has(el.id) ? " [NEW]" : "";
    switch (el.type) {
      case "freedraw":
        strokes++;
        if (tag) newStrokes++;
        break;
      case "image":
        images++;
        break;
      case "text":
        if (!el.containerId) lines.push(`- text ${q(el.text)}${tag}`);
        break;
      case "arrow":
      case "line": {
        const from = labelOf(byId.get(el.startBinding?.elementId));
        const to = labelOf(byId.get(el.endBinding?.elementId));
        const lbl = labelOf(el);
        if (from || to || lbl) lines.push(`- ${el.type} from ${from ? q(from) : "(unconnected)"} to ${to ? q(to) : "(unconnected)"}${lbl ? ` labelled ${q(lbl)}` : ""}${tag}`);
        break;
      }
      case "frame":
      case "magicframe":
        lines.push(`- frame ${q(el.name || "")}${tag}`);
        break;
      default: {
        const lbl = labelOf(el);
        lines.push(`- ${el.type}${lbl ? ` containing ${q(lbl)}` : " (no text)"}${tag}`);
      }
    }
  }
  if (strokes) lines.push(`- ${strokes} freehand pen strokes${newStrokes ? ` (${newStrokes} of them NEW)` : ""} — handwriting/sketches, read them from the image`);
  if (images) lines.push(`- ${images} embedded images`);
  return lines.join("\n").slice(0, 8000);
}

/**
 * Every earlier answer on the board (nearest to the focus first, max 30) with
 * the labels of its suggested diagram. The server lets Claude pick which of
 * these are relevant before answering.
 */
function priorAnswers(all, near) {
  const byId = new Map(all.map((e) => [e.id, e]));
  const diagramLabels = new Map();
  for (const e of all) {
    const c = e.customData;
    if (!c?.claude || e.type !== "text" || !c.askId) continue;
    const isDiagram =
      c.role === "diagram" ||
      (!c.role && !e.text.startsWith("✦ Claude") && byId.get(e.containerId)?.backgroundColor !== CARD_BG);
    if (!isDiagram || e.text === "Suggested diagram") continue;
    diagramLabels.set(c.askId, [...(diagramLabels.get(c.askId) || []), e.text.replace(/\s+/g, " ")]);
  }
  return all
    .map((e) => ({ e, text: cardTextOf(e, byId) }))
    .filter((c) => c.text)
    .map(({ e, text }) => ({
      id: e.customData.askId || e.id,
      askedAt: new Date(askedAtOf(e)).toLocaleString(),
      question: e.customData.question || "",
      text: text.length > 2500 ? text.slice(0, 2500) + " …" : text,
      diagram: (diagramLabels.get(e.customData.askId) || []).join(" | ").slice(0, 400),
      sessionId: e.customData.sessionId || null,
      engine: e.customData.engine || "claude",
      cwd: e.customData.cwd || null,
      dist: Math.round(rectDist(boundsOf([e]), near)),
    }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 30);
}

// -------------------------------------------------------------- export ----
async function snapshot(api, elements, maxSide) {
  const blob = await exportToBlob({
    elements,
    files: api.getFiles(),
    appState: { ...api.getAppState(), exportBackground: true, viewBackgroundColor: "#ffffff", exportWithDarkMode: false },
    mimeType: "image/png",
    exportPadding: 32,
    getDimensions: (w, h) => {
      const scale = Math.max(0.25, Math.min(2, maxSide / Math.max(w, h)));
      return { width: w * scale, height: h * scale, scale };
    },
  });
  return await new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.readAsDataURL(blob);
  });
}

// ----------------------------------------------------------- placement ----
/**
 * Find a spot for a w×h block near `anchor` that doesn't overlap anything on
 * the board. Prefers right of the anchor, then below, left, above; slides
 * outward past obstacles until it finds clear space.
 */
export function findFreeSpot(w, h, anchor, obstacles, GAP = 48) {
  const rects = obstacles.map((e) => boundsOf([e]));
  const m = GAP / 2;
  const free = (x, y) =>
    rects.every((r) => x + w + m <= r.minX || x - m >= r.maxX || y + h + m <= r.minY || y - m >= r.maxY);

  const step = 40;
  const ax = anchor.minX, ay = anchor.minY, bx = anchor.maxX, by = anchor.maxY;
  const cands = [];
  for (let k = 0; k < 80; k++) {
    const d = k * step;
    cands.push([bx + GAP + d, ay, 0]); // right, top-aligned
    cands.push([ax, by + GAP + d, 60]); // below, left-aligned
    cands.push([ax - GAP - w - d, ay, 160]); // left
    cands.push([ax, ay - GAP - h - d, 220]); // above
    for (let j = 1; j <= 12; j++) {
      cands.push([bx + GAP + d, ay + j * step, 20 + j * 5]);
      cands.push([bx + GAP + d, ay - j * step, 40 + j * 5]);
      cands.push([ax + j * step, by + GAP + d, 80 + j * 5]);
    }
  }
  let best = null;
  for (const [x, y, pen] of cands) {
    const cost = Math.hypot(x - bx, y - ay) + pen;
    if ((!best || cost < best.cost) && free(x, y)) best = { x, y, cost };
  }
  if (best) return best;
  const all = rects.length ? rects.reduce((a, r) => ({ maxX: Math.max(a.maxX, r.maxX), minY: Math.min(a.minY, r.minY) })) : { maxX: 0, minY: 0 };
  return { x: all.maxX + GAP * 2, y: all.minY };
}

const translate = (els, dx, dy) => els.map((e) => ({ ...e, x: e.x + dx, y: e.y + dy }));

// --------------------------------------------------------- answer cards ---
const SCOPE_TITLES = { selection: "Selection", new: "New ink", viewport: "Visible page", board: "Whole board" };

function headerText(scope, question) {
  const t = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const qq = question?.trim().replace(/\s+/g, " ") || "";
  const q = qq ? `  —  “${qq.slice(0, 60)}${qq.length > 60 ? "…" : ""}”` : "";
  return `✦ Claude · ${SCOPE_TITLES[scope] || scope} · ${t}${q}`;
}

/**
 * Card = header line + padded violet background + wrapped text.
 * The text lives in an invisible container so Excalidraw wraps it; the
 * visible background is a separate rectangle with real padding.
 */
function cardElements({ header, body, groupId, pending, meta }) {
  const base = pending ? { claudePending: true } : { claude: true, ...meta };
  const [head, holder, text] = convertToExcalidrawElements([
    { type: "text", x: 0, y: 0, text: header, fontSize: 14, fontFamily: FONT_FAMILY.Nunito, strokeColor: VIOLET },
    {
      type: "rectangle", x: PAD, y: 26 + PAD, width: CARD_W, height: 40,
      strokeColor: "transparent", backgroundColor: "transparent", strokeWidth: 1, roughness: 0,
      label: {
        text: body, fontSize: 17, fontFamily: FONT_FAMILY.Nunito, textAlign: "left", verticalAlign: "top",
        strokeColor: pending ? VIOLET : "#1e1e1e",
      },
    },
  ]);
  const [bg] = convertToExcalidrawElements([
    {
      type: "rectangle", x: 0, y: 26, width: CARD_W + 2 * PAD, height: holder.height + 2 * PAD,
      strokeColor: VIOLET, backgroundColor: CARD_BG, fillStyle: "solid", strokeWidth: 1, roughness: 0,
      strokeStyle: pending ? "dashed" : "solid", roundness: { type: ROUNDNESS.ADAPTIVE_RADIUS },
    },
  ]);
  const tag = (e, role) => ({ ...e, groupIds: [groupId], customData: { ...base, role } });
  return [tag(head, "header"), tag(bg, "bg"), tag(holder, "holder"), tag(text, "text")];
}

async function diagramElements(mermaid) {
  const { parseMermaidToExcalidraw } = await import("@excalidraw/mermaid-to-excalidraw");
  const { elements, files } = await parseMermaidToExcalidraw(mermaid, { themeVariables: { fontSize: "16px" } });
  return { elements: convertToExcalidrawElements(elements, { regenerateIds: true }), files };
}

function insert(api, newEls, capture = CaptureUpdateAction.IMMEDIATELY) {
  api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), ...newEls], captureUpdate: capture });
}

function removeById(api, ids) {
  api.updateScene({
    elements: api.getSceneElementsIncludingDeleted().filter((e) => !ids.has(e.id)),
    captureUpdate: CaptureUpdateAction.NEVER,
  });
}

function scrollIntoViewIfNeeded(api, els) {
  const v = getVisibleSceneBounds(api.getAppState());
  const b = boundsOf(els);
  const visible = b.minX < v[2] && b.maxX > v[0] && b.minY < v[3] && b.maxY > v[1];
  if (!visible) api.scrollToContent(els, { animate: true, fitToViewport: false });
}

// -------------------------------------------------------- running asks ---
// Observable list of in-flight asks, for the UI (status line, timer, cancel).
const running = new Map();
const listeners = new Set();
const notify = () => listeners.forEach((l) => l([...running.values()]));
export const onRunningChange = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
export const cancelAsk = (id) => running.get(id)?.controller.abort();

async function* ndjson(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) yield JSON.parse(line);
    }
  }
  if (buf.trim()) yield JSON.parse(buf);
}

// ----------------------------------------------------------------- main ---
export async function askClaude(api, { scope, question, cwd }) {
  const askedAt = Date.now();
  const t = selectTargets(api, scope);
  if (!t.context.length) {
    api.setToast({ message: "The board is empty — draw something first.", duration: 3000 });
    return;
  }
  const hasFocus = t.focus.length > 0;
  const userContext = t.context.filter((e) => !isClaude(e));
  const anchor = boundsOf(hasFocus ? t.focus : userContext.length ? userContext : t.context);
  const [image, focusImage] = await Promise.all([
    snapshot(api, t.context, 2200),
    hasFocus ? snapshot(api, t.focus, 1600) : null,
  ]);
  const summary = summarize(t.context, new Set(t.focus.map((e) => e.id)));
  const prior = priorAnswers(live(api), anchor);
  // Labelled regions (R1…, C1…) so Claude can point at things with its ink.
  const regions = regionsFor(t.context);
  const marksImage = regions.length ? await snapshot(api, [...t.context, ...markElements(regions)], 2200) : null;
  const regionList = regions.map((r) => ({ id: r.id, kind: r.kind, label: r.label, focus: hasFocus && r.ids.some((i) => t.focus.some((f) => f.id === i)) }));
  const header = headerText(t.scope, question);

  const runId = rid();
  const controller = new AbortController();
  running.set(runId, { id: runId, scope: t.scope, startedAt: askedAt, status: "Sending…", controller });
  notify();

  // Placeholder card: reserves room for a typical answer and fills in live.
  const pendingGroup = rid();
  let placeholder = cardElements({ header, body: "Claude is looking at your drawing…", groupId: pendingGroup, pending: true });
  const pb = boundsOf(placeholder);
  const spot = findFreeSpot(pb.maxX - pb.minX, 400, anchor, live(api));
  placeholder = translate(placeholder, spot.x - pb.minX, spot.y - pb.minY);
  insert(api, placeholder, CaptureUpdateAction.NEVER);
  scrollIntoViewIfNeeded(api, placeholder);
  let placeholderIds = new Set(placeholder.map((e) => e.id));

  let shown = { status: "", answer: "" };
  let renderTimer = 0;
  const render = () => {
    renderTimer = 0;
    const body = shown.answer || shown.status || "Claude is looking at your drawing…";
    const head = shown.answer && shown.status ? `${header}  ·  ${shown.status}` : header;
    let next = cardElements({ header: head, body, groupId: pendingGroup, pending: true });
    const nb = boundsOf(next);
    next = translate(next, spot.x - nb.minX, spot.y - nb.minY);
    api.updateScene({
      elements: [...api.getSceneElementsIncludingDeleted().filter((e) => !placeholderIds.has(e.id)), ...next],
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    placeholderIds = new Set(next.map((e) => e.id));
  };
  const update = (patch) => {
    shown = { ...shown, ...patch };
    const r = running.get(runId);
    if (r) {
      r.status = shown.answer ? shown.status || "Writing…" : shown.status;
      notify();
    }
    if (!renderTimer) renderTimer = setTimeout(render, 150);
  };

  try {
    const res = await fetch("/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image, focusImage, marksImage, regions: regionList, summary, question, scope: t.scope, prior, cwd }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    let data = null;
    for await (const ev of ndjson(res)) {
      if (ev.type === "status") update({ status: ev.text });
      else if (ev.type === "context")
        update({ status: ev.ids.length ? `Using ${ev.ids.length} earlier answer${ev.ids.length > 1 ? "s" : ""}…` : "Answering…" });
      else if (ev.type === "delta") update({ answer: ev.answer, status: "" });
      else if (ev.type === "error") throw new Error(ev.error);
      else if (ev.type === "done") data = ev;
    }
    clearTimeout(renderTimer);
    if (!data) throw new Error("the connection closed before Claude finished");

    const groupId = rid();
    const meta = {
      question: question || "", scope: t.scope, askId: data.id, sessionId: data.sessionId, engine: data.engine || "claude", cwd: data.cwd,
      askedAt, contextIds: data.contextIds, followUpOf: data.followUpOf,
    };
    const cost = data.costUsd ? ` · $${data.costUsd.toFixed(2)}` : "";
    const used = data.contextIds?.length ? ` · ${data.contextIds.length} earlier` : "";
    let block = cardElements({
      header: `${data.engine === "codex" ? header.replace("✦ Claude", "✦ Codex (Claude out of budget)") : header}  (${(data.durationMs / 1000).toFixed(0)}s${cost}${used})`,
      body: data.answer || "(empty answer)",
      groupId,
      meta,
    });

    if (data.diagram) {
      try {
        const { elements: dEls, files } = await diagramElements(data.diagram);
        if (files) api.addFiles(Object.values(files));
        const cb = boundsOf(block);
        const db = boundsOf(dEls);
        const title = convertToExcalidrawElements([
          { type: "text", x: 0, y: 0, text: "Suggested diagram", fontSize: 14, fontFamily: FONT_FAMILY.Nunito, strokeColor: VIOLET },
        ]);
        const titled = translate(title, cb.minX - title[0].x, cb.maxY + 28);
        const placed = translate(dEls, cb.minX - db.minX, cb.maxY + 56 - db.minY);
        block = [
          ...block,
          ...[...titled, ...placed].map((e) => ({
            ...e,
            groupIds: [...(e.groupIds || []), groupId],
            customData: { claude: true, ...meta, role: "diagram" },
          })),
        ];
      } catch (e) {
        console.warn("mermaid conversion failed", e);
      }
    }

    removeById(api, placeholderIds);
    const b = boundsOf(block);
    const at = findFreeSpot(b.maxX - b.minX, b.maxY - b.minY, anchor, live(api));
    block = translate(block, at.x - b.minX, at.y - b.minY);

    // Claude's ink: marks on the content plus handwritten notes in free space.
    let ink = [];
    if (Array.isArray(data.ink) && data.ink.length) {
      const now = live(api);
      const sizes = t.context.filter((e) => e.type === "freedraw" && !isClaude(e)).map((e) => e.customData?.pen?.size ?? e.strokeWidth * 4.25).sort((a, b) => a - b);
      ink = renderInk({
        commands: data.ink,
        regions,
        elementsById: new Map(now.map((e) => [e.id, e])),
        userStrokeSize: sizes.length ? sizes[Math.floor(sizes.length / 2)] : 3,
        // match the user's writing size: typed text size, else the height of handwritten lines
        userFontSize: (() => {
          const fonts = t.context.filter((e) => e.type === "text" && !isClaude(e)).map((e) => e.fontSize).sort((a, b) => a - b);
          if (fonts.length) return fonts[Math.floor(fonts.length / 2)];
          const hw = regions.filter((r) => r.kind === "handwriting/sketch").map((r) => r.bounds.maxY - r.bounds.minY).filter((x) => x < 200).sort((a, b) => a - b);
          return hw.length ? hw[Math.floor(hw.length / 2)] * 0.55 : 20;
        })(),
        place: (wd, ht, near, extra) => findFreeSpot(wd, ht, near, [...now, ...block, ...extra], 28),
        groupId: rid(),
        meta: { askId: data.id, askedAt },
        seed: askedAt,
      });
    }
    insert(api, [...block, ...ink]);
    scrollIntoViewIfNeeded(api, block);
  } catch (e) {
    clearTimeout(renderTimer);
    removeById(api, placeholderIds);
    const aborted = controller.signal.aborted || e.message === "cancelled";
    api.setToast(
      aborted
        ? { message: "Cancelled.", duration: 2000 }
        : { message: `Claude failed: ${e.message.slice(0, 300)}`, closable: true, duration: 10000 },
    );
    if (!aborted) throw e;
  } finally {
    running.delete(runId);
    notify();
  }
}

// Debug hook (used by tests / devtools).
window.__wbDebug = { selectTargets, newInk };
