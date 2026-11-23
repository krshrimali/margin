// Freeform drawings: Claude's <draw> block (one JSON item per line) turned into
// native Excalidraw elements. Shapes Excalidraw doesn't have (cylinder, cloud,
// document, person, braces…) are drawn as closed lines; when they carry text, an
// invisible rectangle holds the label and takes the arrow bindings, so arrows
// stay attached and the label wraps like in any other box.
import { convertToExcalidrawElements, FONT_FAMILY, ROUNDNESS } from "@excalidraw/excalidraw";
import { INK_COLOR } from "./ink.js";

export const CELL_W = 220;
export const CELL_H = 140;

// stroke / fill pairs from Excalidraw's own palette, so drawings match the editor's colours
export const COLORS = {
  black: ["#1e1e1e", "#e9ecef"],
  grey: ["#495057", "#e9ecef"],
  gray: ["#495057", "#e9ecef"],
  red: ["#e03131", "#ffc9c9"],
  pink: ["#c2255c", "#fcc2d7"],
  orange: ["#e8590c", "#ffd8a8"],
  yellow: ["#f08c00", "#ffec99"],
  green: ["#2f9e44", "#b2f2bb"],
  teal: ["#099268", "#96f2d7"],
  cyan: ["#0c8599", "#99e9f2"],
  blue: ["#1971c2", "#a5d8ff"],
  violet: ["#6741d9", "#d0bfff"],
  purple: ["#9c36b5", "#eebefa"],
};
const DEFAULT_STROKE = "#1e1e1e";
const HEX = /^#[0-9a-f]{3}([0-9a-f]{3})?$/i;

/** [stroke, fill] for an item's colour (name, hex, or none). */
function colorsFor(item, ink, fallbackFill = "transparent") {
  if (ink) return [INK_COLOR, "transparent"];
  const c = String(item.color || "").toLowerCase().trim();
  let stroke = DEFAULT_STROKE, fill = fallbackFill;
  if (COLORS[c]) [stroke, fill] = COLORS[c];
  else if (HEX.test(c)) [stroke, fill] = [c, c + "33"];
  if (item.fill === "none" || item.fill === false) fill = "transparent";
  else if (typeof item.fill === "string" && (HEX.test(item.fill) || COLORS[item.fill])) fill = COLORS[item.fill]?.[1] || item.fill;
  if (typeof item.stroke === "string" && (HEX.test(item.stroke) || COLORS[item.stroke])) stroke = COLORS[item.stroke]?.[0] || item.stroke;
  return [stroke, fill];
}

const FONT = { s: 16, m: 20, l: 28, xl: 36 };
const fontSizeOf = (item, d = 20) => FONT[item.size] || (Number(item.fontSize) > 6 ? Math.min(72, Number(item.fontSize)) : d);

// ---------------------------------------------------------- outlines ----
// Each returns point lists in a w×h box at the origin (closed when first == last).
const close = (pts) => [...pts, pts[0]];
const arc = (cx, cy, rx, ry, a0, a1, n = 16) =>
  Array.from({ length: n + 1 }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / n;
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
  });
const quadPts = (a, c, b, n = 10) =>
  Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n;
    return [(1 - t) ** 2 * a[0] + 2 * (1 - t) * t * c[0] + t * t * b[0], (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * c[1] + t * t * b[1]];
  });

const OUTLINES = {
  pill: (w, h) => {
    const r = Math.min(h / 2, w / 2);
    return [{ pts: close([...arc(w - r, h / 2, r, h / 2, -Math.PI / 2, Math.PI / 2, 14), ...arc(r, h / 2, r, h / 2, Math.PI / 2, Math.PI * 1.5, 14)]) }];
  },
  parallelogram: (w, h) => {
    const s = Math.min(w * 0.18, h * 0.6);
    return [{ pts: close([[s, 0], [w, 0], [w - s, h], [0, h]]) }];
  },
  trapezoid: (w, h) => {
    const s = Math.min(w * 0.16, h * 0.6);
    return [{ pts: close([[s, 0], [w - s, 0], [w, h], [0, h]]) }];
  },
  hexagon: (w, h) => {
    const s = Math.min(w * 0.18, h / 2);
    return [{ pts: close([[s, 0], [w - s, 0], [w, h / 2], [w - s, h], [s, h], [0, h / 2]]) }];
  },
  document: (w, h) => {
    const b = h * 0.86, a = h * 0.08;
    const wave = Array.from({ length: 17 }, (_, i) => {
      const t = i / 16;
      return [w * (1 - t), b + a * Math.sin(t * Math.PI * 2)];
    });
    return [{ pts: close([[0, 0], [w, 0], ...wave]) }];
  },
  cylinder: (w, h) => {
    const ry = Math.min(14, h * 0.16);
    // body: left side down, front of the bottom rim, right side up, back of the top rim
    const body = [[0, ry], [0, h - ry], ...arc(w / 2, h - ry, w / 2, ry, Math.PI, 0, 18).slice(1), [w, ry], ...arc(w / 2, ry, w / 2, ry, 0, -Math.PI, 18).slice(1)];
    return [{ pts: close(body) }, { ellipse: [0, 0, w, ry * 2] }];
  },
  queue: (w, h) => {
    const rx = Math.min(14, w * 0.12);
    const body = [[rx, 0], [w - rx, 0], ...arc(w - rx, h / 2, rx, h / 2, -Math.PI / 2, Math.PI / 2, 18).slice(1), [rx, h], ...arc(rx, h / 2, rx, h / 2, Math.PI / 2, Math.PI * 1.5, 18).slice(1)];
    return [{ pts: close(body) }, { ellipse: [w - rx * 2, 0, rx * 2, h] }];
  },
  cloud: (w, h) => {
    // scalloped ellipse: |sin| makes round bumps with cusps between them
    const n = 96;
    const pts = Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2;
      const r = 0.84 + 0.16 * Math.abs(Math.sin(a * 3.5 + 0.4));
      return [w / 2 + (w / 2) * r * Math.cos(a), h / 2 + (h / 2) * r * Math.sin(a)];
    });
    return [{ pts: close(pts), round: true, smooth: true }];
  },
  note: (w, h) => {
    const f = Math.min(22, h * 0.3);
    return [{ pts: close([[0, 0], [w, 0], [w, h - f], [w - f, h], [0, h]]) }, { pts: [[w, h - f], [w - f, h - f], [w - f, h]], open: true }];
  },
  callout: (w, h) => {
    const t = Math.min(26, h * 0.4);
    return [{ pts: close([[0, 0], [w, 0], [w, h], [w * 0.36, h], [w * 0.18, h + t], [w * 0.22, h], [0, h]]) }];
  },
  subroutine: (w, h) => {
    const s = Math.min(12, w * 0.07);
    return [{ pts: close([[0, 0], [w, 0], [w, h], [0, h]]) }, { pts: [[s, 0], [s, h]], open: true }, { pts: [[w - s, 0], [w - s, h]], open: true }];
  },
};

// Excalidraw-native shapes (they can hold a label directly).
const NATIVE = {
  rect: { type: "rectangle" },
  rectangle: { type: "rectangle" },
  box: { type: "rectangle" },
  process: { type: "rectangle" },
  rounded: { type: "rectangle", roundness: { type: ROUNDNESS.ADAPTIVE_RADIUS } },
  ellipse: { type: "ellipse" },
  oval: { type: "ellipse" },
  circle: { type: "ellipse", square: true },
  diamond: { type: "diamond" },
  decision: { type: "diamond" },
};
const ALIASES = { stadium: "pill", terminal: "pill", terminator: "pill", start: "pill", end: "pill", database: "cylinder", db: "cylinder", storage: "cylinder", sticky: "note", bubble: "callout", speech: "callout", io: "parallelogram", input: "parallelogram", output: "parallelogram", data: "parallelogram", doc: "document", prep: "hexagon", preparation: "hexagon", actor: "person", user: "person", internet: "cloud", external: "cloud", "curly-brace": "brace", curly: "brace", heading: "title", label: "text", frame: "group", container: "group" };

const SHAPES_WITH_TEXT = new Set([...Object.keys(NATIVE), ...Object.keys(OUTLINES), "person"]);
const MARKS = new Set(["check", "tick", "cross", "star", "warning", "number"]);

// ------------------------------------------------------------- layout ----

/**
 * Grid with adaptive tracks: each column is as wide as its widest shape plus a
 * gap (at least one cell), each row as tall as its tallest shape plus a gap, so
 * long labels never make neighbours collide and arrows always have room.
 */
function gridLayout(items, sizeOf) {
  const GAP_X = 130, GAP_Y = 84;
  const maxW = new Map(), maxH = new Map();
  for (const it of items) {
    const sz = sizeOf(it);
    if (!sz || !Array.isArray(it.at)) continue;
    const c = Math.floor(Number(it.at[0]) || 0), r = Math.floor(Number(it.at[1]) || 0);
    maxW.set(c, Math.max(maxW.get(c) || 0, sz[0]));
    maxH.set(r, Math.max(maxH.get(r) || 0, sz[1]));
  }
  const gapX = new Map(), gapY = new Map(); // gap needed on the right of column c / below row r
  // labelled arrows between neighbouring columns / rows need room for their label
  const atOf = new Map(items.filter((i) => i.id != null && Array.isArray(i.at)).map((i) => [String(i.id), i.at.map((v) => Number(v) || 0)]));
  for (const it of items) {
    if (!["arrow", "line", "connector"].includes(it.shape)) continue;
    const a = atOf.get(String(it.from)), b = atOf.get(String(it.to));
    const label = String(it.label || it.text || "");
    if (!a || !b) continue;
    const need = label ? label.length * 9.5 + 70 : 60;
    if (Math.abs(a[1] - b[1]) < 0.5 && Math.abs(a[0] - b[0]) >= 0.5) {
      const c = Math.floor(Math.min(a[0], b[0]));
      gapX.set(c, Math.max(gapX.get(c) || 0, need));
    } else if (Math.abs(a[0] - b[0]) < 0.5 && Math.abs(a[1] - b[1]) >= 0.5 && label) {
      const r = Math.floor(Math.min(a[1], b[1]));
      gapY.set(r, Math.max(gapY.get(r) || 0, GAP_Y + 40));
    }
  }
  // Shapes sit centred in their track, so the space between columns c and c+1 is half of each
  // track's slack: a track gets enough slack for the widest gap on either side of it.
  const track = (i, max, gap, G, min) => {
    const g = Math.max(G, gap.get(i) || 0, gap.get(i - 1) || 0);
    return Math.max(min, (max.get(i) || 0) + g);
  };
  const cw = (c) => track(c, maxW, gapX, GAP_X, CELL_W);
  const rh = (r) => track(r, maxH, gapY, GAP_Y, CELL_H);
  const start = (i, size) => {
    let s = 0;
    if (i >= 0) for (let k = 0; k < i; k++) s += size(k);
    else for (let k = i; k < 0; k++) s -= size(k);
    return s;
  };
  const pos = (v, size) => {
    const i = Math.floor(Number(v) || 0), f = (Number(v) || 0) - i;
    return [start(i, size) + size(i) / 2 + f * size(i), size(i)];
  };
  return {
    centre: (at) => {
      const [c, r] = Array.isArray(at) ? at : [0, 0];
      return [pos(c, cw)[0], pos(r, rh)[0]];
    },
    cell: (at) => {
      const [c, r] = Array.isArray(at) ? at : [0, 0];
      return [pos(c, cw)[1], pos(r, rh)[1]];
    },
  };
}

/** Default size of a shape from its text, so short labels get compact boxes and long ones wrap. */
function shapeSize(item, shape, fontSize) {
  const text = String(item.text ?? "");
  const lines = text.split("\n");
  const longest = Math.max(0, ...lines.map((l) => l.length));
  const charW = fontSize * 0.62;
  let w = Math.max(120, Math.min(280, longest * charW + 48));
  const wrapped = Math.max(lines.length, Math.ceil((text.length * charW) / Math.max(60, w - 40)));
  let h = Math.max(64, wrapped * fontSize * 1.35 + 30);
  if (["diamond", "decision"].includes(shape)) { w *= 1.45; h *= 1.5; }
  if (["ellipse", "oval", "cloud"].includes(shape)) { w *= 1.25; h *= 1.3; }
  if (shape === "cylinder") h += 26;
  if (shape === "queue") w += 26;
  if (shape === "document") h *= 1.2;
  if (["parallelogram", "trapezoid", "hexagon"].includes(shape)) w += 36;
  if (shape === "note") { w = Math.max(w, 150); h = Math.max(h, 110); }
  if (shape === "callout") h += 6;
  if (shape === "pill") w += 20;
  if (shape === "circle") w = h = Math.max(w * 0.8, h, 90);
  if (item.w) w = Math.max(40, Number(item.w) * CELL_W);
  if (item.h) h = Math.max(30, Number(item.h) * CELL_H);
  return [w, h];
}

const boxOf = (s) => ({ minX: s.x, minY: s.y, maxX: s.x + s.width, maxY: s.y + s.height });
const union = (a, b) => ({ minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) });

/** Where the line from the centre of box b towards (tx, ty) leaves it (plus a gap). */
function exitPoint(b, tx, ty, gap = 6, ellipse = false) {
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  const dx = tx - cx, dy = ty - cy;
  const hw = (b.maxX - b.minX) / 2, hh = (b.maxY - b.minY) / 2;
  if (!dx && !dy) return [cx, cy];
  let s;
  if (ellipse) s = 1 / Math.sqrt((dx * dx) / (hw * hw) + (dy * dy) / (hh * hh));
  else s = 1 / Math.max(Math.abs(dx) / hw || 0, Math.abs(dy) / hh || 0);
  const len = Math.hypot(dx, dy);
  return [cx + dx * s + (dx / len) * gap, cy + dy * s + (dy / len) * gap];
}

/** Curly brace along one side of box b. Returns { pts, tip:[x,y], dir }. */
function bracePoints(b, side, depth = 14) {
  // build a brace for side "right" in a local frame (u along the side, v outward), then map
  const vertical = side === "left" || side === "right";
  const u0 = vertical ? b.minY : b.minX, u1 = vertical ? b.maxY : b.maxX;
  const um = (u0 + u1) / 2;
  const d = Math.min(depth, (u1 - u0) / 4);
  const local = [
    ...quadPts([0, u0], [d, u0], [d, u0 + d]),
    ...quadPts([d, um - d], [d, um], [2 * d, um]).slice(0),
    ...quadPts([2 * d, um], [d, um], [d, um + d]).slice(1),
    ...quadPts([d, u1 - d], [d, u1], [0, u1]),
  ];
  const base = { right: b.maxX + 8, left: b.minX - 8, bottom: b.maxY + 8, top: b.minY - 8 }[side];
  const sgn = side === "left" || side === "top" ? -1 : 1;
  const map = ([v, u]) => (vertical ? [base + sgn * v, u] : [u, base + sgn * v]);
  return { pts: local.map(map), tip: map([2 * d + 10, um]), side };
}

function bracketPoints(b, side, depth = 12) {
  const vertical = side === "left" || side === "right";
  const u0 = vertical ? b.minY : b.minX, u1 = vertical ? b.maxY : b.maxX;
  const base = { right: b.maxX + 8, left: b.minX - 8, bottom: b.maxY + 8, top: b.minY - 8 }[side];
  const sgn = side === "left" || side === "top" ? -1 : 1;
  const map = ([v, u]) => (vertical ? [base + sgn * v, u] : [u, base + sgn * v]);
  return { pts: [[0, u0], [depth, u0], [depth, u1], [0, u1]].map(map), tip: map([depth + 10, (u0 + u1) / 2]), side };
}

/** A line element from absolute points. */
const lineSkel = (pts, extra) => {
  const [x0, y0] = pts[0];
  return { type: "line", x: x0, y: y0, points: pts.map(([x, y]) => [x - x0, y - y0]), ...extra };
};

/** Text that sits beside an anchor point, pushed away in direction `side`. */
function sideText(text, [x, y], side, extra) {
  const fontSize = extra.fontSize || 18;
  const lines = String(text).split("\n");
  const w = Math.max(...lines.map((l) => l.length)) * fontSize * 0.6;
  const h = lines.length * fontSize * 1.25;
  const pos = {
    right: [x, y - h / 2, "left"],
    left: [x - w, y - h / 2, "right"],
    bottom: [x - w / 2, y, "center"],
    top: [x - w / 2, y - h, "center"],
  }[side] || [x, y - h / 2, "left"];
  return { type: "text", x: pos[0], y: pos[1], text: String(text), textAlign: pos[2], ...extra };
}

function wrapText(text, width) {
  return String(text)
    .split("\n")
    .map((para) => {
      const out = [];
      let line = "";
      for (const wd of para.split(/\s+/).filter(Boolean)) {
        if (line && (line + " " + wd).length > width) {
          out.push(line);
          line = wd;
        } else line = line ? `${line} ${wd}` : wd;
      }
      out.push(line);
      return out.join("\n");
    })
    .join("\n");
}

// --------------------------------------------------------------- build ----
/**
 * Build a drawing from <draw> items.
 *   items: [{title?, style?}, {id, shape, text, at, ...}, ...]
 *   prefix: unique id prefix (stable across streaming rebuilds)
 * Returns { elements, steps } — steps[i] are the element ids of item i, in drawing order (for animation).
 */
export function buildDrawing(items, { prefix, ink: forceInk = false } = {}) {
  const opts = items.find((i) => i && !i.shape && (i.style || i.title)) || {};
  const ink = forceInk || String(opts.style || "").toLowerCase() === "ink";
  const roughness = 1;
  const font = FONT_FAMILY.Excalifont;
  const textColor = ink ? INK_COLOR : DEFAULT_STROKE;
  const byId = new Map(); // item id -> { box, containerId, ellipse }
  const front = []; // [skeleton, step]
  const back = []; // groups and frames go behind everything
  const steps = [];
  let n = 0;
  const nid = (k) => `${prefix}-${k}-${n++}`;

  if (opts.title) {
    const id = nid("title");
    front.push([{ type: "text", id, x: 0, y: -CELL_H * 0.15 - 46, text: String(opts.title), fontSize: 28, fontFamily: font, strokeColor: textColor }, 0]);
    steps.push([id]);
  }

  // size every shape first, so the grid can make room for it
  const norm = (raw) => {
    const shape = ALIASES[String(raw.shape).toLowerCase().trim()] || String(raw.shape).toLowerCase().trim();
    return { ...raw, shape };
  };
  const personSize = (item, fontSize) => {
    const text = String(item.text ?? "");
    const lw = Math.max(90, text.length * fontSize * 0.6 + 16);
    return [Math.max(44, lw), 82 + (text ? fontSize * 1.4 : 0)];
  };
  const grid = gridLayout(
    items.filter((i) => i && i.shape).map(norm),
    (item) => {
      if (!SHAPES_WITH_TEXT.has(item.shape)) return null;
      const fs = fontSizeOf(item, item.shape === "note" ? 18 : 20);
      return item.shape === "person" ? personSize(item, fs) : shapeSize(item, item.shape, fs);
    },
  );
  const cellCentre = grid.centre;

  const boxesOf = (ids) => (Array.isArray(ids) ? ids : [ids]).map((i) => byId.get(String(i))?.box).filter(Boolean);
  const anchorBox = (item) => {
    if (item.near && byId.has(String(item.near))) return byId.get(String(item.near)).box;
    const [cx, cy] = cellCentre(item.at);
    return { minX: cx - 1, minY: cy - 1, maxX: cx + 1, maxY: cy + 1 };
  };

  for (const raw of items) {
    if (!raw || typeof raw !== "object" || !raw.shape) continue;
    let shape = String(raw.shape).toLowerCase().trim();
    shape = ALIASES[shape] || shape;
    const item = { ...raw, shape };
    const step = [];
    steps.push(step);
    const push = (skel, where = front) => {
      skel.id ||= nid(shape);
      where.push([skel, steps.length - 1]);
      step.push(skel.id);
      return skel.id;
    };
    const groupId = `${prefix}-g${steps.length}`;
    const [stroke, fill] = colorsFor(item, ink, shape === "note" ? COLORS.yellow[1] : "transparent");
    const common = {
      strokeColor: stroke, backgroundColor: fill, fillStyle: "solid", roughness,
      strokeWidth: item.bold || item.thick ? 4 : 2, strokeStyle: item.dashed ? "dashed" : item.dotted ? "dotted" : "solid",
    };
    const fontSize = fontSizeOf(item, shape === "note" ? 18 : 20);
    try {
      // ---------- shapes that hold text
      if (SHAPES_WITH_TEXT.has(shape)) {
        const [cx, cy] = cellCentre(item.at);
        let [w, h] = shapeSize(item, shape, fontSize);
        const text = String(item.text ?? "");
        const label = text ? { text, fontSize, fontFamily: font, strokeColor: ink ? INK_COLOR : item.textColor && COLORS[item.textColor] ? COLORS[item.textColor][0] : DEFAULT_STROKE } : undefined;
        if (shape === "person") {
          // stick figure above, label underneath; an invisible box covers both for arrows
          const fw = 44, fh = 74;
          [w, h] = personSize(item, fontSize);
          const x = cx - w / 2, y = cy - h / 2;
          const fx = cx - fw / 2;
          const id = push({
            type: "rectangle", x, y, width: w, height: h, strokeColor: "transparent", backgroundColor: "transparent", roughness: 0,
            ...(label ? { label: { ...label, verticalAlign: "bottom" } } : {}), groupIds: [groupId],
          });
          const ln = { strokeColor: stroke, roughness, strokeWidth: 2, groupIds: [groupId] };
          push({ type: "ellipse", x: fx + 11, y, width: 22, height: 22, ...ln, backgroundColor: fill === "transparent" ? "transparent" : fill, fillStyle: "solid" });
          push(lineSkel([[cx, y + 22], [cx, y + 50]], ln));
          push(lineSkel([[fx + 2, y + 32], [cx, y + 28], [fx + fw - 2, y + 32]], ln));
          push(lineSkel([[fx + 6, y + fh], [cx, y + 50], [fx + fw - 6, y + fh]], ln));
          byId.set(String(item.id ?? id), { box: { minX: x, minY: y, maxX: x + w, maxY: y + h }, containerId: id });
          continue;
        }
        const x = cx - w / 2, y = cy - h / 2;
        if (NATIVE[shape]) {
          const nat = NATIVE[shape];
          const id = push({
            type: nat.type, x, y, width: w, height: h, ...common, roundness: nat.roundness || null,
            ...(label ? { label } : {}), groupIds: [groupId], ...(item.link ? { link: String(item.link) } : {}),
          });
          byId.set(String(item.id ?? id), { box: { minX: x, minY: y, maxX: x + w, maxY: y + h }, containerId: id, ellipse: nat.type === "ellipse", diamond: nat.type === "diamond" });
          continue;
        }
        // custom outline + invisible label holder (inset so text stays inside the outline)
        const parts = OUTLINES[shape](w, h);
        for (const p of parts) {
          if (p.ellipse) {
            const [ex, ey, ew, eh] = p.ellipse;
            push({ type: "ellipse", x: x + ex, y: y + ey, width: ew, height: eh, ...common, groupIds: [groupId] });
          } else {
            push(lineSkel(p.pts.map(([px, py]) => [x + px, y + py]), {
              ...common, backgroundColor: p.open ? "transparent" : common.backgroundColor, groupIds: [groupId], ...(p.smooth ? { roughness: 0 } : {}),
              roundness: p.round ? { type: ROUNDNESS.PROPORTIONAL_RADIUS } : null,
            }));
          }
        }
        const inset = {
          cylinder: [6, 26, 6, 10], queue: [10, 4, 30, 4], document: [6, 4, 6, h * 0.16], hexagon: [w * 0.14, 2, w * 0.14, 2],
          parallelogram: [w * 0.14, 2, w * 0.14, 2], trapezoid: [w * 0.14, 2, w * 0.14, 2], cloud: [w * 0.14, h * 0.16, w * 0.14, h * 0.16],
          note: [6, 6, 12, 14], subroutine: [12, 2, 12, 2], callout: [4, 4, 4, 4],
        }[shape] || [4, 4, 4, 4];
        const id = push({
          type: "rectangle", x: x + inset[0], y: y + inset[1], width: w - inset[0] - inset[2], height: h - inset[1] - inset[3],
          strokeColor: "transparent", backgroundColor: "transparent", roughness: 0,
          ...(label ? { label } : {}), groupIds: [groupId], ...(item.link ? { link: String(item.link) } : {}),
        });
        byId.set(String(item.id ?? id), { box: { minX: x, minY: y, maxX: x + w, maxY: y + h }, containerId: id });
        continue;
      }

      // ---------- connectors
      if (shape === "arrow" || shape === "line" || shape === "connector") {
        const a = byId.get(String(item.from)), b = byId.get(String(item.to));
        const pa = a ? null : Array.isArray(item.from) ? cellCentre(item.from) : null;
        const pb = b ? null : Array.isArray(item.to) ? cellCentre(item.to) : null;
        if ((!a && !pa) || (!b && !pb)) continue;
        const ca = a ? [(a.box.minX + a.box.maxX) / 2, (a.box.minY + a.box.maxY) / 2] : pa;
        const cb = b ? [(b.box.minX + b.box.maxX) / 2, (b.box.minY + b.box.maxY) / 2] : pb;
        const route = String(item.route || item.curve || "straight").toLowerCase();
        let pts;
        if (route === "elbow" || route === "orthogonal") {
          const horiz = Math.abs(cb[0] - ca[0]) >= Math.abs(cb[1] - ca[1]);
          const s = a ? exitPoint(a.box, horiz ? cb[0] : ca[0], horiz ? ca[1] : cb[1], 6) : ca;
          const e2 = b ? exitPoint(b.box, horiz ? s[0] : cb[0], horiz ? cb[1] : s[1], 6) : cb;
          pts = horiz ? [s, [(s[0] + e2[0]) / 2, s[1]], [(s[0] + e2[0]) / 2, e2[1]], e2] : [s, [s[0], (s[1] + e2[1]) / 2], [e2[0], (s[1] + e2[1]) / 2], e2];
        } else {
          const s = a ? exitPoint(a.box, cb[0], cb[1], 6, a.ellipse) : ca;
          const e = b ? exitPoint(b.box, ca[0], ca[1], 6, b.ellipse) : cb;
          pts = [s, e];
          if (route === "curve" || route === "curved" || route === "arc") {
            // bend to one side and leave/enter through the edges facing the bend, so a curved
            // return arrow doesn't start where the straight forward arrow does
            const len = Math.hypot(cb[0] - ca[0], cb[1] - ca[1]) || 1;
            const bend = Math.max(60, (item.bend ?? 0.3) * len);
            const ctrl = [(ca[0] + cb[0]) / 2 - ((cb[1] - ca[1]) / len) * bend * 1.6, (ca[1] + cb[1]) / 2 + ((cb[0] - ca[0]) / len) * bend * 1.6];
            const s2 = a ? exitPoint(a.box, ctrl[0], ctrl[1], 6, a.ellipse) : ca;
            const e2 = b ? exitPoint(b.box, ctrl[0], ctrl[1], 6, b.ellipse) : cb;
            const mid = [0.25 * s2[0] + 0.5 * ctrl[0] + 0.25 * e2[0], 0.25 * s2[1] + 0.5 * ctrl[1] + 0.25 * e2[1]];
            pts = [s2, mid, e2];
          }
        }
        const isArrow = shape !== "line";
        const ends = String(item.ends || "").toLowerCase();
        push({
          ...lineSkel(pts, {}),
          type: isArrow || ends === "both" ? "arrow" : "line",
          strokeColor: stroke, roughness, strokeWidth: item.bold || item.thick ? 4 : 2,
          strokeStyle: item.dashed ? "dashed" : item.dotted ? "dotted" : "solid",
          roundness: pts.length === 3 ? { type: ROUNDNESS.PROPORTIONAL_RADIUS } : null,
          startArrowhead: ends === "both" ? "arrow" : null,
          endArrowhead: isArrow || ends === "both" ? (item.head === "dot" ? "dot" : item.head === "bar" ? "bar" : "arrow") : null,
          ...(a ? { start: { id: a.containerId } } : {}),
          ...(b ? { end: { id: b.containerId } } : {}),
          ...(item.label || item.text ? { label: { text: String(item.label || item.text), fontSize: 16, fontFamily: font, strokeColor: textColor } } : {}),
        });
        continue;
      }

      // ---------- braces, brackets, groups
      if (shape === "brace" || shape === "bracket") {
        const boxes = boxesOf(item.around || item.targets || []);
        let b = boxes.length ? boxes.reduce(union) : null;
        if (!b && item.from && item.to) {
          const [x0, y0] = cellCentre(item.from), [x1, y1] = cellCentre(item.to);
          b = { minX: Math.min(x0, x1), minY: Math.min(y0, y1), maxX: Math.max(x0, x1), maxY: Math.max(y0, y1) };
        }
        if (!b) continue;
        const side = ["left", "right", "top", "bottom"].includes(item.side) ? item.side : b.maxX - b.minX > (b.maxY - b.minY) * 1.6 ? "bottom" : "right";
        const g = shape === "brace" ? bracePoints(b, side, item.depth || 16) : bracketPoints(b, side);
        push(lineSkel(g.pts, { strokeColor: stroke, roughness: 0, strokeWidth: 2, groupIds: [groupId] }));
        if (item.text) push(sideText(wrapText(item.text, 26), g.tip, side, { fontSize: fontSizeOf(item, 18), fontFamily: font, strokeColor: ink ? INK_COLOR : stroke === DEFAULT_STROKE ? textColor : stroke, groupIds: [groupId] }));
        continue;
      }
      if (shape === "group") {
        const boxes = boxesOf(item.around || item.targets || []);
        if (!boxes.length) continue;
        const b = boxes.reduce(union);
        const pad = 26, top = item.text ? 30 : 0;
        const [gs, gf] = colorsFor(item, ink, "transparent");
        push({
          type: "rectangle", x: b.minX - pad, y: b.minY - pad - top, width: b.maxX - b.minX + 2 * pad, height: b.maxY - b.minY + 2 * pad + top,
          strokeColor: gs === DEFAULT_STROKE && !ink ? "#868e96" : gs, backgroundColor: item.color && !ink && item.fill !== "none" ? gf + "" : "transparent",
          fillStyle: "solid", strokeStyle: item.solid ? "solid" : "dashed", strokeWidth: 2, roughness: 0, opacity: item.color ? 70 : 100,
          roundness: { type: ROUNDNESS.ADAPTIVE_RADIUS }, groupIds: [groupId],
        }, back);
        if (item.text) push({ type: "text", x: b.minX - pad + 12, y: b.minY - pad - top + 8, text: String(item.text), fontSize: 16, fontFamily: font, strokeColor: ink ? INK_COLOR : gs === DEFAULT_STROKE ? "#495057" : gs, groupIds: [groupId] }, back);
        continue;
      }

      // ---------- text
      if (shape === "text" || shape === "title") {
        const [cx, cy] = cellCentre(item.at);
        const fsz = shape === "title" ? fontSizeOf(item, 32) : fontSizeOf(item, 20);
        const body = wrapText(String(item.text ?? ""), Number(item.width) || (shape === "title" ? 48 : 34));
        const lines = body.split("\n");
        const tw = Math.max(...lines.map((l) => l.length)) * fsz * 0.58, th = lines.length * fsz * 1.25;
        const align = item.align === "left" || item.align === "right" ? item.align : "center";
        const [cellW] = grid.cell(item.at);
        const x = align === "left" ? cx - cellW / 2 + 10 : align === "right" ? cx + cellW / 2 - 10 - tw : cx - tw / 2;
        push({
          type: "text", x, y: cy - th / 2, text: body, fontSize: fsz, fontFamily: font, textAlign: align,
          strokeColor: ink ? INK_COLOR : item.color ? colorsFor(item, false)[0] : DEFAULT_STROKE,
        });
        if (item.id) byId.set(String(item.id), { box: { minX: x, minY: cy - th / 2, maxX: x + tw, maxY: cy + th / 2 }, containerId: null });
        continue;
      }

      // ---------- table
      if (shape === "table") {
        const rows = (Array.isArray(item.rows) ? item.rows : []).slice(0, 12).map((r) => (Array.isArray(r) ? r : [r]).slice(0, 6).map((c) => String(c ?? "")));
        if (!rows.length) continue;
        const cols = Math.max(...rows.map((r) => r.length));
        const fsz = fontSizeOf(item, 16);
        const colW = Array.from({ length: cols }, (_, c) => Math.max(70, Math.min(240, Math.max(...rows.map((r) => (r[c] || "").length)) * fsz * 0.6 + 24)));
        const wrapAt = colW.map((cw) => Math.max(6, Math.floor((cw - 20) / (fsz * 0.6))));
        const rowH = rows.map((r) => Math.max(...r.map((c, i) => wrapText(c, wrapAt[i]).split("\n").length)) * fsz * 1.3 + 18);
        const [cx, cy] = cellCentre(item.at);
        const tw = colW.reduce((a, b) => a + b, 0), th = rowH.reduce((a, b) => a + b, 0);
        const [cellW, cellH] = grid.cell(item.at);
        const x0 = cx - cellW / 2 + 10, y0 = cy - cellH / 2 + 10;
        const [hs, hf] = colorsFor({ ...item, color: item.color || "grey" }, ink);
        let y = y0;
        rows.forEach((r, ri) => {
          let x = x0;
          for (let ci = 0; ci < cols; ci++) {
            push({
              type: "rectangle", x, y, width: colW[ci], height: rowH[ri], strokeColor: ink ? INK_COLOR : ri === 0 ? hs : "#868e96",
              backgroundColor: ri === 0 && !ink && item.header !== false ? hf : "transparent", fillStyle: "solid", strokeWidth: 1, roughness: 0,
              label: { text: wrapText(r[ci] || " ", wrapAt[ci]), fontSize: fsz, fontFamily: font, strokeColor: textColor },
              groupIds: [groupId],
            });
            x += colW[ci];
          }
          y += rowH[ri];
        });
        if (item.id) byId.set(String(item.id), { box: { minX: x0, minY: y0, maxX: x0 + tw, maxY: y0 + th }, containerId: null });
        continue;
      }

      // ---------- small marks
      if (MARKS.has(shape)) {
        const ab = anchorBox(item);
        const near = !!item.near;
        const s = 22;
        const x = near ? ab.maxX + 10 : (ab.minX + ab.maxX) / 2 - s / 2;
        const y = near ? ab.minY - s / 2 : (ab.minY + ab.maxY) / 2 - s / 2;
        const ms = { roughness: 0, strokeWidth: 3, groupIds: [groupId] };
        if (shape === "check" || shape === "tick") push(lineSkel([[x, y + s * 0.55], [x + s * 0.35, y + s * 0.9], [x + s, y]], { ...ms, strokeColor: ink ? INK_COLOR : COLORS.green[0] }));
        else if (shape === "cross") {
          push(lineSkel([[x, y], [x + s, y + s]], { ...ms, strokeColor: ink ? INK_COLOR : COLORS.red[0] }));
          push(lineSkel([[x + s, y], [x, y + s]], { ...ms, strokeColor: ink ? INK_COLOR : COLORS.red[0] }));
        } else if (shape === "star") {
          const pts = Array.from({ length: 10 }, (_, i) => {
            const r = i % 2 ? s * 0.22 : s * 0.55, a = -Math.PI / 2 + (i * Math.PI) / 5;
            return [x + s / 2 + r * Math.cos(a), y + s / 2 + r * Math.sin(a)];
          });
          push(lineSkel(close(pts), { ...ms, strokeWidth: 2, strokeColor: ink ? INK_COLOR : COLORS.yellow[0], backgroundColor: ink ? "transparent" : COLORS.yellow[1], fillStyle: "solid" }));
        } else if (shape === "warning") {
          push(lineSkel(close([[x + s / 2, y - 2], [x + s + 3, y + s], [x - 3, y + s]]), { ...ms, strokeWidth: 2, strokeColor: ink ? INK_COLOR : COLORS.orange[0], backgroundColor: ink ? "transparent" : COLORS.yellow[1], fillStyle: "solid" }));
          push({ type: "text", x: x + s / 2 - 4, y: y + 2, text: "!", fontSize: 16, fontFamily: font, strokeColor: ink ? INK_COLOR : COLORS.orange[0], groupIds: [groupId] });
        } else if (shape === "number") {
          const t = String(item.text ?? "1").slice(0, 3);
          push({
            type: "ellipse", x: x - 4, y: y - 4, width: s + 8, height: s + 8, strokeColor: ink ? INK_COLOR : stroke === DEFAULT_STROKE ? COLORS.violet[0] : stroke,
            backgroundColor: ink ? "transparent" : fill === "transparent" ? COLORS.violet[1] : fill, fillStyle: "solid", strokeWidth: 2, roughness: 0,
            label: { text: t, fontSize: 16, fontFamily: font, strokeColor: textColor }, groupIds: [groupId],
          });
        }
        continue;
      }
    } catch (e) {
      console.warn("draw item failed", raw, e);
    }
  }

  const skels = [...back, ...front];
  let elements;
  try {
    elements = convertToExcalidrawElements(skels.map(([s]) => s), { regenerateIds: false });
  } catch (e) {
    console.warn("drawing conversion failed", e);
    return { elements: [], steps: [] };
  }
  // the title goes above whatever was drawn (curved arrows can rise above row 0)
  const titleEl = elements.find((e) => e.id.startsWith(`${prefix}-title-`));
  const rest = elements.filter((e) => e !== titleEl && !e.isDeleted);
  if (titleEl && rest.length) {
    const xs = rest.flatMap((e) => (e.points ? e.points.map((p) => e.x + p[0]) : [e.x]));
    const ys = rest.flatMap((e) => (e.points ? e.points.map((p) => e.y + p[1]) : [e.y]));
    elements = elements.map((e) => (e === titleEl ? { ...e, x: Math.min(...xs), y: Math.min(...ys) - e.height - 36 } : e));
  }
  // labels created by the converter belong to their container's group
  const groupsOf = new Map(elements.map((e) => [e.id, e.groupIds]));
  elements = elements.map((e) => (e.containerId && !e.groupIds?.length && groupsOf.get(e.containerId)?.length ? { ...e, groupIds: [...groupsOf.get(e.containerId)] } : e));
  // map bound texts (created by the converter for labels) to their container's step
  const stepOf = new Map();
  skels.forEach(([s, i]) => stepOf.set(s.id, i));
  const ordered = steps.map(() => []);
  for (const el of elements) {
    const i = stepOf.get(el.id) ?? stepOf.get(el.containerId);
    (ordered[i] || (ordered[i] = [])).push(el.id);
  }
  return { elements, steps: ordered.filter((s) => s && s.length) };
}

/**
 * Outline skeletons for a custom shape in the box (x, y, w, h): used to give
 * Mermaid nodes like [(DB)] or {{prep}} their real shape. The caller makes the
 * original rectangle transparent so it keeps the label and arrow bindings.
 */
export function outlineSkeletons(shape, x, y, w, h, style) {
  const fn = OUTLINES[ALIASES[shape] || shape];
  if (!fn) return [];
  return fn(w, h).map((p) =>
    p.ellipse
      ? { type: "ellipse", x: x + p.ellipse[0], y: y + p.ellipse[1], width: p.ellipse[2], height: p.ellipse[3], ...style }
      : lineSkel(p.pts.map(([px, py]) => [x + px, y + py]), { ...style, backgroundColor: p.open ? "transparent" : style.backgroundColor, roundness: p.round ? { type: ROUNDNESS.PROPORTIONAL_RADIUS } : null }),
  );
}

/** Text labels of a drawing (for the context picker). */
export const drawingLabels = (items) =>
  items
    .filter((i) => i && i.shape)
    .map((i) => i.text || i.label || (Array.isArray(i.rows) ? i.rows.flat().join(" ") : ""))
    .filter(Boolean)
    .join(" | ");
