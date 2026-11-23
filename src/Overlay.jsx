// Overlay UI that sits on top of the canvas and follows it as you pan and zoom:
//   - SelectionBar: Comment / Ask / Pick buttons above whatever is selected
//   - pick highlights + ContextTray: context picked from several places, asked about together
//   - comment pins, ThreadPopover and CommentsPanel: comments on any element, answered by Claude on request
//   - ProposalsPanel: edits Claude proposes when edits are set to "Ask first"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getCommonBounds, getSceneVersion } from "@excalidraw/excalidraw";
import { askClaude, cancelAsk, onRunningChange, MODELS, EFFORTS, EDIT_MODES, onProposalsChange, applyProposal, discardProposal, previewProposal, proposalTargets } from "./claude.js";
import { comments, picks, prefs, ui, rid, updateThread, updateMessage, useStore, LS } from "./store.js";

// ------------------------------------------------------------ viewport ----
/** Re-render on pan, zoom, selection and element changes (throttled to animation frames). */
export function useView(api) {
  const [view, setView] = useState(null);
  useEffect(() => {
    if (!api) return;
    let raf = 0;
    let last = "";
    const read = () => {
      raf = 0;
      const a = api.getAppState();
      const els = api.getSceneElements();
      const sel = Object.keys(a.selectedElementIds || {}).filter((k) => a.selectedElementIds[k]);
      const key = [a.scrollX, a.scrollY, a.zoom.value, a.width, a.height, getSceneVersion(els), sel.join(","), !!a.selectedElementsAreBeingDragged, !!a.resizingElement, !!a.editingTextElement, !!a.newElement, a.activeTool?.type, a.theme, a.openDialog?.name || ""].join("|");
      if (key === last) return;
      last = key;
      setView({ a, sel, els });
    };
    read();
    const off = api.onChange(() => {
      if (!raf) raf = requestAnimationFrame(read);
    });
    return () => {
      off?.();
      cancelAnimationFrame(raf);
    };
  }, [api]);
  return view;
}

const toScreen = (a, x, y) => [(x + a.scrollX) * a.zoom.value + (a.offsetLeft || 0), (y + a.scrollY) * a.zoom.value + (a.offsetTop || 0)];
const boundsOf = (els) => {
  const [minX, minY, maxX, maxY] = getCommonBounds(els);
  return { minX, minY, maxX, maxY };
};
/** Elements by id, with their bound labels and group members. */
function withFamily(ids, els) {
  const set = new Set(ids);
  const groups = new Set(els.filter((e) => set.has(e.id)).flatMap((e) => e.groupIds || []));
  return els.filter((e) => !e.isDeleted && (set.has(e.id) || (e.containerId && set.has(e.containerId)) || e.groupIds?.some((g) => groups.has(g))));
}
function screenBox(a, els) {
  if (!els.length) return null;
  const b = boundsOf(els);
  const [x0, y0] = toScreen(a, b.minX, b.minY);
  const [x1, y1] = toScreen(a, b.maxX, b.maxY);
  return { x0, y0, x1, y1 };
}

/** A short name for a set of elements: their text, else what they are. */
export function describe(els) {
  const text = els.find((e) => e.type === "text" && e.text?.trim() && !e.customData?.role?.startsWith?.("header"));
  if (text) {
    const t = text.text.replace(/\s+/g, " ").trim();
    return t.length > 40 ? t.slice(0, 40) + "…" : t;
  }
  if (els.some((e) => e.customData?.claude)) return "Claude's answer";
  const kinds = [...new Set(els.map((e) => ({ freedraw: "sketch", arrow: "arrow", line: "line", rectangle: "box", ellipse: "ellipse", diamond: "diamond", image: "image", frame: "frame" })[e.type] || e.type))];
  return kinds.length === 1 ? (els.length > 1 ? `${els.length} ${kinds[0]}${kinds[0].endsWith("h") ? "es" : "s"}` : kinds[0]) : `${els.length} items`;
}

const ago = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return new Date(t).toLocaleDateString();
};

const cwdFor = (board) => LS.get(`whiteboard.cwd.${board}`, "");

// ------------------------------------------------------------- options ----
/** Model · effort · edits pickers. Model and effort apply to this answer only and default to Claude's own default. */
export function AskOptions({ compact = false }) {
  const p = useStore(prefs);
  const set = (k) => (e) => prefs.set((s) => ({ ...s, [k]: e.target.value }));
  return (
    <div className={`ask-options ${compact ? "compact" : ""}`}>
      <label title="Model for this answer. Default = Claude Code's default model.">
        <span>Model</span>
        <select value={p.model} onChange={set("model")}>
          {MODELS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </label>
      <label title="How hard Claude thinks. Default = Claude Code's default effort.">
        <span>Effort</span>
        <select value={p.effort} onChange={set("effort")}>
          {EFFORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </label>
      <label title={EDIT_MODES[p.editMode]?.[1]}>
        <span>Edits</span>
        <select value={p.editMode} onChange={set("editMode")}>
          {Object.entries(EDIT_MODES).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </label>
    </div>
  );
}

/** Text box + options + send. Ctrl/Cmd+Enter sends; Esc cancels. */
function Composer({ placeholder, onSend, onCancel, autoFocus = true, actions, initial = "", busy = false }) {
  const [text, setText] = useState(initial);
  const ref = useRef(null);
  useEffect(() => { if (autoFocus) ref.current?.focus(); }, [autoFocus]);
  const send = (withClaude) => {
    if (!text.trim() && !withClaude) return;
    onSend(text.trim(), withClaude);
    setText("");
  };
  return (
    <div className="composer" onKeyDown={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      <textarea
        ref={ref}
        value={text}
        placeholder={placeholder}
        rows={2}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(actions === "comment" ? /@claude\b/i.test(text) || e.shiftKey : true); }
          if (e.key === "Escape") onCancel?.();
        }}
      />
      <AskOptions compact />
      <div className="composer-actions">
        {actions === "comment" ? (
          <>
            <span className="hint-inline">Mention <b>@claude</b> or use the button to get a reply</span>
            <button className="btn ghost" disabled={!text.trim()} onClick={() => send(/@claude\b/i.test(text))} title="Post (Ctrl+Enter)">Comment</button>
            <button className="btn claude" disabled={busy} onClick={() => send(true)} title="Post and ask Claude to reply (Ctrl+Shift+Enter)">✦ Ask Claude</button>
          </>
        ) : (
          <>
            {onCancel && <button className="btn ghost" onClick={onCancel}>Cancel</button>}
            <button className="btn claude" onClick={() => send(true)}>✦ Ask <kbd>Ctrl+⏎</kbd></button>
          </>
        )}
      </div>
    </div>
  );
}

// -------------------------------------------------------- comment logic ---
function newThread(api, elementIds) {
  const els = withFamily(elementIds, api.getSceneElements());
  const b = boundsOf(els);
  const t = { id: rid(), elementIds, anchor: { x: b.maxX, y: b.minY }, label: describe(els), createdAt: Date.now(), resolved: false, messages: [], draft: true };
  comments.set((l) => [...l, t]);
  ui.set((u) => ({ ...u, openThread: t.id }));
  return t;
}

/** Post a message; with `ask`, Claude replies in the thread (and draws/edits on the board if asked). */
export function postInThread(api, board, threadId, text, ask) {
  const thread = comments.get().find((t) => t.id === threadId);
  if (!thread) return;
  const user = text ? { id: rid(), author: "user", text, at: Date.now() } : null;
  const msgs = user ? [...thread.messages, user] : thread.messages;
  if (!ask) {
    updateThread(threadId, (t) => ({ ...t, draft: false, messages: msgs }));
    return;
  }
  const p = prefs.get();
  const reply = { id: rid(), author: "claude", text: "", at: Date.now(), pending: true, status: "Looking at the board…", model: p.model, effort: p.effort };
  updateThread(threadId, (t) => ({ ...t, draft: false, resolved: false, messages: [...msgs, reply] }));
  const question = text || "Please look at this and reply.";
  askClaude(api, {
    question,
    cwd: cwdFor(board),
    model: p.model,
    effort: p.effort,
    editMode: p.editMode,
    thread: { ...thread, messages: msgs.length ? msgs : [{ author: "user", text: question }] },
    reply: {
      status: (s) => updateMessage(threadId, reply.id, { status: s }),
      delta: (a) => updateMessage(threadId, reply.id, { text: a, status: "" }),
      done: (d) => {
        updateMessage(threadId, reply.id, {
          text: d.answer, pending: false, status: "", model: d.model || p.model, effort: d.effort, drew: d.drew, inked: d.inked,
          proposalId: d.proposalId, edited: d.edited, durationMs: d.durationMs, engine: d.engine, askId: d.askId,
        });
        updateThread(threadId, (t) => ({ ...t, sessionId: d.sessionId || t.sessionId, engine: d.engine, cwd: d.cwd }));
      },
      error: (msg) => updateMessage(threadId, reply.id, { pending: false, status: "", error: msg, text: "" }),
    },
  }).catch((e) => updateMessage(threadId, reply.id, { pending: false, error: e.message }));
}

// --------------------------------------------------------- SelectionBar ---
export function SelectionBar({ api, view, board, onAsk }) {
  const pickList = useStore(picks);
  const u = useStore(ui);
  const [asking, setAsking] = useState(false);
  const selKey = view?.sel.join(",");
  useEffect(() => setAsking(false), [selKey]);
  if (!view) return null;
  const { a, sel, els } = view;
  const busy = a.selectedElementsAreBeingDragged || a.resizingElement || a.editingTextElement || a.newElement || a.openDialog;
  const selected = withFamily(sel, els).filter((e) => !e.customData?.claudePending);
  if (u.openThread && !asking) return null;
  if (!sel.length || busy || !selected.length || (a.activeTool?.type !== "selection" && !asking)) return null;
  const box = screenBox(a, selected);
  if (!box) return null;
  const ids = sel;
  const pickedAlready = pickList.find((p) => p.elementIds.length === ids.length && p.elementIds.every((i) => ids.includes(i)));
  const top = box.y0 - 52 < 70 ? box.y1 + 12 : box.y0 - 52;
  const left = Math.max(8, Math.min(window.innerWidth - (asking ? 420 : 300), (box.x0 + box.x1) / 2 - (asking ? 210 : 140)));

  const comment = () => newThread(api, ids);
  const togglePick = () => {
    if (pickedAlready) picks.set((l) => l.filter((p) => p !== pickedAlready));
    else picks.set((l) => [...l, { id: rid(), elementIds: ids, label: describe(selected) }]);
  };
  return (
    <div className={`sel-bar ${asking ? "asking" : ""}`} style={{ left, top }} onPointerDown={(e) => e.stopPropagation()}>
      {!asking ? (
        <>
          <button onClick={comment} title="Comment on the selection (Alt+C)"><span className="ic">💬</span> Comment</button>
          <button onClick={() => setAsking(true)} title="Ask Claude about the selection"><span className="ic claude-ic">✦</span> Ask</button>
          <button onClick={togglePick} className={pickedAlready ? "on" : ""} title="Add to the context tray, then pick more from anywhere on the board (Alt+P)">
            <span className="ic">{pickedAlready ? "✓" : "＋"}</span> {pickedAlready ? "Picked" : "Pick"}
          </button>
        </>
      ) : (
        <div className="sel-ask">
          <div className="sel-ask-title">Ask about <b>{describe(selected)}</b>{pickList.length ? ` + ${pickList.length} picked` : ""}</div>
          <Composer
            placeholder="What do you want to know or change? e.g. “explain this”, “make it colourful”, “research X and draw a flowchart”"
            onCancel={() => setAsking(false)}
            onSend={(q) => {
              setAsking(false);
              const p = prefs.get();
              onAsk({ scope: pickList.length ? "auto" : "selection", question: q, model: p.model, effort: p.effort, editMode: p.editMode, picks: pickList.flatMap((x) => x.elementIds) });
            }}
          />
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------ pick highlights ---
export function PickHighlights({ view }) {
  const list = useStore(picks);
  if (!view || !list.length) return null;
  return (
    <div className="overlay-layer">
      {list.map((p, i) => {
        const box = screenBox(view.a, withFamily(p.elementIds, view.els));
        if (!box) return null;
        return (
          <div key={p.id} className="pick-box" style={{ left: box.x0 - 6, top: box.y0 - 6, width: box.x1 - box.x0 + 12, height: box.y1 - box.y0 + 12 }}>
            <span className="pick-num">{i + 1}</span>
          </div>
        );
      })}
    </div>
  );
}

export function ContextTray({ api, view, onAsk }) {
  const list = useStore(picks);
  const [asking, setAsking] = useState(false);
  useEffect(() => { if (!list.length) setAsking(false); }, [list.length]);
  if (!list.length) return null;
  const goto = (p) => {
    const els = withFamily(p.elementIds, api.getSceneElements());
    if (els.length) api.scrollToContent(els, { animate: true, fitToViewport: false });
  };
  const allIds = list.flatMap((p) => p.elementIds);
  return (
    <div className="context-tray" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <div className="tray-head">
        <b>Context</b>
        <span className="muted">{list.length} pick{list.length > 1 ? "s" : ""} · Claude sees them together</span>
        <button className="link danger" onClick={() => picks.set([])}>Clear</button>
      </div>
      <div className="chips">
        {list.map((p, i) => {
          const gone = view && !withFamily(p.elementIds, view.els).length;
          return (
            <span key={p.id} className={`chip ${gone ? "gone" : ""}`}>
              <button className="chip-label" onClick={() => goto(p)} title={gone ? "Deleted from the board" : "Show on the board"}>
                <span className="pick-num inline">{i + 1}</span> {p.label}
              </button>
              <button className="chip-x" title="Remove" onClick={() => picks.set((l) => l.filter((x) => x.id !== p.id))}>✕</button>
            </span>
          );
        })}
      </div>
      {asking ? (
        <Composer
          placeholder="Ask about all picked items, e.g. “how do these relate?”, “merge these into one flow”"
          onCancel={() => setAsking(false)}
          onSend={(q) => {
            setAsking(false);
            const p = prefs.get();
            onAsk({ scope: "picks", question: q, model: p.model, effort: p.effort, editMode: p.editMode, picks: allIds });
          }}
        />
      ) : (
        <div className="tray-actions">
          <span className="hint-inline">Select anything else on the board and press <b>Pick</b> (Alt+P)</span>
          <button className="btn ghost" onClick={() => newThread(api, allIds)}>💬 Comment</button>
          <button className="btn claude" onClick={() => setAsking(true)}>✦ Ask</button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ comments ----
function threadBox(view, t) {
  const els = withFamily(t.elementIds, view.els);
  if (els.length) return { box: screenBox(view.a, els), orphan: false };
  const [x, y] = toScreen(view.a, t.anchor.x, t.anchor.y);
  return { box: { x0: x, y0: y, x1: x, y1: y }, orphan: true };
}

export function CommentPins({ view }) {
  const list = useStore(comments);
  const u = useStore(ui);
  if (!view) return null;
  const visible = list.filter((t) => (!t.resolved || u.showResolved || u.openThread === t.id) && (t.messages.length || u.openThread === t.id));
  return (
    <div className="overlay-layer">
      {visible.map((t) => {
        const { box, orphan } = threadBox(view, t);
        if (!box) return null;
        const last = t.messages[t.messages.length - 1];
        const pending = t.messages.some((m) => m.pending);
        const open = u.openThread === t.id;
        return (
          <button
            key={t.id}
            className={`pin ${open ? "open" : ""} ${t.resolved ? "resolved" : ""} ${orphan ? "orphan" : ""} ${last?.author === "claude" ? "claude-last" : ""}`}
            style={{ left: box.x1 + 8, top: box.y0 - 4 }}
            title={`${t.label} · ${t.messages.length} message${t.messages.length === 1 ? "" : "s"}${t.resolved ? " · resolved" : ""}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => ui.set((s) => ({ ...s, openThread: open ? null : t.id }))}
          >
            {pending ? <span className="spinner dark tiny" /> : last?.author === "claude" ? "✦" : "💬"}
            {t.messages.length > 1 && <span className="pin-count">{t.messages.length}</span>}
          </button>
        );
      })}
    </div>
  );
}

function Message({ m, api }) {
  const [proposals, setProposals] = useState([]);
  useEffect(() => onProposalsChange(setProposals), []);
  const live = m.proposalId && proposals.some((p) => p.id === m.proposalId);
  return (
    <div className={`msg ${m.author}`}>
      <div className="msg-head">
        <span className="who">{m.author === "claude" ? "✦ Claude" : "You"}</span>
        {m.author === "claude" && (m.model || m.effort) && <span className="tag">{[m.model || "default", m.effort].filter(Boolean).join(" · ")}</span>}
        <span className="when">{ago(m.at)}</span>
      </div>
      {m.pending && !m.text ? (
        <div className="msg-status"><span className="spinner dark tiny" /> {m.status || "Thinking…"}</div>
      ) : m.error ? (
        <div className="msg-error">{m.error}</div>
      ) : (
        <div className="msg-text">{m.text}</div>
      )}
      {m.pending && m.text && m.status && <div className="msg-status">{m.status}</div>}
      {!m.pending && (m.drew || m.inked || m.edited || m.proposalId) && (
        <div className="msg-effects">
          {(m.drew || m.inked) && (
            <button
              className="effect-link"
              title="Show it on the board"
              onClick={() => {
                const els = api.getSceneElements().filter((e) => m.askId && e.customData?.askId === m.askId);
                if (els.length) api.scrollToContent(els, { animate: true, fitToViewport: els.length > 8, viewportZoomFactor: 0.7 });
              }}
            >
              ✎ {m.drew ? "drew" : "marked up"} on the board ↗
            </button>
          )}
          {m.edited && <span>✓ edited the board (Ctrl+Z undoes)</span>}
          {m.proposalId && (live ? <span className="proposal-link">proposed edits — see the panel below</span> : <span>proposed edits (handled)</span>)}
        </div>
      )}
    </div>
  );
}

export function ThreadPopover({ api, view, board }) {
  const list = useStore(comments);
  const u = useStore(ui);
  const [running, setRunning] = useState([]);
  useEffect(() => onRunningChange(setRunning), []);
  const t = list.find((x) => x.id === u.openThread);
  const scroller = useRef(null);
  const close = useCallback(() => {
    const cur = comments.get().find((x) => x.id === ui.get().openThread);
    if (cur && !cur.messages.length) comments.set((l) => l.filter((x) => x.id !== cur.id)); // drop empty drafts
    ui.set((s) => ({ ...s, openThread: null }));
  }, []);
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [t?.messages.length, t?.messages[t?.messages.length - 1]?.text]);
  useEffect(() => {
    if (!t) return;
    const onKey = (e) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [t?.id, close]);
  if (!t || !view) return null;
  const { box } = threadBox(view, t);
  const W = 360;
  let left = box.x1 + 22;
  if (left + W > window.innerWidth - 70) left = Math.max(8, box.x0 - W - 22);
  const top = Math.max(60, Math.min(window.innerHeight - 460, box.y0 - 20));
  const pending = t.messages.find((m) => m.pending);
  const goto = () => {
    const els = withFamily(t.elementIds, api.getSceneElements());
    if (els.length) {
      api.selectElements?.(els);
      api.scrollToContent(els, { animate: true, fitToViewport: false });
    }
  };
  return (
    <div className="thread" style={{ left, top, width: W, maxHeight: Math.max(300, window.innerHeight - top - 16) }} onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <div className="thread-head">
        <button className="thread-target" onClick={goto} title="Show on the board">💬 {t.label}</button>
        <div className="thread-tools">
          {t.messages.length > 0 && (
            <button title={t.resolved ? "Reopen" : "Resolve"} onClick={() => { updateThread(t.id, (x) => ({ ...x, resolved: !x.resolved })); if (!t.resolved) close(); }}>
              {t.resolved ? "↺" : "✓"}
            </button>
          )}
          <button title="Delete thread" onClick={() => { comments.set((l) => l.filter((x) => x.id !== t.id)); ui.set((s) => ({ ...s, openThread: null })); }}>🗑</button>
          <button title="Close (Esc)" onClick={close}>✕</button>
        </div>
      </div>
      {t.messages.length > 0 && (
        <div className="thread-msgs" ref={scroller}>
          {t.messages.map((m) => <Message key={m.id} m={m} api={api} />)}
        </div>
      )}
      {pending ? (
        <div className="thread-busy">
          <span className="spinner dark tiny" /> Claude is replying…
          <button className="link danger" onClick={() => running.filter((r) => r.label === "Comment").forEach((r) => cancelAsk(r.id))}>Stop</button>
        </div>
      ) : (
        <Composer
          key={t.id}
          actions="comment"
          placeholder={t.messages.length ? "Reply… (@claude to ask Claude)" : "Add a comment… e.g. “@claude why is this slow?” or “@claude redraw this as a sequence diagram”"}
          onCancel={close}
          onSend={(text, ask) => postInThread(api, board, t.id, text, ask)}
        />
      )}
    </div>
  );
}

export function CommentsPanel({ api }) {
  const list = useStore(comments);
  const u = useStore(ui);
  if (!u.panel) return null;
  const open = list.filter((t) => t.messages.length && !t.resolved);
  const resolved = list.filter((t) => t.messages.length && t.resolved);
  const shown = u.showResolved ? [...open, ...resolved] : open;
  const goto = (t) => {
    const els = withFamily(t.elementIds, api.getSceneElements());
    if (els.length) api.scrollToContent(els, { animate: true, fitToViewport: false });
    ui.set((s) => ({ ...s, openThread: t.id }));
  };
  return (
    <div className="comments-panel" onPointerDown={(e) => e.stopPropagation()}>
      <div className="panel-head">
        <b>Comments</b>
        <label className="muted small"><input type="checkbox" checked={u.showResolved} onChange={(e) => ui.set((s) => ({ ...s, showResolved: e.target.checked }))} /> resolved ({resolved.length})</label>
        <button className="x" onClick={() => ui.set((s) => ({ ...s, panel: false }))}>✕</button>
      </div>
      {!shown.length && (
        <div className="empty-state">
          <p>No comments yet.</p>
          <p className="muted">Select anything on the board and press <b>💬 Comment</b> (or Alt+C). Mention <b>@claude</b> to get a reply — Claude can also draw, mark up or edit from a comment.</p>
        </div>
      )}
      {shown.map((t) => {
        const last = t.messages[t.messages.length - 1];
        return (
          <button key={t.id} className={`thread-row ${t.resolved ? "resolved" : ""} ${u.openThread === t.id ? "current" : ""}`} onClick={() => goto(t)}>
            <div className="row-top"><b>{t.label}</b><span className="when">{ago(last?.at || t.createdAt)}</span></div>
            <div className="row-text">{last?.pending ? "✦ replying…" : `${last?.author === "claude" ? "✦ " : ""}${(last?.text || last?.error || "").slice(0, 120)}`}</div>
            <div className="row-meta">{t.messages.length} message{t.messages.length === 1 ? "" : "s"}{t.resolved ? " · resolved" : ""}</div>
          </button>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------ proposals ---
export function ProposalsPanel({ api }) {
  const [list, setList] = useState([]);
  useEffect(() => onProposalsChange(setList), []);
  if (!list.length || !api) return null;
  const p = list[list.length - 1];
  const kinds = { style: "🎨", text: "✎", move: "↔", delete: "🗑", other: "•" };
  return (
    <div className="proposals" onPointerDown={(e) => e.stopPropagation()}>
      <div className="prop-head">
        <b>✦ Claude proposes {p.lines.length} edit{p.lines.length === 1 ? "" : "s"}</b>
        {list.length > 1 && <span className="muted">+{list.length - 1} more</span>}
      </div>
      <ul className="prop-list">
        {p.lines.slice(0, 8).map((l, i) => (
          <li key={i}>
            <span className="k">{kinds[l.kind]}</span> {l.text}
            {l.detail && <span className="muted"> · {l.detail}</span>}
            {l.swatches?.map((c) => <span key={c} className="sw" style={{ background: c }} />)}
          </li>
        ))}
        {p.lines.length > 8 && <li className="muted">…and {p.lines.length - 8} more</li>}
      </ul>
      <div className="prop-actions">
        <button
          className={`btn ghost ${p.preview ? "on" : ""}`}
          onClick={() => {
            if (!p.preview) {
              const els = proposalTargets(api, p.id);
              if (els.length) api.scrollToContent(els, { animate: true, fitToViewport: false });
            }
            previewProposal(api, p.id, !p.preview);
          }}
        >
          {p.preview ? "Hide preview" : "Preview"}
        </button>
        <span className="grow" />
        <button className="btn ghost" onClick={() => discardProposal(api, p.id)}>Discard</button>
        <button className="btn claude" onClick={() => applyProposal(api, p.id)}>Apply</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ shortcuts ---
/** Alt+C comments on the selection, Alt+P picks it, Alt+M opens the comments list. */
export function useOverlayShortcuts(api) {
  useEffect(() => {
    if (!api) return;
    const onKey = (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const tag = document.activeElement?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return;
      const a = api.getAppState();
      const sel = Object.keys(a.selectedElementIds || {}).filter((k) => a.selectedElementIds[k]);
      if (e.code === "KeyC" && sel.length) {
        e.preventDefault();
        e.stopPropagation();
        newThread(api, sel);
      } else if (e.code === "KeyP" && sel.length) {
        e.preventDefault();
        e.stopPropagation();
        const els = withFamily(sel, api.getSceneElements());
        picks.set((l) => (l.some((p) => p.elementIds.join() === sel.join()) ? l : [...l, { id: rid(), elementIds: sel, label: describe(els) }]));
        api.setToast({ message: "Picked. Select more anywhere and press Alt+P, then Ask.", duration: 2200 });
      } else if (e.code === "KeyM") {
        e.preventDefault();
        e.stopPropagation();
        ui.set((s) => ({ ...s, panel: !s.panel }));
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [api]);
}

export function useCommentCount() {
  const list = useStore(comments);
  return useMemo(() => list.filter((t) => t.messages.length && !t.resolved).length, [list]);
}
