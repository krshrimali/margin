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
import { regionsFor, markElements, renderInk, applyEdits, INK_COLOR } from "./ink.js";

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

// ------------------------------------------------------------ diagrams ----
// Mermaid → Excalidraw conversion can overlap labels (subgraph titles, long
// edge labels). Try progressively simpler variants and keep the cleanest.

/** Remove subgraph wrappers so their members become ordinary nodes. */
function flattenSubgraphs(src) {
  return src
    .split("\n")
    .filter((l) => !/^\s*subgraph\b/i.test(l) && !/^\s*end\s*$/i.test(l) && !/^\s*direction\s+\w+\s*$/i.test(l))
    .join("\n");
}

/** Keep edge labels to a few words: |a long label| and -- a long label --> forms. */
function shortenEdgeLabels(src, max = 18) {
  const cut = (t) => {
    t = t.trim();
    if (t.length <= max) return t;
    const words = t.split(/\s+/);
    let out = "";
    for (const w of words) {
      if ((out + " " + w).trim().length > max) break;
      out = (out + " " + w).trim();
    }
    return out || t.slice(0, max);
  };
  return src.replace(/\|([^|]+)\|/g, (_, t) => `|${cut(t)}|`);
}

function setDirection(src, dir) {
  return /^\s*(flowchart|graph)\s+\w+/im.test(src) ? src.replace(/^(\s*(?:flowchart|graph))\s+\w+/im, `$1 ${dir}`) : src;
}

/** Count overlapping labels and partially overlapping shapes. 0 = clean. */
function overlapScore(els) {
  const box = (e) => ({ minX: e.x, minY: e.y, maxX: e.x + e.width, maxY: e.y + e.height });
  const inter = (a, b) => Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX)) * Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
  const area = (a) => (a.maxX - a.minX) * (a.maxY - a.minY);
  const texts = els.filter((e) => e.type === "text").map(box);
  const shapes = els.filter((e) => ["rectangle", "diamond", "ellipse"].includes(e.type)).map(box);
  let score = 0;
  for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) if (inter(texts[i], texts[j]) > 12) score += 2;
  for (let i = 0; i < shapes.length; i++)
    for (let j = i + 1; j < shapes.length; j++) {
      const o = inter(shapes[i], shapes[j]);
      const nested = o >= 0.98 * Math.min(area(shapes[i]), area(shapes[j]));
      if (o > 12 && !nested) score += 1;
    }
  // arrows crossing each other or running through labels
  const segs = els
    .filter((e) => e.type === "arrow" || e.type === "line")
    .map((e) => {
      const pts = e.points.map(([x, y]) => [e.x + x, e.y + y]);
      return pts.slice(1).map((p, i) => [pts[i], p]);
    });
  const cross = ([a, b], [c, d]) => {
    const den = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0]);
    if (Math.abs(den) < 1e-9) return false;
    const t = ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / den;
    const u = ((c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0])) / den;
    return t > 0.08 && t < 0.92 && u > 0.08 && u < 0.92; // ignore touching at endpoints
  };
  for (let i = 0; i < segs.length; i++)
    for (let j = i + 1; j < segs.length; j++)
      if (segs[i].some((s1) => segs[j].some((s2) => cross(s1, s2)))) score += 1;
  const hitsBox = ([a, b], r) => {
    for (let t = 0.1; t < 0.9; t += 0.1) {
      const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
      if (x > r.minX + 2 && x < r.maxX - 2 && y > r.minY + 2 && y < r.maxY - 2) return true;
    }
    return false;
  };
  const labelBoxes = els.filter((e) => e.type === "text" && !els.some((a) => a.type === "arrow" && a.id === e.containerId)).map(box);
  for (const arrow of segs) if (labelBoxes.some((r) => arrow.some((sg) => hitsBox(sg, r)))) score += 1;
  return score;
}

/**
 * Diagram text uses Excalidraw's default hand-drawn font. Set it on the skeletons (before
 * conversion, so text is measured in it) rather than relying on the default staying the same.
 */
const withExcalifont = (skeletons) =>
  skeletons.map((s) => {
    if (s.type === "text") return { ...s, fontFamily: FONT_FAMILY.Excalifont };
    if (s.label) return { ...s, label: { ...s.label, fontFamily: FONT_FAMILY.Excalifont } };
    return s;
  });

async function diagramElements(mermaid, { quick = false } = {}) {
  const { parseMermaidToExcalidraw } = await import("@excalidraw/mermaid-to-excalidraw");
  const src = mermaid.trim();
  const flat = shortenEdgeLabels(flattenSubgraphs(src));
  const variants = quick ? [src] : [src, shortenEdgeLabels(src), flat, setDirection(flat, "TD"), setDirection(flat, "LR")];
  let best = null;
  for (const v of [...new Set(variants)]) {
    try {
      const { elements, files } = await parseMermaidToExcalidraw(v, { themeVariables: { fontSize: "16px" } });
      const els = convertToExcalidrawElements(withExcalifont(elements), { regenerateIds: true });
      const score = overlapScore(els);
      if (!best || score < best.score) best = { elements: els, files, score, variant: v };
      if (score === 0) break;
    } catch (e) {
      console.warn("mermaid variant failed", e);
    }
  }
  if (!best) throw new Error("could not convert the diagram");
  return best;
}

// Suggested diagrams are drawn by hand in Claude's ink colour.
const inkStyle = (e) => (e.type === "text" ? { strokeColor: INK_COLOR } : { strokeColor: INK_COLOR, roughness: 1, backgroundColor: "transparent", fillStyle: "solid" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Draw Claude's ink the way a hand would: each stroke is traced out and each
 * note is written letter by letter. Temporary copies are animated (not saved,
 * not in undo history); the real ink is then added in one undoable step.
 */
async function animateInk(api, ink) {
  const isAnim = (e) => e.customData?.inkAnim;
  const put = (els) =>
    api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted().filter((e) => !isAnim(e)), ...els], captureUpdate: CaptureUpdateAction.NEVER });
  const anim = (el, patch, v) => ({
    ...el, ...patch, id: `anim-${el.id}`, version: v, versionNonce: Math.floor(Math.random() * 2 ** 31),
    customData: { ...el.customData, inkAnim: true, claudePending: true },
  });
  const done = [];
  let v = 1;
  try {
    for (const el of ink) {
      if (el.type === "freedraw") {
        const n = el.points.length;
        const steps = Math.min(16, Math.max(5, Math.round(n / 6)));
        for (let s = 1; s <= steps; s++) {
          const m = Math.max(2, Math.round((n * s) / steps));
          const pts = el.points.slice(0, m);
          const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
          put([...done, anim(el, {
            points: pts, pressures: el.pressures.length ? el.pressures.slice(0, m) : [], lastCommittedPoint: null,
            width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys),
          }, ++v)]);
          await sleep(16);
        }
      } else if (el.type === "text") {
        const full = el.text;
        const step = Math.max(1, Math.ceil(full.length / 45));
        for (let k = step; k < full.length + step; k += step) {
          const t = full.slice(0, k);
          put([...done, anim(el, { text: t, originalText: t }, ++v)]);
          await sleep(22);
        }
      }
      done.push(anim(el, {}, ++v));
    }
  } finally {
    api.updateScene({
      elements: [...api.getSceneElementsIncludingDeleted().filter((e) => !isAnim(e)), ...ink],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  }
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
// Text is wrapped by measuring it, so the card and ink fonts must be loaded first;
// otherwise lines are wrapped for a narrower fallback font and overflow the card.
const fontsReady = () =>
  Promise.all(["14px Nunito", "17px Nunito", "20px Excalifont", "16px Excalifont"].map((f) => document.fonts.load(f))).catch(() => {});

export async function askClaude(api, { scope, question, cwd }) {
  const askedAt = Date.now();
  await fontsReady();
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
  // Labelled regions (R1…, D1…, C1…) so Claude can point at things with its ink and edit them.
  const regions = regionsFor(t.context);
  const marksImage = regions.length ? await snapshot(api, [...t.context, ...markElements(regions)], 2200) : null;
  const regionList = regions.map((r) => ({ id: r.id, kind: r.kind, label: r.label, style: r.style, focus: hasFocus && r.ids.some((i) => t.focus.some((f) => f.id === i)) }));
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
  // The diagram is redrawn under the card every time another line streams in.
  let partialIds = new Set();
  let diagramBusy = false;
  let diagramNext = null;
  const drawPartialDiagram = async (src) => {
    if (diagramBusy) {
      diagramNext = src;
      return;
    }
    diagramBusy = true;
    try {
      const { elements: dEls, files } = await diagramElements(src, { quick: true });
      if (files) api.addFiles(Object.values(files));
      const card = api.getSceneElements().filter((e) => placeholderIds.has(e.id));
      const cb = card.length ? boundsOf(card) : { minX: spot.x, maxY: spot.y + 200 };
      const db = boundsOf(dEls);
      const placed = translate(dEls, cb.minX - db.minX, cb.maxY + 48 - db.minY).map((e) => ({
        ...e, ...inkStyle(e), customData: { claudePending: true, role: "diagram" },
      }));
      api.updateScene({
        elements: [...api.getSceneElementsIncludingDeleted().filter((e) => !partialIds.has(e.id)), ...placed],
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      partialIds = new Set(placed.map((e) => e.id));
    } catch {
      // a half-written diagram may not parse yet; keep the last good one
    } finally {
      diagramBusy = false;
      if (diagramNext) {
        const n = diagramNext;
        diagramNext = null;
        drawPartialDiagram(n);
      }
    }
  };
  const settleDiagram = async () => {
    diagramNext = null;
    while (diagramBusy) await sleep(20);
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
      else if (ev.type === "diagram") {
        if (!partialIds.size) update({ status: "Drawing the diagram…" });
        drawPartialDiagram(ev.mermaid);
      }
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
            ...(e === titled[0] ? {} : inkStyle(e)),
          })),
        ];
      } catch (e) {
        console.warn("mermaid conversion failed", e);
      }
    }

    await settleDiagram();
    removeById(api, new Set([...placeholderIds, ...partialIds]));
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
        writeAnchor: boundsOf(block.filter((e) => e.customData?.role === "bg")),
      });
    }
    insert(api, block);
    scrollIntoViewIfNeeded(api, block);

    // Edits to existing content (recolour, retype, remove), applied as one undoable step.
    if (Array.isArray(data.edits) && data.edits.length) {
      const { changed, done, skipped } = applyEdits({
        commands: data.edits,
        regions,
        elementsById: new Map(live(api).map((e) => [e.id, e])),
      });
      if (skipped.length) console.warn("some edits were skipped:", skipped);
      if (changed.size) {
        api.updateScene({
          elements: api.getSceneElementsIncludingDeleted().map((e) => changed.get(e.id) || e),
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
        api.setToast({
          message: `Claude edited ${done} part${done === 1 ? "" : "s"} of the board${skipped.length ? ` (${skipped.length} skipped)` : ""}. Ctrl+Z undoes it.`,
          duration: 5000,
        });
      }
    }
    if (ink.length) await animateInk(api, ink);
  } catch (e) {
    clearTimeout(renderTimer);
    await settleDiagram();
    removeById(api, new Set([...placeholderIds, ...partialIds]));
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
