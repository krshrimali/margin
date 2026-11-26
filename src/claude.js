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
import { REQUEST_BYTES } from "./limits.js";
import { regionsFor, markElements, renderInk, applyEdits, describeEdits } from "./ink.js";
import { buildDrawing, outlineSkeletons, wrapText } from "./draw.js";
import { startWalkthrough } from "./steps.js";

export const SCOPES = {
  auto: "Auto",
  selection: "Selection",
  viewport: "Visible page",
  board: "Whole board",
};
export const SCOPE_HINTS = {
  auto: "Picks for you: your picked items or selection; otherwise what you wrote since Claude's last answer, plus anything it points at and what's around it. Asking about \"the whole board\" or \"everything\" widens it to the board.",
  selection: "Only the selected elements.",
  viewport: "Everything currently on screen.",
  board: "The entire board.",
};

// Per-answer model and effort. "" = Claude Code's default.
export const MODELS = [
  ["", "Default"],
  ["opus", "Opus"],
  ["sonnet", "Sonnet"],
  ["haiku", "Haiku"],
  ["fable", "Fable"],
];
export const EFFORTS = [
  ["", "Default"],
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
  ["xhigh", "Extra high"],
  ["max", "Max"],
];
export const EDIT_MODES = {
  auto: ["Auto", "Claude edits your content when your request asks for a change (\"make it colourful\", \"rename X\"). Reviews and questions never change it."],
  ask: ["Ask first", "Claude proposes edits; you preview, then apply or discard them."],
  off: ["Off", "Claude never changes existing content. It marks it up with ink instead."],
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
  if (el.customData.contextText) return el.customData.contextText;
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

/** Split elements into clusters of nearby things (each picked area becomes its own focus image). */
function clusters(els, gap = 360) {
  const items = els.map((e) => ({ e, b: boundsOf([e]) }));
  const parent = items.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++) if (rectDist(items[i].b, items[j].b) < gap) parent[find(i)] = find(j);
  const groups = new Map();
  items.forEach((it, i) => groups.set(find(i), [...(groups.get(find(i)) || []), it.e]));
  return [...groups.values()].sort((a, b) => boundsOf(a).minY - boundsOf(b).minY || boundsOf(a).minX - boundsOf(b).minX);
}

/** What new ink points at: existing content its strokes touch (an arrow's tip, a circle around a word). */
function touchedBy(fresh, all) {
  const freshIds = new Set(fresh.map((e) => e.id));
  const out = new Map();
  for (const f of fresh) {
    if (f.type !== "freedraw" && f.type !== "arrow" && f.type !== "line") continue;
    const fb = boundsOf([f]);
    const area = Math.max(1, (fb.maxX - fb.minX) * (fb.maxY - fb.minY));
    for (const e of elementsOverlappingBBox({ elements: all, bounds: grow(fb, 12), type: "overlap" })) {
      if (freshIds.has(e.id) || e.type === "frame" || e.type === "magicframe" || isPending(e)) continue;
      const eb = boundsOf([e]);
      // skip big backgrounds the stroke merely sits on
      if ((eb.maxX - eb.minX) * (eb.maxY - eb.minY) > area * 12 && !isClaude(e)) continue;
      out.set(e.id, e);
    }
  }
  return [...out.values()];
}

const WHOLE_BOARD_RE = /\b(whole|entire|full) (board|page|canvas)\b|\beverything\b|\ball (of )?(the |my )?(boxes|shapes|notes|cards|text|diagrams|things|content)\b|\b(summar(y|ise|ize)|overview of) (this|the|my) (board|page)\b|\bacross the board\b/i;

/**
 * Returns { scope, context, focus, focusGroups }:
 *   context     – what goes in the overview snapshot
 *   focus       – what Claude should respond to (picked items, selection or new ink); may be empty
 *   focusGroups – focus split into clusters, one focus image each (picked items can be far apart)
 */
function selectTargets(api, scope, { picks = [], question = "", threadIds = null, excludeAsk = null } = {}) {
  // a regenerate leaves the answer it replaces out of everything Claude sees
  const all = live(api).filter((e) => !isPending(e) && !(excludeAsk && e.customData?.askId === excludeAsk));
  const appState = api.getAppState();
  const selected = all.filter((e) => appState.selectedElementIds?.[e.id]);
  const visible = () => elementsOverlappingBBox({ elements: all, bounds: getVisibleSceneBounds(appState), type: "overlap" });
  const fresh = newInk(all);
  const around = (focus, margin = CONTEXT_MARGIN) =>
    clusters(focus).flatMap((c) => elementsOverlappingBBox({ elements: all, bounds: grow(boundsOf(c), margin), type: "overlap" }));
  const result = (sc, focus, margin) => {
    const groups = clusters(focus);
    return { scope: sc, focus, focusGroups: groups, context: expand([...focus, ...around(focus, groups.length > 1 ? 380 : margin)], all) };
  };

  // a comment thread: the commented elements (and the thread's own picks)
  if (threadIds) {
    const ids = new Set(threadIds);
    const focus = expand(all.filter((e) => ids.has(e.id)), all);
    if (focus.length) return result("comment", focus);
  }
  // items picked from anywhere on the board (the context tray)
  const pickedIds = new Set(picks);
  const picked = all.filter((e) => pickedIds.has(e.id));
  if ((scope === "auto" || scope === "picks") && picked.length) {
    const focus = expand([...picked, ...(scope === "auto" ? selected : [])], all);
    return result("picks", focus);
  }
  if (scope === "auto" && WHOLE_BOARD_RE.test(question || "") && !selected.length) {
    return { scope: "board", focus: [], focusGroups: [], context: expand(all, all) };
  }
  if ((scope === "auto" || scope === "selection") && selected.length) {
    return result("selection", expand(selected, all));
  }
  if (scope === "auto" && fresh.length) {
    const mine = expand(fresh, all).filter((e) => !isClaude(e));
    const focus = expand([...mine, ...touchedBy(mine, all)], all);
    return result("new", focus);
  }
  let context = scope === "board" ? all : visible();
  if (!context.length) context = all;
  context = expand(context, all);
  const ids = new Set(context.map((e) => e.id));
  const focus = fresh.filter((e) => ids.has(e.id));
  const f = focus.length < context.filter((e) => !isClaude(e)).length ? focus : [];
  return { scope: scope === "board" ? "board" : "viewport", focus: f, focusGroups: f.length ? [f] : [], context };
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
export function findFreeSpot(w, h, anchor, obstacles, GAP = 48, { nearest = false } = {}) {
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
    // nearest: rank by the gap between the spot and the anchor (any side), for notes that label a mark;
    // otherwise by distance from the anchor's top-right corner, which favours reading order for cards
    const cost = nearest
      ? Math.hypot(Math.max(0, ax - (x + w), x - bx), Math.max(0, ay - (y + h), y - by)) + pen * 0.5
      : Math.hypot(x - bx, y - ay) + pen;
    if ((!best || cost < best.cost) && free(x, y)) best = { x, y, cost };
  }
  if (best) return best;
  const all = rects.length ? rects.reduce((a, r) => ({ maxX: Math.max(a.maxX, r.maxX), minY: Math.min(a.minY, r.minY) })) : { maxX: 0, minY: 0 };
  return { x: all.maxX + GAP * 2, y: all.minY };
}

const translate = (els, dx, dy) => els.map((e) => ({ ...e, x: e.x + dx, y: e.y + dy }));

// --------------------------------------------------------- answer cards ---
const SCOPE_TITLES = { selection: "Selection", new: "New ink", viewport: "Visible page", board: "Whole board", picks: "Picked items", comment: "Comment" };

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
// edge labels). Compare reading directions using the complete lesson footprint.

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

// Mermaid node shapes the converter draws as plain rectangles, and the outline we give them instead.
const MERMAID_SHAPES = [
  [/^\[\(/, "cylinder"],
  [/^\{\{/, "hexagon"],
  [/^\[\[/, "subroutine"],
  [/^\[\/.*\\\]$/, "trapezoid"],
  [/^\[[\/\\]/, "parallelogram"],
  [/^>/, "callout"],
];
function mermaidNodeShapes(src) {
  if (!/^\s*(flowchart|graph)\b/im.test(src)) return new Map();
  const shapes = new Map();
  const re = /(?:^|[\s;&>-])([A-Za-z][\w]*)\s*(\[\(|\{\{|\[\[|\[\/|\[\\|>)([^\n]*?)(\)\]|\}\}|\]\]|\/\]|\\\]|\])/g;
  for (const line of src.split("\n")) {
    for (const m of line.matchAll(re)) {
      const token = m[2] + m[3] + m[4];
      const hit = MERMAID_SHAPES.find(([r]) => r.test(token));
      if (hit && !shapes.has(m[1])) shapes.set(m[1], hit[1]);
    }
  }
  return shapes;
}

/** Does the diagram set its own colours? Then keep them instead of redrawing it in ink. */
const isStyled = (src) => /^\s*(classDef|style)\b[^\n]*\b(fill|stroke|color)\s*:\s*#/im.test(src);

/** Swap plain rectangles for the shape the Mermaid source asked for (cylinder, hexagon…). */
function decorateShapes(skeletons, shapes) {
  if (!shapes.size) return skeletons;
  const out = [];
  for (const s of skeletons) {
    const nodeId = s.type === "rectangle" && s.id ? [...shapes.keys()].find((k) => s.id === k || new RegExp(`^flowchart-${k}-\\d+$`).test(s.id)) : null;
    if (!nodeId) {
      out.push(s);
      continue;
    }
    const shape = shapes.get(nodeId);
    const groupIds = [...(s.groupIds || []), `shape-${s.id}`];
    const style = {
      strokeColor: s.strokeColor || "#1e1e1e", backgroundColor: s.backgroundColor || "transparent", fillStyle: "solid",
      strokeWidth: s.strokeWidth || 2, strokeStyle: s.strokeStyle || "solid", roughness: 1, groupIds,
    };
    let { x, y, width: w, height: h } = s;
    if (shape === "cylinder") { y -= 16; h += 20; }
    out.push(...outlineSkeletons(shape, x, y, w, h, style));
    // the label would inherit the (now transparent) stroke colour, so give it its own
    const label = s.label ? { ...s.label, strokeColor: s.label.strokeColor || "#1e1e1e" } : s.label;
    out.push({ ...s, label, strokeColor: "transparent", backgroundColor: "transparent", groupIds, roundness: null });
  }
  return out;
}

function flowContents(skeletons) {
  const titles = new Set(skeletons.filter((e) => e.id?.endsWith("__title")).map((e) => e.id.slice(0, -7)));
  const nodes = skeletons.filter((e) => ["rectangle", "diamond", "ellipse"].includes(e.type) && e.id);
  const groups = nodes.filter((e) => titles.has(e.id)).map((g) => {
    const members = nodes.filter((n) => n !== g && n.x >= g.x - 1 && n.y >= g.y - 1 &&
      n.x + n.width <= g.x + g.width + 1 && n.y + n.height <= g.y + g.height + 1);
    return [g.id, members.map((n) => n.id).sort()];
  });
  const relations = skeletons.filter((e) => e.type === "arrow").map((e) => [e.start?.id, e.end?.id, e.label?.text || ""]);
  const labels = skeletons.map((e) => e.label?.text || e.text).filter(Boolean).sort();
  return JSON.stringify([groups.sort(), relations.sort(), labels]);
}

async function diagramElements(mermaid, { width = 1000, height = 700 } = {}, lesson) {
  const { parseMermaidToExcalidraw } = await import("@excalidraw/mermaid-to-excalidraw");
  const src = mermaid.trim();
  const variants = [src, setDirection(src, "TD"), setDirection(src, "LR")];
  const shapes = mermaidNodeShapes(src);
  let best = null, originalContents;
  for (const v of [...new Set(variants)]) {
    try {
      const { elements, files } = await parseMermaidToExcalidraw(v, { themeVariables: { fontSize: "16px" } });
      if (/^\s*(flowchart|graph)\s+/im.test(src)) {
        const contents = flowContents(elements);
        originalContents ??= contents;
        if (contents !== originalContents) continue;
      }
      const els = convertToExcalidrawElements(decorateShapes(withExcalifont(elements), shapes), { regenerateIds: true });
      if (!validVisual(els)) continue;
      const b = boundsOf(lesson ? composeVisual(els, lesson).elements : els);
      const fit = Math.min(1, Math.max(1, width - 96) / Math.max(1, b.maxX - b.minX),
        Math.max(1, height - 160) / Math.max(1, b.maxY - b.minY));
      const overlaps = overlapScore(els.filter((e) => e.type !== "line" || e.customData));
      const score = overlaps * 10 + Math.max(0, 1 - fit) * 8 + (v === src ? 0 : 0.1);
      if (!best || score < best.score) best = { elements: els, files, score };
      if (score === 0) break;
    } catch (e) {
      console.warn("mermaid variant failed", e);
    }
  }
  if (!best) throw new Error("could not convert the diagram");
  return { ...best, styled: isStyled(src) };
}

function validVisual(elements) {
  return elements.length > 0 && new Set(elements.map((e) => e.id)).size === elements.length &&
    elements.every((e) => [e.x, e.y, e.width, e.height].every(Number.isFinite));
}

function composeVisual(visual, { title, caption, hasTitle, viewportWidth = window.innerWidth }) {
  const b = boundsOf(visual);
  const labels = [];
  if (!hasTitle) {
    const [heading] = convertToExcalidrawElements([
      { type: "text", x: b.minX, y: b.minY, text: wrapText(title, Math.max(12, Math.min(60, Math.floor((viewportWidth - 64) / 17)))), fontSize: 30, fontFamily: FONT_FAMILY.Excalifont, strokeColor: "#1e1e1e" },
    ]);
    labels.push({ ...heading, y: b.minY - heading.height - 28 });
  }
  const width = Math.min(Math.max(200, viewportWidth - 64), Math.max(320, Math.min(720, b.maxX - b.minX)));
  const footer = caption && convertToExcalidrawElements([{
    type: "rectangle", x: b.minX, y: b.maxY + 22, width, height: 36, strokeColor: "transparent",
    backgroundColor: "transparent", roughness: 0,
    label: { text: caption, fontSize: 17, fontFamily: FONT_FAMILY.Nunito, textAlign: "left", verticalAlign: "top", strokeColor: "#495057" },
  }]);
  return { elements: [...labels, ...visual, ...(footer || [])], headingIds: labels.map((e) => e.id), captionIds: (footer || []).map((e) => e.id) };
}

function styleDiagram(e, styled) {
  if (styled) return e.type === "text" ? {} : { roughness: 1 };
  if (e.type === "text") return { strokeColor: "#343a40" };
  return {
    strokeColor: e.strokeColor === "transparent" ? "transparent" : e.type === "diamond" ? "#6741d9" : "#495057",
    backgroundColor: e.type === "diamond" ? "#f3efff" : "transparent",
    roughness: 1, fillStyle: "solid",
  };
}

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
  if (!visible) api.scrollToContent(els, { animate: !matchMedia("(prefers-reduced-motion: reduce)").matches, fitToViewport: false });
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
export const showDrawing = (id) => { const run = running.get(id); if (run) run.skipAnimation = true; };
export const cancelAsk = (id) => running.get(id)?.controller.abort();

// ------------------------------------------------------ edit proposals ---
// With edits on "Ask first", Claude's edits wait here until the user applies or discards them.
const proposals = new Map();
const proposalListeners = new Set();
const notifyProposals = () => proposalListeners.forEach((l) => l([...proposals.values()]));
export const onProposalsChange = (fn) => {
  proposalListeners.add(fn);
  fn([...proposals.values()]);
  return () => proposalListeners.delete(fn);
};

/** Apply a set of edit results to the scene (changed elements + newly added ones). */
function commitEdits(api, { changed, added = [] }, capture) {
  api.updateScene({
    elements: [...api.getSceneElementsIncludingDeleted().map((e) => changed.get(e.id) || e), ...added],
    captureUpdate: capture,
  });
}

const pendingIdx = (p) => p.state.map((s, i) => (s === "pending" ? i : -1)).filter((i) => i >= 0);
export const savedProposals = () => [...proposals.values()].map(({ preview, ...p }) => p);
export function restoreProposals(saved = []) {
  proposals.clear();
  for (const p of saved || []) if (p?.id && Array.isArray(p.commands) && Array.isArray(p.state)) proposals.set(p.id, p);
  notifyProposals();
}
function computeEdits(api, p, indices = pendingIdx(p)) {
  return applyEdits({ commands: indices.map((i) => p.commands[i]), regions: p.regions,
    aliases: p.aliases, elementsById: new Map(live(api).map((e) => [e.id, e])) });
}

export function previewProposal(api, id, on) {
  const p = proposals.get(id);
  if (!p) return;
  proposals.set(id, { ...p, preview: on });
  notifyProposals();
}
export async function proposalImage(api, p) {
  const { changed, added } = computeEdits(api, p);
  const targets = new Set(proposalTargets(api, p.id).map((e) => e.id));
  const elements = [...live(api).filter((e) => targets.has(e.id) || changed.has(e.id)).map((e) => changed.get(e.id) || e), ...added].filter((e) => !e.isDeleted);
  if (!elements.length) return null;
  return exportToBlob({ elements, files: api.getFiles(), appState: { exportBackground: true, viewBackgroundColor: "#ffffff" }, mimeType: "image/png", maxWidthOrHeight: 1000 });
}
export function blockedEdit(p, i) {
  const c = p.commands[i];
  const refs = [c.from, c.to, c.near, c.target, ...(c.targets || []), ...(c.between || [])];
  return p.commands.slice(0, i).some((prior, j) => prior.id && refs.includes(prior.id) && p.state[j] !== "accepted");
}

/**
 * Accept or reject some of a proposal's edits (all pending ones when `indices` is omitted).
 * Accepted edits are applied as one undo step; the proposal goes away when nothing is pending.
 */
export function resolveProposal(api, id, accept, indices = null) {
  const p = proposals.get(id);
  if (!p) return;
  previewProposal(api, id, false);
  const idx = (indices || pendingIdx(p)).filter((i) => p.state[i] === "pending");
  const state = [...p.state];
  if (accept && idx.length) {
    if (indices && idx.some((i) => blockedEdit(p, i))) return;
    const res = computeEdits(api, p, idx);
    p.aliases = res.aliases;
    idx.forEach((i, j) => { state[i] = res.outcomes[j]; });
    if (res.changed.size || res.added.length) {
      commitEdits(api, res, CaptureUpdateAction.IMMEDIATELY);
      api.setToast({ message: `Applied ${res.done} edit${res.done === 1 ? "" : "s"}${res.skipped.length ? ` (${res.skipped.length} skipped)` : ""}. Ctrl+Z undoes it.`, duration: 3500 });
    } else api.setToast({ message: "Nothing to change: those parts of the board are gone.", duration: 3000 });
  }
  if (!accept) idx.forEach((i) => { state[i] = "rejected"; });
  if (state.some((s) => s === "skipped" || s === "partial")) api.setToast({ message: "Some suggested edits could not be fully applied.", duration: 4000 });
  const next = { ...p, state, preview: false };
  const reviewFailures = accept && state.some((s) => s === "skipped" || s === "partial");
  if (!reviewFailures && state.every((s) => s !== "pending")) proposals.delete(id);
  else proposals.set(id, next);
  notifyProposals();
}
export const applyProposal = (api, id) => resolveProposal(api, id, true);
export const discardProposal = (api, id) => resolveProposal(api, id, false);

/** Bounds of the elements a proposal touches, to scroll to them. */
export function proposalTargets(api, id) {
  const p = proposals.get(id);
  if (!p) return [];
  const ids = new Set(p.regions.filter((r) => p.targets.includes(r.id)).flatMap((r) => r.ids));
  return live(api).filter((e) => ids.has(e.id));
}

// ------------------------------------------------------------ network ---
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

// ---------------------------------------------------------- animation ---
const bump = (e, patch) => ({ ...e, ...patch, version: (e.version || 1) + 1, versionNonce: Math.floor(Math.random() * 2 ** 31) });

/** One frame of an element being drawn: lines grow from their start, everything else fades in. */
function frameOf(e, t) {
  if ((e.type === "line" || e.type === "arrow") && e.points?.length >= 2) {
    const pts = e.points;
    const total = pts.slice(1).reduce((a, p, i) => a + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0) || 1;
    let left = total * t;
    const out = [pts[0]];
    for (let i = 1; i < pts.length && left > 0; i++) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      const seg = Math.hypot(x1 - x0, y1 - y0) || 1;
      const k = Math.min(1, left / seg);
      out.push([x0 + (x1 - x0) * k, y0 + (y1 - y0) * k]);
      left -= seg;
    }
    if (out.length < 2) out.push(pts[0]);
    return bump(e, { points: out, endArrowhead: t < 0.98 ? null : e.endArrowhead, opacity: e.opacity });
  }
  return bump(e, { opacity: Math.round((e.opacity ?? 100) * Math.min(1, 0.15 + t)) });
}

/**
 * Animate temporary (pending) elements in place: each step's lines are drawn
 * out and its shapes fade in, one step after another. The caller commits the
 * real elements afterwards.
 */
async function animateSteps(api, els, steps, { signal, skip, frames = 5, delay = 16 } = {}) {
  const byId = new Map(els.map((e) => [e.id, e]));
  const shown = new Set();
  const ids = new Set(els.map((e) => e.id));
  const put = (extra) =>
    api.updateScene({
      elements: [...api.getSceneElementsIncludingDeleted().filter((e) => !ids.has(e.id)), ...els.filter((e) => shown.has(e.id)), ...extra],
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  for (const step of steps) {
    const stepEls = step.map((id) => byId.get(id)).filter(Boolean);
    if (!stepEls.length) continue;
    for (let f = 1; f <= frames; f++) {
      if (signal?.aborted || skip?.()) return;
      put(stepEls.map((e) => frameOf(e, f / frames)));
      await sleep(delay);
    }
    step.forEach((id) => shown.add(id));
  }
  put([]);
}

// ----------------------------------------------------------------- main ---
// Text is wrapped by measuring it, so the card and ink fonts must be loaded first;
// otherwise lines are wrapped for a narrower fallback font and overflow the card.
const fontsReady = () =>
  Promise.allSettled(["17px Nunito", "20px Excalifont", "18px Cascadia"].map((f) => document.fonts.load(f)));

const MODEL_NAMES = Object.fromEntries(MODELS.filter(([k]) => k));
const shortModel = (m) => {
  if (!m) return "";
  const s = String(m).replace(/^claude-/, "").replace(/-\d{8}$/, "").replace(/\[.*\]$/, "");
  return MODEL_NAMES[s] || s.replace(/-(\d+)-(\d+)$/, " $1.$2").replace(/^\w/, (c) => c.toUpperCase());
};

/**
 * Ask Claude about part of the board.
 *   scope     auto | selection | viewport | board | picks
 *   picks     element ids picked from anywhere on the board (context tray)
 *   model, effort   per-answer overrides ("" = Claude Code's default)
 *   editMode  auto | ask | off
 *   thread    a comment thread { id, elementIds, messages, sessionId, engine, cwd }: the reply goes
 *             to `reply` callbacks instead of a card; drawings, ink and edits still land on the board.
 */
export async function askClaude(api, {
  scope = "auto", question = "", cwd, model = "", effort = "", editMode = "auto", picks = [], thread = null, reply = null,
  attachments = [], links = [], steps = false, maxBudget = 0, projectAccess = false, excludeAsk = null, replayId = null, legacyReplayId = null,
}) {
  const askedAt = Date.now();
  await fontsReady();
  const t = selectTargets(api, thread ? "viewport" : scope, { picks, question, threadIds: thread?.elementIds, excludeAsk });
  const blank = !t.context.length;
  if (blank && (thread || !(question.trim() || replayId || attachments.length || links.length))) {
    const message = "The board is empty. Type a question or draw something first.";
    if (thread) reply?.error(message);
    else api.setToast({ message, duration: 3000 });
    return;
  }
  const hasFocus = t.focus.length > 0;
  const userContext = t.context.filter((e) => !isClaude(e));
  const view = getVisibleSceneBounds(api.getAppState());
  const [cx, cy] = [(view[0] + view[2]) / 2, (view[1] + view[3]) / 2];
  const anchor = blank ? { minX: cx, maxX: cx, minY: cy, maxY: cy }
    : boundsOf(hasFocus ? t.focus : userContext.length ? userContext : t.context);
  const groups = (t.focusGroups?.length ? t.focusGroups : hasFocus ? [t.focus] : []).slice(0, 5);
  const [image, ...focusImages] = await Promise.all([
    blank ? document.createElement("canvas").toDataURL("image/png") : snapshot(api, t.context, 2200),
    ...groups.map((g) => snapshot(api, g, groups.length > 1 ? 1200 : 1600)),
  ]);
  const summary = summarize(t.context, new Set(t.focus.map((e) => e.id)));
  const prior = priorAnswers(live(api), anchor).filter((p) => !excludeAsk || p.id !== excludeAsk);
  // Labelled regions (R1…, D1…, C1…) so Claude can point at things with its ink and edit them.
  const regions = regionsFor(t.context);
  const marksImage = regions.length ? await snapshot(api, [...t.context, ...markElements(regions)], 2200) : null;
  const focusIds = new Set(t.focus.map((e) => e.id));
  const regionList = regions.map((r) => ({ id: r.id, kind: r.kind, label: r.label, style: r.style, focus: hasFocus && r.ids.some((i) => focusIds.has(i)) }));
  const header = headerText(t.scope, question);
  const choice = [shortModel(model), effort && EFFORTS.find(([k]) => k === effort)?.[1].toLowerCase() + " effort"].filter(Boolean).join(" · ");

  const runId = rid();
  const controller = new AbortController();
  running.set(runId, { id: runId, scope: t.scope, startedAt: askedAt, status: "Sending…", controller, label: thread ? "Comment" : null, choice, maxBudget, model: shortModel(model) });
  notify();

  // ---- where things go: a placeholder card (answers) or straight into the thread (comments)
  const pendingGroup = rid();
  let placeholderIds = new Set();
  let pendingVisualIds = new Set();
  let spot = null;
  if (!thread) {
    let placeholder = cardElements({ header, body: "Claude is looking at your drawing…", groupId: pendingGroup, pending: true });
    const pb = boundsOf(placeholder);
    spot = findFreeSpot(pb.maxX - pb.minX, 400, anchor, live(api));
    placeholder = translate(placeholder, spot.x - pb.minX, spot.y - pb.minY);
    insert(api, placeholder, CaptureUpdateAction.NEVER);
    scrollIntoViewIfNeeded(api, placeholder);
    placeholderIds = new Set(placeholder.map((e) => e.id));
  }

  let shown = { status: "", answer: "" };
  let drawing = false;
  let renderTimer = 0;
  const render = () => {
    renderTimer = 0;
    if (thread || drawing) return;
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
    if (thread) {
      if (patch.answer !== undefined) reply?.delta(shown.answer);
      if (patch.status) reply?.status(patch.status);
    }
    if (!renderTimer) renderTimer = setTimeout(render, 150);
  };

  try {
    const body = JSON.stringify({
        replayId, legacyReplayId, projectAccess, image, focusImage: focusImages[0] || null, extraFocusImages: focusImages.slice(1), marksImage, regions: regionList, summary, question,
        scope: t.scope, prior, cwd, model, effort, editMode, attachments, links, steps, maxBudget,
        thread: thread ? { messages: thread.messages, sessionId: thread.sessionId || null, engine: thread.engine || null, cwd: thread.cwd || null } : null,
      });
    if (new Blob([body]).size > REQUEST_BYTES) throw new Error("Board images and files exceed the 60 MiB request limit. Select a smaller region or remove an attachment.");
    const res = await fetch("/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
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
        update({ status: ev.ids.length ? `Using ${ev.ids.length} earlier answer${ev.ids.length > 1 ? "s" : ""}…` : thread ? "Replying…" : "Answering…" });
      else if (ev.type === "delta") update({ answer: ev.answer, status: "" });
      else if (ev.type === "usage") {
        const r = running.get(runId);
        if (r) {
          r.tokens = { input: ev.input, output: ev.output };
          notify();
        }
        reply?.usage?.(ev);
      }
      else if (ev.type === "diagram" || ev.type === "draw") {
        if (!drawing) {
          drawing = true;
          removeById(api, placeholderIds);
          update({ status: "Preparing drawing…" });
        }
      } else if (ev.type === "error") throw new Error(ev.error);
      else if (ev.type === "done") data = ev;
    }
    clearTimeout(renderTimer);
    if (!data) throw new Error("the connection closed before Claude finished");

    const groupId = rid();
    const modelLabel = shortModel(data.modelUsed || data.model);
    const meta = {
      question: question || "", scope: t.scope, askId: data.id, sessionId: data.sessionId, engine: data.engine || "claude", cwd: data.cwd,
      askedAt, contextIds: data.contextIds, followUpOf: data.followUpOf, model: data.model || "", effort: data.effort || "",
      modelLabel, durationMs: data.durationMs, costUsd: data.costUsd,
      inputRef: data.inputRef || null, replayFocus: t.focus.map((e) => e.id), walkthrough: steps,
      focusIds: t.focus.filter((e) => !isClaude(e)).slice(0, 300).map((e) => e.id),
      ...(thread ? { threadId: thread.id } : {}),
    };
    const cost = data.costUsd ? ` · $${data.costUsd.toFixed(2)}` : "";
    const used = data.contextIds?.length ? ` · ${data.contextIds.length} earlier` : "";
    const who = [modelLabel, data.effort].filter(Boolean).join(" ");
    let block = [];
    let animation = [];
    let visual = [];
    let narration = [];
    if (data.draw?.length || data.diagram) {
      update({ status: "Verifying drawing layout…" });
      // Let the status paint before Excalidraw measures and lays out text.
      await sleep(32);
      try {
        const drawTitle = data.draw?.find((i) => !i.shape && i.title)?.title;
        const mermaidTitle = data.diagram?.match(/^%%\s*title:\s*(.+)$/im)?.[1];
        const title = drawTitle || mermaidTitle || question.trim().split("\n")[0].slice(0, 84) || "Diagram";
        let steps, stepOf;
        if (data.draw?.length) {
          ({ elements: visual, steps, stepOf, narration = [] } = buildDrawing(data.draw, { prefix: `d${rid()}`, viewportWidth: api.getAppState().width }));
        } else {
          const { elements, files, styled } = await diagramElements(data.diagram, api.getAppState(), { title, caption: thread ? "" : data.answer });
          if (files) api.addFiles(Object.values(files));
          visual = elements.map((e) => ({ ...e, ...styleDiagram(e, styled) }));
          const arrows = new Set(visual.filter((e) => e.type === "arrow").map((e) => e.id));
          const isEdge = (e) => arrows.has(e.id) || arrows.has(e.containerId);
          steps = [visual.filter((e) => !isEdge(e)).map((e) => e.id), visual.filter(isEdge).map((e) => e.id)];
        }
        if (!validVisual(visual)) throw new Error("Drawing has no usable elements");
        const caption = thread || data.answer?.trim() === title ? "" : data.answer;
        const composition = composeVisual(visual, { title, caption, hasTitle: !!drawTitle });
        if (!validVisual(composition.elements)) throw new Error("Drawing has invalid geometry");
        const captionIds = new Set(composition.captionIds);
        block = composition.elements.map((e, i) => ({
          ...e,
          groupIds: [...(e.groupIds || []), groupId],
          customData: {
            claude: true, ...meta, role: captionIds.has(e.id) ? e.type === "text" ? "text" : "holder" : "diagram",
            visualReply: true, ...(i === 0 && !caption ? { contextText: title } : {}),
            ...(narration.length ? { step: stepOf?.[e.id] || 0, ...(i === 0 ? { narration } : {}) } : {}),
          },
        }));
        animation = [composition.headingIds, ...steps, composition.captionIds].filter((ids) => ids.length);
      } catch (e) {
        visual = [];
        narration = [];
        console.warn("drawing verification failed", e);
        api.setToast({ message: `Drawing unavailable: ${e.message}`, duration: 4000 });
      }
    }
    if (!block.length && !thread) {
      block = cardElements({
        header: `${data.engine === "codex" ? header.replace("✦ Claude", "✦ Codex (Claude out of budget)") : header}  (${(data.durationMs / 1000).toFixed(0)}s${cost}${used}${who ? ` · ${who}` : ""})`,
        body: data.answer || "(empty answer)",
        groupId,
        meta,
      });
    }

    clearTimeout(renderTimer);
    removeById(api, placeholderIds);
    if (block.length) {
      const b = boundsOf(block);
      const obstacles = live(api);
      const w = b.maxX - b.minX, h = b.maxY - b.minY;
      const at = blank && !obstacles.length ? { x: cx - w / 2, y: cy - h / 2 }
        : findFreeSpot(w, h, anchor, obstacles);
      block = translate(block, at.x - b.minX, at.y - b.minY);
    }

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
        place: (wd, ht, near, extra) => findFreeSpot(wd, ht, near, [...now, ...block, ...extra], 28, { nearest: true }),
        groupId: rid(),
        meta: { askId: data.id, askedAt, ...(thread ? { threadId: thread.id } : {}) },
        seed: askedAt,
        writeAnchor: (() => {
          const bg = block.filter((e) => e.customData?.role === "bg");
          return bg.length ? boundsOf(bg) : block.length ? boundsOf(block) : anchor;
        })(),
      });
    }

    if (block.length) {
      if (animation.length) {
        const v = getVisibleSceneBounds(api.getAppState());
        const b = boundsOf(block);
        if (b.minX < v[0] || b.minY < v[1] || b.maxX > v[2] || b.maxY > v[3]) {
          api.scrollToContent(block, { animate: !matchMedia("(prefers-reduced-motion: reduce)").matches, fitToViewport: true, viewportZoomFactor: 0.76 });
        }
        const pending = block.map((e) => ({ ...e, customData: { ...e.customData, claudePending: true } }));
        pendingVisualIds = new Set(pending.map((e) => e.id));
        update({ status: "Drawing…" });
        await animateSteps(api, pending, animation, { signal: controller.signal, skip: () => running.get(runId)?.skipAnimation || matchMedia("(prefers-reduced-motion: reduce)").matches });
        removeById(api, pendingVisualIds);
        const current = boundsOf(block);
        const obstacles = live(api);
        const occupied = obstacles.some((e) => {
          const b = boundsOf([e]);
          return b.minX < current.maxX && b.maxX > current.minX && b.minY < current.maxY && b.maxY > current.minY;
        });
        if (occupied && !controller.signal.aborted) {
          const at = findFreeSpot(current.maxX - current.minX, current.maxY - current.minY, anchor, obstacles);
          block = translate(block, at.x - current.minX, at.y - current.minY);
          api.scrollToContent(block, { animate: !matchMedia("(prefers-reduced-motion: reduce)").matches, fitToViewport: true, viewportZoomFactor: 0.76 });
        }
      }
      if (controller.signal.aborted) throw new Error("cancelled");
      insert(api, block);
      if (!animation.length) scrollIntoViewIfNeeded(api, block);
      if (narration.length) startWalkthrough(api, data.id);
    }

    // Edits to existing content (recolour, retype, move, remove).
    let proposal = null;
    if (Array.isArray(data.edits) && data.edits.length && editMode !== "off") {
      if (editMode === "ask") {
        const commands = data.edits.slice(0, 80);
        const targets = [...new Set(commands.flatMap((c) => [...(Array.isArray(c.targets) ? c.targets : [c.target]), ...(Array.isArray(c.between) ? c.between : []), c.near, c.from, c.to]).filter((x) => typeof x === "string").map((x) => x.toUpperCase()))];
        proposal = {
          id: rid(), askId: data.id, commands, regions, targets, lines: describeEdits(commands, regions), state: commands.map(() => "pending"),
          createdAt: Date.now(), source: thread ? "comment" : "card", threadId: thread?.id || null,
        };
        proposals.set(proposal.id, proposal);
        notifyProposals();
      } else {
        const res = applyEdits({ commands: data.edits, regions, elementsById: new Map(live(api).map((e) => [e.id, e])) });
        const { changed, added, done, skipped } = res;
        if (skipped.length) console.warn("some edits were skipped:", skipped);
        if (changed.size || added.length) {
          commitEdits(api, res, CaptureUpdateAction.IMMEDIATELY);
          api.setToast({
            message: `Claude edited ${done} part${done === 1 ? "" : "s"} of the board${skipped.length ? ` (${skipped.length} skipped)` : ""}. Ctrl+Z undoes it.`,
            duration: 5000,
          });
        }
      }
    }
    reply?.done({
      answer: data.answer || "(empty answer)", sessionId: data.sessionId, engine: data.engine, cwd: data.cwd, model: modelLabel, effort: data.effort || "",
      durationMs: data.durationMs, costUsd: data.costUsd, drew: visual.length > 0, inked: ink.length > 0, proposalId: proposal?.id || null,
      edited: !!(Array.isArray(data.edits) && data.edits.length && editMode === "auto"),
      steps: narration.length,
      askId: data.id, inputRef: data.inputRef,
    });
    if (ink.length) {
      if (matchMedia("(prefers-reduced-motion: reduce)").matches) insert(api, ink);
      else await animateInk(api, ink);
    }
  } catch (e) {
    clearTimeout(renderTimer);
    removeById(api, new Set([...placeholderIds, ...pendingVisualIds]));
    const aborted = controller.signal.aborted || e.message === "cancelled";
    if (thread) reply?.error(aborted ? "Cancelled." : e.message.slice(0, 300));
    else
      api.setToast(
        aborted
          ? { message: "Cancelled.", duration: 2000 }
          : { message: `Claude failed: ${e.message.slice(0, 300)}`, closable: true, duration: 10000 },
      );
    if (!aborted && !thread) throw e;
  } finally {
    running.delete(runId);
    notify();
  }
}

// Debug hook (used by tests / devtools).
window.__wbDebug = { selectTargets, newInk, buildDrawing, diagramElements, regionsFor, applyEdits };
