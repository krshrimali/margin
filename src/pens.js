import { getStroke } from "perfect-freehand";

// ---------------------------------------------------------------------------
// Pen presets. Every stroke stores its pen in element.customData.pen, and the
// patched Excalidraw renderer (scripts/patch-excalidraw.mjs) asks
// globalThis.__penOptions for the perfect-freehand options, so strokes keep
// their look after save/load/export.
// ---------------------------------------------------------------------------

export const EASINGS = {
  linear: (t) => t,
  easeOutSine: (t) => Math.sin((t * Math.PI) / 2),
  easeInSine: (t) => 1 - Math.cos((t * Math.PI) / 2),
  easeOutQuad: (t) => t * (2 - t),
  easeInOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  easeOutCubic: (t) => 1 - Math.pow(1 - t, 3),
};

// kind:
//   "pressure" - width follows stylus pressure (or simulated from speed with a mouse)
//   "nib"      - broad-edge calligraphy nib: width follows stroke direction vs nib angle
//   "uniform"  - constant width
export const PRESETS = {
  ballpoint: {
    label: "Ballpoint", kind: "pressure",
    color: "#1e1e1e", size: 2.6, opacity: 100,
    thinning: 0.2, smoothing: 0.6, streamline: 0.45, easing: "linear",
    taperStart: 0, taperEnd: 0, simulateWithMouse: false,
  },
  fineliner: {
    label: "Fineliner", kind: "uniform",
    color: "#1e1e1e", size: 2, opacity: 100,
    thinning: 0, smoothing: 0.5, streamline: 0.5, easing: "linear",
    taperStart: 0, taperEnd: 0, simulateWithMouse: false,
  },
  fountain: {
    label: "Fountain pen", kind: "pressure",
    color: "#1c3d8c", size: 4.5, opacity: 100,
    thinning: 0.65, smoothing: 0.62, streamline: 0.5, easing: "easeOutSine",
    taperStart: 6, taperEnd: 18, simulateWithMouse: true,
  },
  calligraphy: {
    label: "Calligraphy nib", kind: "nib",
    color: "#111111", size: 9, opacity: 100,
    thinning: 0.9, smoothing: 0.55, streamline: 0.4, easing: "linear",
    taperStart: 0, taperEnd: 0, nibAngle: 40, nibMin: 0.12, pressureInfluence: 0.35,
  },
  brush: {
    label: "Brush", kind: "pressure",
    color: "#1e1e1e", size: 12, opacity: 100,
    thinning: 0.8, smoothing: 0.7, streamline: 0.55, easing: "easeOutCubic",
    taperStart: 25, taperEnd: 60, simulateWithMouse: true,
  },
  pencil: {
    label: "Pencil", kind: "pressure",
    color: "#343a40", size: 1.8, opacity: 78,
    thinning: 0.35, smoothing: 0.5, streamline: 0.3, easing: "linear",
    taperStart: 2, taperEnd: 4, simulateWithMouse: false,
  },
  marker: {
    label: "Marker", kind: "uniform",
    color: "#e03131", size: 8, opacity: 92,
    thinning: 0, smoothing: 0.5, streamline: 0.6, easing: "linear",
    taperStart: 0, taperEnd: 0, simulateWithMouse: false,
  },
  highlighter: {
    label: "Highlighter", kind: "uniform",
    color: "#fcc419", size: 22, opacity: 35,
    thinning: 0, smoothing: 0.6, streamline: 0.7, easing: "linear",
    taperStart: 0, taperEnd: 0, flatCaps: true, simulateWithMouse: false,
  },
};

export const PALETTE = [
  "#1e1e1e", "#495057", "#1c3d8c", "#1971c2", "#0c8599", "#2f9e44",
  "#e8590c", "#e03131", "#c2255c", "#9c36b5", "#fcc419", "#ffffff",
];

const LS_KEY = "whiteboard.pens.v1";

export function loadPenSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
    const out = {};
    for (const [id, p] of Object.entries(PRESETS)) out[id] = { ...p, ...(saved[id] || {}) };
    return out;
  } catch {
    return structuredClone(PRESETS);
  }
}

export function savePenSettings(settings) {
  localStorage.setItem(LS_KEY, JSON.stringify(settings));
}

/** The compact pen descriptor stored on each stroke. */
export function penDescriptor(id, p) {
  return {
    preset: id,
    kind: p.kind,
    size: p.size,
    thinning: p.kind === "uniform" ? 0 : p.thinning,
    smoothing: p.smoothing,
    streamline: p.streamline,
    easing: p.easing,
    taperStart: p.taperStart || 0,
    taperEnd: p.taperEnd || 0,
    flatCaps: !!p.flatCaps,
  };
}

export function strokeOptions(pen, { simulatePressure = false, last = true } = {}) {
  return {
    size: pen.size,
    thinning: pen.thinning,
    smoothing: pen.smoothing,
    streamline: pen.streamline,
    easing: EASINGS[pen.easing] || EASINGS.linear,
    simulatePressure,
    start: { taper: pen.taperStart, cap: !pen.flatCaps },
    end: { taper: pen.taperEnd, cap: !pen.flatCaps },
    last,
  };
}

// Hook consumed by the patched Excalidraw freedraw renderer.
globalThis.__penOptions = (element, defaults) => {
  const pen = element.customData?.pen;
  if (!pen) return defaults;
  return strokeOptions(pen, { simulatePressure: element.simulatePressure, last: defaults.last });
};

/**
 * Broad-edge nib: a flat nib held at `nibAngle` is thickest when moving
 * perpendicular to the nib and thinnest when moving along it.
 * Returns per-point "pressures" fed to perfect-freehand (with high thinning).
 */
export function nibPressures(points, pen, realPressures) {
  const n = points.length;
  const out = new Array(n);
  const a = (pen.nibAngle * Math.PI) / 180;
  const nx = Math.cos(a);
  const ny = -Math.sin(a); // screen y points down
  const W = 3; // direction smoothing window
  let prev = 1;
  for (let i = 0; i < n; i++) {
    const p0 = points[Math.max(0, i - W)];
    const p1 = points[Math.min(n - 1, i + W)];
    const dx = p1[0] - p0[0];
    const dy = p1[1] - p0[1];
    const len = Math.hypot(dx, dy);
    let w;
    if (len < 1e-6) w = prev;
    else {
      // |cross(direction, nib)| = |sin(angle between)|
      const s = Math.abs((dx * ny - dy * nx) / len);
      w = pen.nibMin + (1 - pen.nibMin) * s;
    }
    prev = w;
    const rp = realPressures ? realPressures[i] : 0.5;
    const pi = pen.pressureInfluence ?? 0;
    out[i] = Math.max(0.02, Math.min(1, w * (1 - pi + pi * rp * 2)));
  }
  return out;
}

export function outlinePath(points, pressures, pen, simulatePressure, last) {
  const input = simulatePressure ? points : points.map(([x, y], i) => [x, y, pressures[i]]);
  return svgPathFromStroke(getStroke(input, strokeOptions(pen, { simulatePressure, last })));
}

function svgPathFromStroke(pts) {
  if (!pts.length) return "";
  const d = pts.reduce(
    (acc, [x0, y0], i, arr) => {
      const [x1, y1] = arr[(i + 1) % arr.length];
      acc.push(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
      return acc;
    },
    ["M", ...pts[0], "Q"],
  );
  d.push("Z");
  return d.join(" ");
}

const rid = () => Math.random().toString(36).slice(2, 12);
const seed31 = () => Math.floor(Math.random() * 2 ** 31);

/**
 * Build a native Excalidraw freedraw element from absolute scene points.
 * Used by the pen tool and by Claude's ink.
 */
export function makeFreedraw({ points, pressures, desc, color, opacity = 100, simulatePressure = false, customData = {}, groupIds = [] }) {
  const pts = points.length === 1 ? [points[0], [points[0][0] + 0.1, points[0][1] + 0.1]] : points;
  const prs = pressures && pressures.length === points.length && points.length > 1 ? pressures : pts.map((_, i) => pressures?.[i] ?? pressures?.[0] ?? 0.5);
  const [ox, oy] = pts[0];
  const rel = pts.map(([x, y]) => [x - ox, y - oy]);
  const xs = rel.map((p) => p[0]);
  const ys = rel.map((p) => p[1]);
  return {
    id: rid(),
    type: "freedraw",
    x: ox,
    y: oy,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    angle: 0,
    strokeColor: color,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: Math.max(0.5, desc.size / 4.25),
    strokeStyle: "solid",
    roughness: 0,
    opacity,
    groupIds,
    frameId: null,
    index: null,
    roundness: null,
    seed: seed31(),
    version: 1,
    versionNonce: seed31(),
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
    points: rel,
    pressures: simulatePressure ? [] : prs,
    simulatePressure,
    lastCommittedPoint: rel[rel.length - 1],
    customData: { ...customData, pen: desc },
  };
}
