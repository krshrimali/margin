// Claude's ink: annotations drawn with the pen engine on top of the user's board.
//
// 1. regionsFor() groups the user's elements into labelled regions (R1, R2…),
//    Claude's diagram shapes into D1, D2… and Claude's cards into C1, C2…; markElements() draws those labels on a
//    copy of the snapshot so Claude can refer to things precisely.
// 2. Claude answers with commands such as {"do":"circle","target":"R3"}.
// 3. renderInk() turns the commands into hand-drawn freedraw strokes and
//    handwritten notes. Notes go in free space; marks sit on the content but
//    live on their own layer that can be hidden or cleared.
// 4. applyEdits() changes existing regions in place (colours, text, removal)
//    when the user asks for their content to be changed rather than marked up.
import { convertToExcalidrawElements, getCommonBounds, FONT_FAMILY, CaptureUpdateAction, newElementWith } from "@excalidraw/excalidraw";
import { makeFreedraw, penDescriptor, PRESETS } from "./pens.js";

export const INK_COLOR = "#7048e8";
const MARK_COLOR = "#f76707";

const boundsOf = (els) => {
  const [minX, minY, maxX, maxY] = getCommonBounds(els);
  return { minX, minY, maxX, maxY };
};
const w = (b) => b.maxX - b.minX;
const h = (b) => b.maxY - b.minY;
const gapBetween = (a, b) =>
  Math.max(0, Math.max(a.minX - b.maxX, b.minX - a.maxX), Math.max(a.minY - b.maxY, b.minY - a.maxY));
const contains = (outer, inner) => {
  const cx = (inner.minX + inner.maxX) / 2;
  const cy = (inner.minY + inner.maxY) / 2;
  return cx > outer.minX && cx < outer.maxX && cy > outer.minY && cy < outer.maxY && w(outer) * h(outer) > w(inner) * h(inner);
};
const union = (a, b) => ({ minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) });

// A long, nearly straight stroke (connector, underline, divider) stays its own region.
function isConnector(el, b) {
  if (el.type === "arrow" || el.type === "line") return true;
  if (el.type !== "freedraw" || el.points.length < 2) return false;
  const len = Math.max(w(b), h(b));
  if (len < 40) return false;
  let path = 0;
  for (let i = 1; i < el.points.length; i++) path += Math.hypot(el.points[i][0] - el.points[i - 1][0], el.points[i][1] - el.points[i - 1][1]);
  const [x0, y0] = el.points[0];
  const [x1, y1] = el.points[el.points.length - 1];
  return Math.hypot(x1 - x0, y1 - y0) / (path || 1) > 0.85;
}

const isCardBg = (e) => e.customData?.claude && (e.customData.role === "bg" || (!e.customData.role && e.type === "rectangle" && e.backgroundColor === "#f3f0ff"));

const isDiagramEl = (e) => e.customData?.claude && e.customData.role === "diagram" && !(e.type === "text" && e.text === "Suggested diagram");
const FILLABLE = new Set(["rectangle", "ellipse", "diamond"]);

/** Current colours of a region's elements, e.g. 'stroke #1e1e1e, fill #b2f2bb, text #1e1e1e'. */
function styleOf(els) {
  const uniq = (xs) => [...new Set(xs)].slice(0, 2).join("/");
  const stroke = uniq(els.filter((e) => e.type !== "text").map((e) => e.strokeColor));
  const fill = uniq(els.filter((e) => FILLABLE.has(e.type)).map((e) => e.backgroundColor));
  const text = uniq(els.filter((e) => e.type === "text").map((e) => e.strokeColor));
  return [stroke && `stroke ${stroke}`, fill && `fill ${fill}`, text && `text ${text}`].filter(Boolean).join(", ");
}

/** Group elements that belong together (a box and its text, a handwritten word) into regions. */
function groupRegions(els, boundText) {
  const items = els.map((el) => ({ el, b: boundsOf([el]) }));
  const parent = items.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const join = (i, j) => (parent[find(i)] = find(j));
  const small = (b) => Math.max(w(b), h(b)) < 160;
  const conn = items.map((it) => isConnector(it.el, it.b));
  // Endpoints of connectors, so arrowheads join their arrow rather than nearby text.
  const ends = items.map((it, i) => {
    if (!conn[i] || it.el.type !== "freedraw") return [];
    const p = it.el.points;
    return [p[0], p[p.length - 1]].map(([x, y]) => [it.el.x + x, it.el.y + y]);
  });
  const nearEnd = (b, i) => ends[i].some(([x, y]) => x > b.minX - 12 && x < b.maxX + 12 && y > b.minY - 12 && y < b.maxY + 12);
  const isHead = items.map((it) => Math.max(w(it.b), h(it.b)) < 45);
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i].b, b = items[j].b;
      if (conn[i] || conn[j]) {
        if ((conn[i] && isHead[j] && nearEnd(b, i)) || (conn[j] && isHead[i] && nearEnd(a, j))) join(i, j);
        continue;
      }
      if (contains(a, b) || contains(b, a) || (small(a) && small(b) && gapBetween(a, b) < 20)) join(i, j);
    }

  const groups = new Map();
  items.forEach((it, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push({ ...it, conn: conn[i] });
  });
  const regions = [...groups.values()].map((g) => {
    const members = g.flatMap(({ el }) => (boundText.has(el.id) ? [el, boundText.get(el.id)] : [el]));
    const texts = members.filter((e) => e.type === "text").map((e) => e.text);
    const types = new Set(g.map(({ el }) => el.type));
    const hasConn = g.some((x) => x.conn);
    const kind = types.size === 1 && types.has("freedraw") ? (hasConn ? "pen line/arrow" : "handwriting/sketch") : types.size === 1 && types.has("text") ? "typed text" : texts.length ? "box/shape with text" : [...types].join("+");
    return {
      kind,
      ids: members.map((e) => e.id),
      bounds: g.map((x) => x.b).reduce(union),
      label: texts.join(" ").replace(/\s+/g, " ").slice(0, 80),
      style: styleOf(members),
    };
  });
  // reading order: rows (by top edge, banded), then left to right
  regions.sort((a, b) => Math.round(a.bounds.minY / 80) - Math.round(b.bounds.minY / 80) || a.bounds.minX - b.bounds.minX);
  return regions;
}

/**
 * Group the user's elements into regions (R1…), the shapes of Claude's
 * suggested diagrams into diagram regions (D1…) and Claude's answer cards
 * into card regions (C1…). Returns [{ id, kind, ids, bounds, label, style }].
 */
export function regionsFor(context) {
  // bound text is attached to its container
  const boundText = new Map(context.filter((e) => e.type === "text" && e.containerId).map((t) => [t.containerId, t]));
  const free = (e) => !(e.type === "text" && e.containerId);
  const user = context.filter((e) => !e.customData?.claude && !e.customData?.claudePending && free(e));
  const regions = groupRegions(user, boundText).slice(0, 120).map((r, i) => ({ ...r, id: `R${i + 1}` }));

  // one diagram at a time, so shapes of neighbouring diagrams never merge
  const byAsk = new Map();
  for (const e of context.filter((e) => isDiagramEl(e) && free(e))) {
    const k = e.customData.askId || "?";
    byAsk.set(k, [...(byAsk.get(k) || []), e]);
  }
  const diagram = [...byAsk.values()]
    .flatMap((els) => groupRegions(els, boundText))
    .slice(0, 80)
    .map((r, i) => ({ ...r, id: `D${i + 1}`, kind: `your diagram: ${r.kind}` }));

  const cards = context.filter(isCardBg).map((e, i) => ({
    id: `C${i + 1}`,
    kind: "your earlier answer card",
    ids: [e.id],
    bounds: boundsOf([e]),
    label: "",
  }));
  return [...regions, ...diagram, ...cards];
}

/** Labelled boxes drawn over a copy of the snapshot (never added to the board). */
export function markElements(regions) {
  if (!regions.length) return [];
  const all = regions.map((r) => r.bounds).reduce(union);
  const fs = Math.max(13, Math.min(48, Math.max(w(all), h(all)) / 70));
  const skel = [];
  for (const r of regions) {
    const p = 5;
    skel.push({
      type: "rectangle", x: r.bounds.minX - p, y: r.bounds.minY - p, width: w(r.bounds) + 2 * p, height: h(r.bounds) + 2 * p,
      strokeColor: MARK_COLOR, backgroundColor: "transparent", strokeWidth: 1, strokeStyle: "dashed", roughness: 0, opacity: 80,
    });
    skel.push({
      type: "text", x: r.bounds.minX - p, y: r.bounds.minY - p - fs * 1.3, text: r.id, fontSize: fs,
      fontFamily: FONT_FAMILY.Cascadia, strokeColor: MARK_COLOR,
    });
  }
  return convertToExcalidrawElements(skel);
}

// ------------------------------------------------------------ drawing ----
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Resample a polyline every `step` units with a little hand jitter. */
function densify(pts, step, jitter, rnd) {
  const out = [];
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      out.push([x0 + (x1 - x0) * t + (rnd() - 0.5) * jitter, y0 + (y1 - y0) * t + (rnd() - 0.5) * jitter]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

const quad = (a, c, b, n = 24) =>
  Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n;
    return [(1 - t) ** 2 * a[0] + 2 * (1 - t) * t * c[0] + t * t * b[0], (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * c[1] + t * t * b[1]];
  });

/** Point where the ray from the centre of b towards (tx, ty) leaves b grown by m. */
function edgePoint(b, tx, ty, m) {
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  const dx = tx - cx, dy = ty - cy;
  const hw = w(b) / 2 + m, hh = h(b) / 2 + m;
  const s = 1 / Math.max(Math.abs(dx) / hw || 0, Math.abs(dy) / hh || 0, 1e-6);
  return [cx + dx * s, cy + dy * s];
}

function arrowStrokes(from, to, k, rnd, bend = 0.15) {
  const [x0, y0] = from, [x1, y1] = to;
  const len = Math.hypot(x1 - x0, y1 - y0) || 1;
  const nx = -(y1 - y0) / len, ny = (x1 - x0) / len;
  const sgn = rnd() < 0.5 ? -1 : 1;
  const ctrl = [(x0 + x1) / 2 + nx * len * bend * sgn, (y0 + y1) / 2 + ny * len * bend * sgn];
  const shaft = quad(from, ctrl, to, Math.max(12, Math.round(len / 6)));
  // arrowhead along the final direction of the curve
  const [px, py] = shaft[shaft.length - 3];
  const ang = Math.atan2(y1 - py, x1 - px);
  const L = 13 * k;
  const head = [
    [x1 - L * Math.cos(ang - 0.45), y1 - L * Math.sin(ang - 0.45)],
    [x1, y1],
    [x1 - L * Math.cos(ang + 0.45), y1 - L * Math.sin(ang + 0.45)],
  ];
  return [shaft, densify(head, 2 * k, 0.4 * k, rnd)];
}

function circleStroke(b, k, rnd) {
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  const rx = w(b) / 2 + 14 * k, ry = h(b) / 2 + 12 * k;
  const start = -Math.PI * 0.75 + rnd() * 0.5;
  const sweep = Math.PI * 2 + 0.35 + rnd() * 0.2; // overshoot, like a real circle
  const tilt = (rnd() - 0.5) * 0.12;
  const phase = rnd() * 6;
  const n = Math.max(48, Math.round((Math.PI * (rx + ry)) / (3 * k)));
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n;
    const th = start + sweep * t;
    const f = 1 + 0.035 * Math.sin(3 * th + phase) + 0.05 * t; // end lands slightly outside the start
    const x = rx * f * Math.cos(th), y = ry * f * Math.sin(th);
    return [cx + x * Math.cos(tilt) - y * Math.sin(tilt), cy + x * Math.sin(tilt) + y * Math.cos(tilt)];
  });
}

/**
 * Turn ink commands into elements.
 *   commands: [{do, target|targets|from|to|near, text|note|label}]
 *   regions:  output of regionsFor (bounds are recomputed from current elements)
 *   place(wd, ht, anchorBounds) -> {x, y}: free-space finder for notes
 */
export function renderInk({ commands, regions, elementsById, userStrokeSize, userFontSize, place, groupId, meta, seed, writeAnchor }) {
  const rnd = rng(seed);
  const k = Math.max(0.8, Math.min(3, (userStrokeSize || 3) / 3));
  const desc = { ...penDescriptor("fountain", PRESETS.fountain), size: 3.2 * k, thinning: 0.45, taperStart: 4 * k, taperEnd: 10 * k, smoothing: 0.6, streamline: 0.35 };
  const customData = { claude: true, role: "ink", ...meta };
  const out = [];
  const placed = [];

  const regionBounds = (id) => {
    const r = regions.find((r) => r.id === String(id || "").trim().toUpperCase());
    if (!r) return null;
    const live = r.ids.map((i) => elementsById.get(i)).filter((e) => e && !e.isDeleted);
    return live.length ? boundsOf(live) : r.bounds;
  };
  const stroke = (pts) => {
    if (pts.length < 2) return;
    const n = pts.length;
    const pressures = pts.map((_, i) => 0.45 + 0.3 * Math.sin((Math.PI * (i + 0.5)) / n));
    out.push(makeFreedraw({ points: pts, pressures, desc, color: INK_COLOR, customData, groupIds: [groupId] }));
  };
  // Notes are queued, merged per target (one list, one leader arrow) and laid out at the end.
  const requests = [];
  const note = (text, anchor, leader = true, key = null) => {
    text = String(text || "").trim();
    if (text) requests.push({ key: key || `#${requests.length}`, text, anchor, leader });
  };
  const keyOf = (id) => `R:${String(id || "").trim().toUpperCase()}`;

  const layoutNotes = () => {
    const groups = new Map();
    for (const r of requests) {
      const g = groups.get(r.key);
      if (g) {
        if (!g.texts.includes(r.text)) g.texts.push(r.text);
        g.anchor = union(g.anchor, r.anchor);
        g.leader ||= r.leader;
      } else groups.set(r.key, { ...r, texts: [r.text] });
    }
    const fontSize = Math.round(Math.max(18 * k, Math.min(72, (userFontSize || 20) * 0.95)));
    for (const g of groups.values()) {
      const isWrite = g.key === "write";
      const body = isWrite ? g.texts.join("\n\n") : g.texts.length > 1 ? g.texts.map((t) => `• ${t}`).join("\n") : g.texts[0];
      let [t] = convertToExcalidrawElements([
        { type: "text", x: 0, y: 0, text: wrap(body, isWrite ? 38 : 30), fontSize, fontFamily: FONT_FAMILY.Excalifont, strokeColor: INK_COLOR, lineHeight: 1.3 },
      ]);
      const spot = place(t.width, t.height, g.anchor, [...out, ...placed]);
      t = { ...t, x: spot.x, y: spot.y, groupIds: [groupId], customData };
      placed.push(t);
      if (g.leader || (g.texts.length > 1 && !isWrite)) {
        const nb = { minX: t.x, minY: t.y, maxX: t.x + t.width, maxY: t.y + t.height };
        const acx = (g.anchor.minX + g.anchor.maxX) / 2, acy = (g.anchor.minY + g.anchor.maxY) / 2;
        const from = edgePoint(nb, acx, acy, 6 * k);
        const to = edgePoint(g.anchor, from[0], from[1], 10 * k);
        if (Math.hypot(to[0] - from[0], to[1] - from[1]) > 25 * k) arrowStrokes(from, to, k, rnd, 0.12).forEach(stroke);
      }
    }
  };

  for (const c of (commands || []).slice(0, 12)) {
    const act = String(c.do || c.action || "").toLowerCase();
    const label = c.note || c.text || c.label;
    try {
      if (act === "note") {
        const b = regionBounds(c.near || c.target);
        if (b) note(label, b, true, keyOf(c.near || c.target));
        continue;
      }
      if (act === "write" || act === "explain") {
        if (writeAnchor) requests.push({ key: "write", text: String(label || "").trim(), anchor: writeAnchor, leader: false });
        continue;
      }
      if (act === "arrow" || act === "connect") {
        const a = regionBounds(c.from), b = regionBounds(c.to);
        if (!a || !b) continue;
        const ac = [(a.minX + a.maxX) / 2, (a.minY + a.maxY) / 2];
        const bc = [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
        const stacked = Math.abs(bc[1] - ac[1]) > Math.abs(bc[0] - ac[0]);
        let from, to, ctrl;
        if (stacked) {
          // leave from the right side of A, swing out, come back into the right side of B
          const side = Math.max(a.maxX, b.maxX);
          // aim the ends at the facing halves of the boxes so they don't collide with ticks/crosses at mid-height
          const down = bc[1] > ac[1];
          from = [a.maxX + 8 * k, down ? a.maxY - h(a) * 0.2 : a.minY + h(a) * 0.2];
          to = [b.maxX + 8 * k, down ? b.minY + h(b) * 0.2 : b.maxY - h(b) * 0.2];
          ctrl = [side + 40 * k + Math.abs(bc[1] - ac[1]) * 0.35, (ac[1] + bc[1]) / 2];
        } else {
          // side by side: arc over the top
          const top = Math.min(a.minY, b.minY);
          from = [ac[0], a.minY - 8 * k];
          to = [bc[0], b.minY - 8 * k];
          ctrl = [(ac[0] + bc[0]) / 2, top - 40 * k - Math.abs(bc[0] - ac[0]) * 0.3];
        }
        const shaft = quad(from, ctrl, to, 40);
        const [px, py] = shaft[shaft.length - 3];
        const ang = Math.atan2(to[1] - py, to[0] - px);
        const L = 13 * k;
        stroke(densify(shaft, 3 * k, 0.6 * k, rnd));
        stroke(densify([[to[0] - L * Math.cos(ang - 0.45), to[1] - L * Math.sin(ang - 0.45)], to, [to[0] - L * Math.cos(ang + 0.45), to[1] - L * Math.sin(ang + 0.45)]], 2 * k, 0.4 * k, rnd));
        if (label) {
          const apex = [0.25 * from[0] + 0.5 * ctrl[0] + 0.25 * to[0], 0.25 * from[1] + 0.5 * ctrl[1] + 0.25 * to[1]];
          note(label, { minX: apex[0] - 2, minY: apex[1] - 2, maxX: apex[0] + 2, maxY: apex[1] + 2 }, false);
        }
        continue;
      }
      const before = out.length;
      const targets = (Array.isArray(c.targets) ? c.targets : [c.target]).map(regionBounds).filter(Boolean);
      if (!targets.length) continue;
      const b = targets.reduce(union);
      const midY = (b.minY + b.maxY) / 2;
      if (act === "circle" || act === "highlight") stroke(circleStroke(b, k, rnd));
      else if (act === "underline")
        stroke(densify(quad([b.minX - 6 * k, b.maxY + 7 * k], [(b.minX + b.maxX) / 2, b.maxY + (7 + (rnd() * 6 - 1)) * k], [b.maxX + 8 * k, b.maxY + (5 + rnd() * 4) * k]), 3 * k, 0.5 * k, rnd));
      else if (act === "strike" || act === "cross-out")
        stroke(densify([[b.minX - 6 * k, midY + (rnd() - 0.3) * 4 * k], [b.maxX + 6 * k, midY - (rnd() - 0.3) * 4 * k]], 3 * k, 0.6 * k, rnd));
      else if (act === "check" || act === "tick") {
        const x = b.maxX + 14 * k, y = midY;
        stroke(densify([[x, y], [x + 7 * k, y + 9 * k], [x + 24 * k, y - 15 * k]], 2 * k, 0.5 * k, rnd));
      } else if (act === "cross" || act === "wrong") {
        const x = b.maxX + 14 * k, y = midY - 9 * k, s = 18 * k;
        stroke(densify([[x, y], [x + s, y + s]], 2 * k, 0.5 * k, rnd));
        stroke(densify([[x + s, y], [x, y + s]], 2 * k, 0.5 * k, rnd));
      } else if (act === "bracket") {
        const x = b.maxX + 16 * k;
        stroke(densify([[x - 9 * k, b.minY - 4 * k], [x, b.minY], [x, b.maxY], [x - 9 * k, b.maxY + 4 * k]], 3 * k, 0.5 * k, rnd));
      } else continue;
      if (label) {
        const markOnly = ["check", "tick", "cross", "wrong", "bracket"].includes(act);
        const drawn = out.slice(before);
        const key = Array.isArray(c.targets) ? `T:${c.targets.join(",")}` : keyOf(c.target);
        note(label, markOnly && drawn.length ? boundsOf(drawn) : b, !markOnly, key);
      }
    } catch (e) {
      console.warn("ink command failed", c, e);
    }
  }
  layoutNotes();
  return [...out, ...placed];
}

function wrap(text, width) {
  return text
    .split("\n")
    .map((para) => {
      const bullet = /^(•|-|\d+\.)\s/.exec(para);
      const indent = bullet ? " ".repeat(bullet[0].length + 1) : "";
      const lines = [];
      let line = "";
      for (const wd of para.split(/\s+/).filter(Boolean)) {
        if (line && (line + " " + wd).length > width) {
          lines.push(line);
          line = indent + wd;
        } else line = line ? line + " " + wd : wd;
      }
      lines.push(line);
      return lines.join("\n");
    })
    .join("\n");
}

// ------------------------------------------------------------ edits -----
const COLOR_RE = /^(#[0-9a-f]{3}|#[0-9a-f]{6}|#[0-9a-f]{8}|transparent)$/i;
const colorOf = (c) => (typeof c === "string" && COLOR_RE.test(c.trim()) ? c.trim().toLowerCase() : null);
const FILL_STYLES = new Set(["solid", "hachure", "cross-hatch", "zigzag"]);
const STROKE_STYLES = new Set(["solid", "dashed", "dotted"]);

/** Fresh size of a free-standing (or arrow-label) text with new content, keeping its anchor. */
function retextFree(t, text) {
  const [m] = convertToExcalidrawElements([
    { type: "text", x: 0, y: 0, text, fontSize: t.fontSize, fontFamily: t.fontFamily, lineHeight: t.lineHeight, textAlign: t.textAlign },
  ]);
  const centred = t.containerId || t.textAlign === "center";
  const x = centred ? t.x + (t.width - m.width) / 2 : t.textAlign === "right" ? t.x + t.width - m.width : t.x;
  const y = t.containerId ? t.y + (t.height - m.height) / 2 : t.y;
  return { text: m.text, originalText: text, width: m.width, height: m.height, x, y };
}

/** New text inside a shape: rebuild shape + label so the text wraps and the shape grows to fit (around its centre). */
function retextInContainer(container, t, text) {
  const [c2, t2] = convertToExcalidrawElements([
    {
      type: container.type, x: 0, y: 0, width: container.width, height: container.height,
      label: { text, fontSize: t.fontSize, fontFamily: t.fontFamily, textAlign: t.textAlign, verticalAlign: t.verticalAlign, strokeColor: t.strokeColor },
    },
  ]);
  const x0 = container.x - (c2.width - container.width) / 2;
  const y0 = container.y - (c2.height - container.height) / 2;
  return {
    container: c2.width !== container.width || c2.height !== container.height ? { x: x0, y: y0, width: c2.width, height: c2.height } : null,
    text: { text: t2.text, originalText: text, width: t2.width, height: t2.height, x: x0 + t2.x - c2.x, y: y0 + t2.y - c2.y },
  };
}

/**
 * Change existing content in place.
 *   {"do":"style","targets":["R1","D2"],"fill":"#ffc9c9","stroke":"#e03131","textColor":"#1e1e1e","fillStyle":"solid","strokeWidth":2,"strokeStyle":"dashed"}
 *   {"do":"relabel","target":"R6","text":"new text"}             (whole text; or "from":"old phrase" to replace a part)
 *   {"do":"delete","target":"R9"}
 * Returns { changed: Map(id -> new element), done: n, skipped: [reasons] }.
 */
export function applyEdits({ commands, regions, elementsById }) {
  const changed = new Map();
  const cur = (id) => changed.get(id) || elementsById.get(id);
  const set = (el, patch) => changed.set(el.id, newElementWith(el, patch));
  const skipped = [];
  let done = 0;
  const regionOf = (id) => {
    const r = regions.find((r) => r.id === String(id || "").trim().toUpperCase());
    return r && !r.id.startsWith("C") ? r : null; // answer cards are not editable
  };

  for (const c of (commands || []).slice(0, 80)) {
    const act = String(c.do || c.action || "").toLowerCase();
    const targets = (Array.isArray(c.targets) ? c.targets : [c.target]).filter(Boolean);
    const rs = targets.map(regionOf).filter(Boolean);
    if (!rs.length) {
      skipped.push(`${act} ${targets.join(",")}: no such region`);
      continue;
    }
    try {
      for (const r of rs) {
        const members = r.ids.map(cur).filter((e) => e && !e.isDeleted);
        if (!members.length) continue;
        if (act === "style" || act === "color" || act === "colour" || act === "recolor" || act === "recolour") {
          const stroke = colorOf(c.stroke || c.color || c.colour);
          const fill = colorOf(c.fill || c.background);
          const textColor = colorOf(c.textColor || c.text_color) || (members.every((e) => e.type === "text") ? stroke : null);
          const fillStyle = FILL_STYLES.has(c.fillStyle) ? c.fillStyle : null;
          const strokeStyle = STROKE_STYLES.has(c.strokeStyle) ? c.strokeStyle : null;
          const strokeWidth = Number(c.strokeWidth) > 0 ? Math.max(0.5, Math.min(8, Number(c.strokeWidth))) : null;
          for (const el of members) {
            const patch = {};
            if (el.type === "text") {
              if (textColor) patch.strokeColor = textColor;
            } else {
              if (stroke) patch.strokeColor = stroke;
              if (FILLABLE.has(el.type)) {
                if (fill) patch.backgroundColor = fill;
                if (fillStyle) patch.fillStyle = fillStyle;
              }
              if (el.type !== "freedraw") {
                if (strokeStyle) patch.strokeStyle = strokeStyle;
                if (strokeWidth) patch.strokeWidth = strokeWidth;
              }
            }
            if (Object.keys(patch).length) set(el, patch);
          }
          done++;
        } else if (act === "relabel" || act === "retext" || act === "rename" || act === "replace") {
          const text = String(c.text ?? c.to ?? "").trim();
          if (!text) throw new Error("no text");
          const texts = members.filter((e) => e.type === "text");
          if (!texts.length) throw new Error("no typed text here (handwriting can't be retyped)");
          let edits;
          if (c.from) {
            edits = texts.filter((t) => (t.originalText || t.text).includes(c.from)).map((t) => [t, (t.originalText || t.text).split(c.from).join(text)]);
            if (!edits.length) throw new Error(`"${c.from}" not found`);
          } else {
            const pick = texts.length === 1 ? texts[0] : texts.find((t) => t.containerId && !members.some((e) => e.type === "arrow" && e.id === t.containerId));
            if (!pick) throw new Error("several texts here; give \"from\"");
            edits = [[pick, text]];
          }
          for (const [t, next] of edits) {
            const container = t.containerId ? cur(t.containerId) : null;
            if (container && container.type !== "arrow") {
              const u = retextInContainer(container, t, next);
              set(t, u.text);
              if (u.container) set(container, u.container);
            } else set(t, retextFree(t, next));
          }
          done++;
        } else if (act === "delete" || act === "remove") {
          for (const el of members) set(el, { isDeleted: true });
          done++;
        } else {
          skipped.push(`unknown edit "${act}"`);
          break;
        }
      }
    } catch (e) {
      skipped.push(`${act} ${targets.join(",")}: ${e.message}`);
    }
  }
  return { changed, done, skipped };
}

// ------------------------------------------------------------ layer -----
const isInk = (e) => e.customData?.claude && e.customData.role === "ink";

export function inkState(api) {
  const ink = api.getSceneElements().filter(isInk);
  return { count: ink.length, hidden: ink.length > 0 && ink.every((e) => e.customData.hidden) };
}

/** Hide/show Claude's ink. Hidden ink is invisible and locked, and stays in the saved board. */
export function setInkHidden(api, hidden) {
  const elements = api.getSceneElementsIncludingDeleted().map((e) => {
    if (!isInk(e) || e.isDeleted || !!e.customData.hidden === hidden) return e;
    return hidden
      ? { ...e, opacity: 0, locked: true, customData: { ...e.customData, hidden: true, shownOpacity: e.opacity }, version: e.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31) }
      : { ...e, opacity: e.customData.shownOpacity ?? 100, locked: false, customData: { ...e.customData, hidden: false }, version: e.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31) };
  });
  api.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
}

export function clearInk(api) {
  api.updateScene({
    elements: api.getSceneElementsIncludingDeleted().map((e) => (isInk(e) && !e.isDeleted ? { ...e, isDeleted: true, version: e.version + 1 } : e)),
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
}
