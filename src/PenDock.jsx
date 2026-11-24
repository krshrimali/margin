import { useMemo, useRef, useState } from "react";
import { useDismiss } from "./store.js";
import { PenIcon } from "./icons.jsx";
import { EASINGS, PALETTE, PRESETS, nibPressures, outlinePath, penDescriptor } from "./pens.js";

// Sample "handwriting" curve for the live stroke preview.
const SAMPLE = (() => {
  const pts = [];
  for (let i = 0; i <= 120; i++) {
    const t = i / 120;
    pts.push([10 + t * 200, 30 + Math.sin(t * Math.PI * 3) * 16 - Math.cos(t * Math.PI * 7) * 4]);
  }
  return pts;
})();
const SAMPLE_PRESSURE = SAMPLE.map((_, i) => 0.25 + 0.7 * Math.sin((i / SAMPLE.length) * Math.PI));

function StrokePreview({ id, pen }) {
  const d = useMemo(() => {
    const desc = penDescriptor(id, pen);
    const pr = pen.kind === "nib" ? nibPressures(SAMPLE, pen, SAMPLE_PRESSURE) : pen.kind === "uniform" ? SAMPLE.map(() => 0.5) : SAMPLE_PRESSURE;
    return outlinePath(SAMPLE, pr, desc, false, true);
  }, [id, pen]);
  return (
    <svg className="stroke-preview" viewBox="0 0 220 60">
      <path d={d} fill={pen.color} fillOpacity={pen.opacity / 100} />
    </svg>
  );
}

function Slider({ label, value, min, max, step = 1, onChange, suffix = "" }) {
  return (
    <label className="row">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <output>{Number.isInteger(step) ? value : value.toFixed(2)}{suffix}</output>
    </label>
  );
}

export default function PenDock({ settings, penId, active, onPick, onChange, stylusOnly, setStylusOnly, onReset }) {
  const [open, setOpen] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const panelRef = useRef(null);
  useDismiss("pens", open, () => setOpen(false), { ref: panelRef, keep: [".pen-buttons"] });
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("whiteboard.dock.collapsed") === "1");
  const toggleCollapsed = () => {
    setCollapsed((c) => {
      localStorage.setItem("whiteboard.dock.collapsed", c ? "0" : "1");
      return !c;
    });
    setOpen(false);
  };
  const pen = settings[penId];
  const set = (patch) => onChange(penId, { ...pen, ...patch });

  return (
    <div className={`pen-dock ${collapsed ? "collapsed" : ""}`}>
      <div className="pen-buttons">
        <button className="pen-btn collapse" title={collapsed ? "Show all pens" : "Collapse pens"} onClick={toggleCollapsed}>
          {collapsed ? "‹" : "›"}
        </button>
        {Object.keys(PRESETS).filter((id) => !collapsed || id === penId).map((id) => (
          <button
            key={id}
            className={`pen-btn ${active && penId === id ? "active" : ""}`}
            title={`${settings[id].label}  (Alt+${Object.keys(PRESETS).indexOf(id) + 1})`}
            onClick={() => {
              if (active && penId === id) setOpen((o) => !o);
              onPick(id);
            }}
          >
            <PenIcon id={id} />
            <span className="pen-swatch" style={{ background: settings[id].color, opacity: Math.max(0.35, settings[id].opacity / 100) }} />
          </button>
        ))}
        {!collapsed && (
          <button className={`pen-btn gear ${open ? "active" : ""}`} title="Pen settings" onClick={() => setOpen((o) => !o)}>⚙</button>
        )}
      </div>

      {open && (
        <div className="pen-panel" ref={panelRef}>
          <div className="pen-panel-title">
            <span className="title-l"><PenIcon id={penId} size={16} /> {pen.label}</span>
            <button className="link" onClick={() => onReset(penId)} title="Reset this pen to defaults">reset</button>
          </div>
          <StrokePreview id={penId} pen={pen} />

          <div className="swatches">
            {PALETTE.map((c) => (
              <button key={c} className={`swatch ${pen.color === c ? "sel" : ""}`} style={{ background: c }} onClick={() => set({ color: c })} />
            ))}
            <input type="color" value={pen.color} onChange={(e) => set({ color: e.target.value })} title="Custom colour" />
          </div>

          <Slider label="Size" value={pen.size} min={0.5} max={48} step={0.5} onChange={(v) => set({ size: v })} />
          <Slider label="Opacity" value={pen.opacity} min={5} max={100} onChange={(v) => set({ opacity: v })} suffix="%" />

          {pen.kind === "nib" && (
            <>
              <Slider label="Nib angle" value={pen.nibAngle} min={0} max={180} onChange={(v) => set({ nibAngle: v })} suffix="°" />
              <Slider label="Hairline" value={pen.nibMin} min={0.02} max={0.8} step={0.01} onChange={(v) => set({ nibMin: v })} />
              <Slider label="Pressure mix" value={pen.pressureInfluence} min={0} max={1} step={0.05} onChange={(v) => set({ pressureInfluence: v })} />
            </>
          )}

          <label className="row">
            <span>Width model</span>
            <select value={pen.kind} onChange={(e) => set({ kind: e.target.value, nibAngle: pen.nibAngle ?? 40, nibMin: pen.nibMin ?? 0.12, pressureInfluence: pen.pressureInfluence ?? 0.3 })}>
              <option value="pressure">Pressure</option>
              <option value="nib">Broad nib (calligraphy)</option>
              <option value="uniform">Uniform</option>
            </select>
          </label>

          <button className="link" onClick={() => setAdvanced((a) => !a)}>{advanced ? "▾" : "▸"} Advanced</button>
          {advanced && (
            <>
              {pen.kind !== "uniform" && (
                <Slider label="Thinning" value={pen.thinning} min={-1} max={1} step={0.05} onChange={(v) => set({ thinning: v })} />
              )}
              <Slider label="Smoothing" value={pen.smoothing} min={0} max={1} step={0.05} onChange={(v) => set({ smoothing: v })} />
              <Slider label="Stabilizer" value={pen.streamline} min={0} max={0.99} step={0.01} onChange={(v) => set({ streamline: v })} />
              <Slider label="Taper start" value={pen.taperStart} min={0} max={150} onChange={(v) => set({ taperStart: v })} />
              <Slider label="Taper end" value={pen.taperEnd} min={0} max={150} onChange={(v) => set({ taperEnd: v })} />
              <label className="row">
                <span>Easing</span>
                <select value={pen.easing} onChange={(e) => set({ easing: e.target.value })}>
                  {Object.keys(EASINGS).map((k) => <option key={k}>{k}</option>)}
                </select>
              </label>
              <label className="row check">
                <input type="checkbox" checked={!!pen.flatCaps} onChange={(e) => set({ flatCaps: e.target.checked })} />
                <span>Flat caps</span>
              </label>
              {pen.kind === "pressure" && (
                <label className="row check">
                  <input type="checkbox" checked={!!pen.simulateWithMouse} onChange={(e) => set({ simulateWithMouse: e.target.checked })} />
                  <span>Simulate pressure from speed (mouse)</span>
                </label>
              )}
            </>
          )}
          <hr />
          <label className="row check">
            <input type="checkbox" checked={stylusOnly} onChange={(e) => setStylusOnly(e.target.checked)} />
            <span>Stylus draws, fingers pan (palm rejection)</span>
          </label>
        </div>
      )}
    </div>
  );
}
