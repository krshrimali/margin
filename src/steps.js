// Step-by-step walkthroughs: a drawing whose items carry customData.step is played
// one step at a time, with Claude's narration for each step. Hidden steps are made
// transparent without touching undo history, and saving always writes them visible.
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { createStore } from "./store.js";

export const player = createStore(null); // { askId, steps:[{step, say}], index }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bump = (e, patch) => ({ ...e, ...patch, version: (e.version || 1) + 1, versionNonce: Math.floor(Math.random() * 2 ** 31) });

/** Walkthroughs on the board: askId -> narration (stored on the drawing's elements). */
export function walkthroughs(api) {
  const out = new Map();
  for (const e of api.getSceneElements()) {
    const n = e.customData?.narration;
    if (Array.isArray(n) && n.length && e.customData.askId) out.set(e.customData.askId, n);
  }
  return out;
}

export const hasSteps = (els) => els.find((e) => e.customData?.askId && (e.customData.step > 0 || e.customData.narration))?.customData.askId || null;

function setVisible(api, askId, upTo, animateStep = null) {
  const els = api.getSceneElementsIncludingDeleted();
  const next = els.map((e) => {
    const cd = e.customData;
    if (!cd || cd.askId !== askId || !(cd.step > 0) || e.isDeleted) return e;
    const hide = cd.step > upTo;
    if (hide && cd.stepHidden == null) return bump(e, { opacity: 0, customData: { ...cd, stepHidden: e.opacity ?? 100 } });
    if (!hide && cd.stepHidden != null) {
      const { stepHidden, ...rest } = cd;
      return bump(e, { opacity: cd.step === animateStep ? Math.round(stepHidden * 0.15) : stepHidden, customData: { ...rest, stepFull: stepHidden } });
    }
    return e;
  });
  api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.NEVER });
}

/** Fade the just-revealed step in. */
async function fadeIn(api, askId, step) {
  for (const k of [0.4, 0.7, 1]) {
    await sleep(45);
    api.updateScene({
      elements: api.getSceneElementsIncludingDeleted().map((e) => {
        const cd = e.customData;
        if (!cd || cd.askId !== askId || cd.step !== step || cd.stepFull == null) return e;
        if (k === 1) {
          const { stepFull, ...rest } = cd;
          return bump(e, { opacity: stepFull, customData: rest });
        }
        return bump(e, { opacity: Math.round(cd.stepFull * k) });
      }),
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }
}

export function startWalkthrough(api, askId) {
  const n = walkthroughs(api).get(askId);
  if (!n) return false;
  player.set({ askId, steps: n, index: 0 });
  setVisible(api, askId, n[0].step, n[0].step);
  fadeIn(api, askId, n[0].step);
  const els = api.getSceneElements().filter((e) => e.customData?.askId === askId && e.customData.role === "diagram");
  if (els.length) api.scrollToContent(els, { animate: true, fitToViewport: true, viewportZoomFactor: 0.8 });
  return true;
}

export function goToStep(api, index) {
  const p = player.get();
  if (!p) return;
  const i = Math.max(0, Math.min(p.steps.length - 1, index));
  const forward = i > p.index;
  player.set({ ...p, index: i });
  setVisible(api, p.askId, p.steps[i].step, forward ? p.steps[i].step : null);
  if (forward) fadeIn(api, p.askId, p.steps[i].step);
}

/** Show everything again and close the player. */
export function endWalkthrough(api) {
  const p = player.get();
  if (!p) return;
  setVisible(api, p.askId, Infinity);
  // clear any half-finished fade
  api.updateScene({
    elements: api.getSceneElementsIncludingDeleted().map((e) => {
      const cd = e.customData;
      if (!cd || cd.askId !== p.askId || cd.stepFull == null) return e;
      const { stepFull, ...rest } = cd;
      return bump(e, { opacity: stepFull, customData: rest });
    }),
    captureUpdate: CaptureUpdateAction.NEVER,
  });
  player.set(null);
}

/** For saving: elements as they look with every step shown. */
export const withAllSteps = (elements) =>
  elements.map((e) => {
    const cd = e.customData;
    if (!cd || (cd.stepHidden == null && cd.stepFull == null)) return e;
    const { stepHidden, stepFull, ...rest } = cd;
    return { ...e, opacity: stepHidden ?? stepFull, customData: rest };
  });
