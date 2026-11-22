import { useEffect, useRef } from "react";
import { CaptureUpdateAction, viewportCoordsToSceneCoords } from "@excalidraw/excalidraw";
import { makeFreedraw, nibPressures, outlinePath, penDescriptor } from "./pens.js";


/**
 * Captures pointer input while the custom "pen" tool is active, draws a live
 * preview on an overlay canvas, then commits a native Excalidraw freedraw
 * element tagged with the pen settings.
 */
export default function PenInput({ api, active, penId, pen, stylusOnly }) {
  const canvasRef = useRef(null);
  const state = useRef({ stroke: null, raf: 0, space: false });
  const props = useRef({});
  props.current = { api, active, penId, pen, stylusOnly };

  useEffect(() => {
    const st = state.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
    };
    resize();

    const clear = () => ctx.clearRect(0, 0, canvas.width, canvas.height);

    const draw = () => {
      st.raf = 0;
      const s = st.stroke;
      clear();
      if (!s || s.points.length < 1) return;
      const { zoom, scrollX, scrollY, offsetLeft, offsetTop } = props.current.api.getAppState();
      const dpr = window.devicePixelRatio || 1;
      const z = zoom.value;
      ctx.setTransform(z * dpr, 0, 0, z * dpr, ((scrollX * z) + offsetLeft) * dpr, ((scrollY * z) + offsetTop) * dpr);
      ctx.globalAlpha = s.pen.opacity / 100;
      ctx.fillStyle = s.pen.color;
      ctx.fill(new Path2D(outlinePath(s.points, pressuresFor(s), s.desc, s.simulate, false)));
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
    };
    const schedule = () => { if (!st.raf) st.raf = requestAnimationFrame(draw); };

    const pressuresFor = (s) => (s.pen.kind === "nib" ? nibPressures(s.points, s.pen, s.hasPressure ? s.pressures : null) : s.pressures);

    const toScene = (e) => {
      const { x, y } = viewportCoordsToSceneCoords({ clientX: e.clientX, clientY: e.clientY }, props.current.api.getAppState());
      return [x, y];
    };

    const addPoint = (e) => {
      const s = st.stroke;
      const p = toScene(e);
      const last = s.points[s.points.length - 1];
      const minDist = 0.4 / props.current.api.getAppState().zoom.value;
      if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < minDist) return;
      s.points.push(p);
      s.pressures.push(s.hasPressure ? Math.max(0.05, e.pressure) : 0.5);
    };

    const isCanvasTarget = (e) =>
      e.target instanceof HTMLCanvasElement && e.target.closest(".excalidraw") && !e.target.closest(".layer-ui__wrapper");

    const onDown = (e) => {
      const { api, active, stylusOnly, pen, penId } = props.current;
      if (!api || !active || st.stroke || e.button !== 0 || st.space || !isCanvasTarget(e)) return;
      if (stylusOnly && e.pointerType === "touch") return; // let fingers pan/zoom
      e.stopPropagation();
      e.preventDefault();
      if (!document.activeElement?.closest?.(".excalidraw-container")) document.querySelector(".excalidraw-container")?.focus({ preventScroll: true });
      const hasPressure = e.pointerType === "pen" && e.pressure > 0;
      const simulate = !hasPressure && pen.kind === "pressure" && !!pen.simulateWithMouse;
      st.stroke = { id: e.pointerId, pen: { ...pen }, desc: penDescriptor(penId, pen), points: [], pressures: [], hasPressure, simulate };
      addPoint(e);
      schedule();
    };

    const onMove = (e) => {
      const s = st.stroke;
      if (!s || e.pointerId !== s.id) return;
      e.stopPropagation();
      e.preventDefault();
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of evs.length ? evs : [e]) addPoint(ev);
      schedule();
    };

    const onUp = (e) => {
      const s = st.stroke;
      if (!s || e.pointerId !== s.id) return;
      e.stopPropagation();
      e.preventDefault();
      st.stroke = null;
      commit(s);
      // keep preview until Excalidraw has painted the committed stroke
      requestAnimationFrame(() => requestAnimationFrame(clear));
    };

    const commit = (s) => {
      const { api } = props.current;
      if (!s.points.length) return;
      const el = makeFreedraw({
        points: s.points,
        pressures: pressuresFor(s),
        desc: s.desc,
        color: s.pen.color,
        opacity: s.pen.opacity,
        simulatePressure: s.simulate,
      });
      api.updateScene({
        elements: [...api.getSceneElementsIncludingDeleted(), el],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    };

    const onKey = (e) => {
      if (e.code === "Space") st.space = e.type === "keydown";
    };

    const opts = { capture: true, passive: false };
    window.addEventListener("pointerdown", onDown, opts);
    window.addEventListener("pointermove", onMove, opts);
    window.addEventListener("pointerup", onUp, opts);
    window.addEventListener("pointercancel", onUp, opts);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("pointerdown", onDown, opts);
      window.removeEventListener("pointermove", onMove, opts);
      window.removeEventListener("pointerup", onUp, opts);
      window.removeEventListener("pointercancel", onUp, opts);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      window.removeEventListener("resize", resize);
      if (st.raf) cancelAnimationFrame(st.raf);
    };
  }, []);

  return <canvas ref={canvasRef} className="pen-preview" />;
}
