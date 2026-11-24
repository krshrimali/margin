// Tiny observable stores shared by the overlay UI (comments, picked context, preferences).
import { useSyncExternalStore } from "react";

export function createStore(initial) {
  let state = initial;
  const subs = new Set();
  return {
    get: () => state,
    set(next) {
      state = typeof next === "function" ? next(state) : next;
      subs.forEach((f) => f(state));
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

export const useStore = (store) => useSyncExternalStore(store.subscribe, store.get);

const LS = {
  get: (k, d) => {
    try {
      const v = localStorage.getItem(k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
};
export { LS };

// Model and effort start at Claude Code's default on every load; the edit mode and cost cap are remembered.
// `steps` (walk me through it) applies to the next ask only.
export const prefs = createStore({
  model: "", effort: "", editMode: LS.get("whiteboard.editMode", "auto"), maxBudget: LS.get("whiteboard.maxBudget", 0), steps: false,
});
prefs.subscribe((p) => {
  LS.set("whiteboard.editMode", p.editMode);
  LS.set("whiteboard.maxBudget", p.maxBudget);
});
/** The per-ask options from the pickers; clears the one-shot "step by step" toggle. */
export function takeAskPrefs() {
  const p = prefs.get();
  if (p.steps) prefs.set((s) => ({ ...s, steps: false }));
  return { model: p.model, effort: p.effort, editMode: p.editMode, maxBudget: Number(p.maxBudget) || 0, steps: p.steps };
}

/** Picked context: element groups picked from anywhere on the board, asked about together. */
export const picks = createStore([]); // [{ id, elementIds, label }]

/**
 * Comment threads, saved with the board.
 * { id, elementIds, anchor:{x,y}, label, createdAt, resolved,
 *   messages:[{ id, author:"user"|"claude", text, at, model?, effort?, status?, pending?, error?, drew?, proposalId? }],
 *   sessionId?, engine?, cwd? }
 */
export const comments = createStore([]);
export const ui = createStore({ openThread: null, panel: false, showResolved: false, askOpen: 0, selAsk: 0, palette: false });

export const rid = () => Math.random().toString(36).slice(2, 10);

export function updateThread(id, fn) {
  comments.set((list) => list.map((t) => (t.id === id ? fn(t) : t)));
}
export function updateMessage(threadId, msgId, patch) {
  updateThread(threadId, (t) => ({ ...t, messages: t.messages.map((m) => (m.id === msgId ? { ...m, ...patch } : m)) }));
}
