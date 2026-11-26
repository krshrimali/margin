// Overlay UI that sits on top of the canvas and follows it as you pan and zoom:
//   - SelectionBar: Comment / Ask / Pick buttons above whatever is selected
//   - pick highlights + ContextTray: context picked from several places, asked about together
//   - comment pins, ThreadPopover and CommentsPanel: comments on any element, answered by Claude on request
//   - ProposalsPanel: edits Claude proposes when edits are set to "Ask first"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getCommonBounds, getSceneVersion } from "@excalidraw/excalidraw";
import { askClaude, cancelAsk, onRunningChange, MODELS, EFFORTS, EDIT_MODES, onProposalsChange, applyProposal, discardProposal, previewProposal, proposalImage, blockedEdit, proposalTargets, resolveProposal } from "./claude.js";
import { comments, picks, prefs, ui, rid, updateThread, updateMessage, useStore, useDismiss, LS, takeAskPrefs } from "./store.js";
import { FILE_BYTES, ATTACHMENT_BYTES, FILE_COUNT } from "./limits.js";
import { player, startWalkthrough, goToStep, endWalkthrough, hasSteps } from "./steps.js";
import { exportToBlob } from "@excalidraw/excalidraw";

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
/** Model · effort · edits · cost cap pickers, plus the one-shot "walk me through it" toggle. */
export function AskOptions({ compact = false }) {
  const p = useStore(prefs);
  const set = (k) => (e) => prefs.set((s) => ({ ...s, [k]: e.target.value }));
  return (
    <>
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
        <label title="Stop the answer if it would cost more than this (US$). Empty = no cap. Remembered.">
          <span>Cap $</span>
          <input type="number" min="0" step="0.05" placeholder="none" value={p.maxBudget || ""} onChange={(e) => prefs.set((s) => ({ ...s, maxBudget: Math.max(0, Number(e.target.value) || 0) }))} />
        </label>
      </div>
      <label className="steps-toggle" title="Allow reading the configured project for this ask">
        <input type="checkbox" checked={p.projectAccess} onChange={(e) => prefs.set((s) => ({ ...s, projectAccess: e.target.checked }))} /> Read project files
      </label>
      <label className={`steps-toggle ${p.steps ? "on" : ""}`} title="Claude draws it as a step-by-step walkthrough you play one step at a time (this ask only)">
        <input type="checkbox" checked={p.steps} onChange={(e) => prefs.set((s) => ({ ...s, steps: e.target.checked }))} /> ▶ Walk me through it, step by step
      </label>
    </>
  );
}

// ---------------------------------------------------------- attachments ---
const readFile = (f) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ name: f.name, type: f.type, size: f.size, data: r.result });
    r.onerror = reject;
    r.readAsDataURL(f);
  });

async function addFiles(list, files, setFiles) {
  if (files.length + list.length > FILE_COUNT) return alert("An ask can include up to 8 files.");
  const large = list.find((f) => f.size > FILE_BYTES);
  if (large) return alert(large.name + " exceeds 15 MiB.");
  if ([...files, ...list].reduce((sum, f) => sum + f.size, 0) > ATTACHMENT_BYTES) return alert("Attachments exceed 36 MiB combined.");
  const out = [];
  for (const f of list) {
    out.push(await readFile(f));
  }
  setFiles((x) => [...x, ...out].slice(0, 8));
}

/** Files (PDFs, images, text, code) and links to send with a question. */
export function Attachments({ files, setFiles, links, setLinks }) {
  const input = useRef(null);
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const addUrl = () => {
    const u = url.trim();
    if (/^https?:\/\/\S+$/i.test(u)) setLinks((x) => [...new Set([...x, u])].slice(0, 8));
    setUrl("");
    setAdding(false);
  };
  return (
    <div className="attach-row">
      <input ref={input} type="file" multiple hidden accept=".pdf,image/*,.txt,.md,.csv,.json,.js,.ts,.py,.rs,.go,.java,.html,.css,.yaml,.yml,.toml,.sql" onChange={(e) => { addFiles([...e.target.files], files, setFiles); e.target.value = ""; }} />
      <button className="btn ghost tiny" onClick={() => input.current.click()} title="Attach PDFs, images or text files">📎 File</button>
      {adding ? (
        <input
          className="url-input" autoFocus placeholder="https://… then Enter" value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addUrl(); } if (e.key === "Escape") { e.stopPropagation(); setAdding(false); } }}
          onBlur={addUrl}
        />
      ) : (
        <button className="btn ghost tiny" onClick={() => setAdding(true)} title="Attach a web page for Claude to read">🔗 Link</button>
      )}
      {files.map((f, i) => (
        <span key={`f${i}`} className="att-chip" title={`${f.name} · ${(f.size / 1024).toFixed(0)} KB`}>
          {/^image\//.test(f.type) ? "🖼" : /pdf/.test(f.type) ? "📄" : "📃"} {f.name}
          <button onClick={() => setFiles((x) => x.filter((_, j) => j !== i))}>✕</button>
        </span>
      ))}
      {links.map((u) => (
        <span key={u} className="att-chip" title={u}>🔗 {u.replace(/^https?:\/\/(www\.)?/, "").slice(0, 32)}
          <button onClick={() => setLinks((x) => x.filter((y) => y !== u))}>✕</button>
        </span>
      ))}
    </div>
  );
}

/** Text box + attachments + options + send. Ctrl/Cmd+Enter sends; Esc cancels. Files can be dropped on it. */
export function Composer({ placeholder, onSend, onCancel, autoFocus = true, actions, initial = "", busy = false }) {
  const [text, setText] = useState(initial);
  const [files, setFiles] = useState([]);
  const [links, setLinks] = useState([]);
  const [drag, setDrag] = useState(false);
  const ref = useRef(null);
  useEffect(() => { if (autoFocus) ref.current?.focus(); }, [autoFocus]);
  const send = (withClaude) => {
    if (!text.trim() && !withClaude) return;
    onSend(text.trim(), withClaude, { attachments: files, links });
    setText("");
    setFiles([]);
    setLinks([]);
  };
  return (
    <div
      className={`composer ${drag ? "drag" : ""}`}
      onKeyDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        setDrag(false);
        const list = [...e.dataTransfer.files];
        await addFiles(list, files, setFiles);
        const u = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
        if (!list.length && /^https?:\/\//.test(u)) setLinks((x) => [...new Set([...x, u.trim()])]);
      }}
    >
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
      <Attachments files={files} setFiles={setFiles} links={links} setLinks={setLinks} />
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
export function newThread(api, elementIds) {
  const els = withFamily(elementIds, api.getSceneElements());
  const b = boundsOf(els);
  const t = { id: rid(), elementIds, anchor: { x: b.maxX, y: b.minY }, label: describe(els), createdAt: Date.now(), resolved: false, messages: [], draft: true };
  comments.set((l) => [...l, t]);
  ui.set((u) => ({ ...u, openThread: t.id }));
  return t;
}

/** Run Claude for a thread and stream its reply into message `reply`. */
function runThreadReply(api, board, threadId, history, question, reply, opts, extras = {}) {
  const thread = comments.get().find((t) => t.id === threadId);
  askClaude(api, {
    question,
    cwd: cwdFor(board),
    ...opts,
    ...extras,
    thread: { ...thread, ...(extras.fresh ? { sessionId: null } : {}), messages: history.length ? history : [{ author: "user", text: question }] },
    reply: {
      status: (s) => updateMessage(threadId, reply.id, { status: s }),
      delta: (a) => updateMessage(threadId, reply.id, { text: a, status: "" }),
      usage: (u) => updateMessage(threadId, reply.id, { tokens: { input: u.input, output: u.output } }),
      done: (d) => {
        updateMessage(threadId, reply.id, {
          text: d.answer, pending: false, status: "", model: d.model || opts.model, effort: d.effort, drew: d.drew, inked: d.inked,
          inputRef: d.inputRef || null, walkthrough: !!(extras.steps || opts.steps), proposalId: d.proposalId, edited: d.edited, durationMs: d.durationMs, engine: d.engine, askId: d.askId, costUsd: d.costUsd, steps: d.steps,
        });
        if (!extras.fresh) updateThread(threadId, (t) => ({ ...t, sessionId: d.sessionId || t.sessionId, engine: d.engine, cwd: d.cwd }));
      },
      error: (msg) => updateMessage(threadId, reply.id, { pending: false, status: "", error: msg, text: "" }),
    },
  }).catch((e) => updateMessage(threadId, reply.id, { pending: false, error: e.message }));
}

/** Post a message; with `ask`, Claude replies in the thread (and draws/edits on the board if asked). */
export function postInThread(api, board, threadId, text, ask, extras = {}) {
  const thread = comments.get().find((t) => t.id === threadId);
  if (!thread) return;
  const names = [...(extras.attachments || []).map((f) => `📎 ${f.name}`), ...(extras.links || []).map((u) => `🔗 ${u}`)];
  const user = text || names.length ? { id: rid(), author: "user", text: [text, ...names].filter(Boolean).join("\n"), at: Date.now() } : null;
  const msgs = user ? [...thread.messages, user] : thread.messages;
  if (!ask) {
    updateThread(threadId, (t) => ({ ...t, draft: false, messages: msgs }));
    return;
  }
  const opts = takeAskPrefs();
  const reply = { id: rid(), author: "claude", text: "", at: Date.now(), pending: true, status: "Looking at the board…", model: opts.model, effort: opts.effort };
  updateThread(threadId, (t) => ({ ...t, draft: false, resolved: false, messages: [...msgs, reply] }));
  runThreadReply(api, board, threadId, msgs, text || "Please look at this and reply.", reply, opts, extras);
}

/** Ask again for the user message that `msgId` answered, with the current model/effort; the new reply is added below. */
export function regenerateInThread(api, board, threadId, msgId) {
  const thread = comments.get().find((t) => t.id === threadId);
  const i = thread?.messages.findIndex((m) => m.id === msgId);
  if (!thread || i < 0) return;
  const history = thread.messages.slice(0, i).filter((m) => !m.pending);
  const lastUser = [...history].reverse().find((m) => m.author === "user");
  const opts = takeAskPrefs();
  const reply = { id: rid(), author: "claude", text: "", at: Date.now(), pending: true, status: "Trying again…", model: opts.model, effort: opts.effort, regenOf: msgId };
  updateThread(threadId, (t) => ({ ...t, resolved: false, messages: [...t.messages, reply] }));
  runThreadReply(api, board, threadId, history, lastUser?.text || "Please look at this and reply.", reply, opts, { fresh: true, replayId: thread.messages[i].inputRef, legacyReplayId: !("inputRef" in thread.messages[i]) ? thread.messages[i].askId : null, steps: opts.steps || thread.messages[i].walkthrough });
}

// --------------------------------------------------------- SelectionBar ---
export function SelectionBar({ api, view, board, onAsk }) {
  const pickList = useStore(picks);
  const u = useStore(ui);
  const [asking, setAsking] = useState(false);
  const [regen, setRegen] = useState(false);
  const selKey = view?.sel.join(",");
  useEffect(() => { setAsking(false); setRegen(false); }, [selKey]);
  const barRef = useRef(null);
  useDismiss("sel-ask", asking, () => setAsking(false), { ref: barRef, guard: () => !barRef.current?.querySelector("textarea")?.value.trim() });
  // Alt+A / command bar: open the ask box for the current selection
  const lastSelAsk = useRef(u.selAsk);
  useEffect(() => {
    if (u.selAsk !== lastSelAsk.current) {
      lastSelAsk.current = u.selAsk;
      if (view?.sel.length) { setRegen(false); setAsking(true); }
    }
  }, [u.selAsk, view]);
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
  // a selected answer card can be asked again (e.g. with another model)
  const card = selected.find((e) => e.customData?.claude && e.customData.askId &&
    ((e.customData.visualReply && !e.customData.threadId) || ["bg", "text", "holder", "header"].includes(e.customData.role)));
  const details = card?.customData.visualReply && [
    card.customData.modelLabel || (card.customData.engine === "codex" ? "Codex" : "Claude"),
    card.customData.effort,
    Number.isFinite(card.customData.durationMs) && `${(card.customData.durationMs / 1000).toFixed(1)}s`,
    card.customData.costUsd > 0 && `$${card.customData.costUsd.toFixed(3)}`,
  ].filter(Boolean).join(" · ");
  const regenQuestion = card?.customData.question || "";
  const regenFocus = card?.customData.replayFocus || card?.customData.focusIds || [];
  const stepsAsk = hasSteps(selected);
  const top = box.y0 - 52 < 70 ? box.y1 + 12 : box.y0 - 52;
  const barW = asking ? 420 : 300 + (card ? 120 : 0) + (stepsAsk ? 110 : 0);
  const left = Math.max(8, Math.min(window.innerWidth - barW, (box.x0 + box.x1) / 2 - barW / 2));

  const comment = () => newThread(api, ids);
  const togglePick = () => {
    if (pickedAlready) picks.set((l) => l.filter((p) => p !== pickedAlready));
    else picks.set((l) => [...l, { id: rid(), elementIds: ids, label: describe(selected) }]);
  };
  return (
    <div ref={barRef} className={`sel-bar ${asking ? "asking" : ""}`} style={{ left, top }} onPointerDown={(e) => e.stopPropagation()}>
      {!asking ? (
        <>
          <button onClick={comment} title="Comment on the selection (Alt+C)"><span className="ic">💬</span> Comment</button>
          <button onClick={() => { setRegen(false); setAsking(true); }} title="Ask Claude about the selection (Alt+A)"><span className="ic claude-ic">✦</span> Ask</button>
          {card && (
            <button onClick={() => { setRegen(true); setAsking(true); }} title={details || "Ask the same question again, e.g. with another model or effort, to compare"}>
              <span className="ic">↻</span> Regenerate
            </button>
          )}
          {stepsAsk && (
            <button onClick={() => startWalkthrough(api, stepsAsk)} title="Play this walkthrough step by step"><span className="ic">▶</span> Play steps</button>
          )}
          <button onClick={togglePick} className={pickedAlready ? "on" : ""} title="Add to the context tray, then pick more from anywhere on the board (Alt+P)">
            <span className="ic">{pickedAlready ? "✓" : "＋"}</span> {pickedAlready ? "Picked" : "Pick"}
          </button>
        </>
      ) : (
        <div className="sel-ask">
          <div className="sel-ask-title">
            {regen ? <>Regenerate this answer — pick another model or effort to compare</> : <>Ask about <b>{describe(selected)}</b>{pickList.length ? ` + ${pickList.length} picked` : ""}</>}
          </div>
          <Composer
            placeholder="What do you want to know or change? e.g. “explain this”, “make it colourful”, “research X and draw a flowchart”"
            onCancel={() => setAsking(false)}
            initial={regen ? regenQuestion : ""}
            onSend={(q, _ask, extras) => {
              setAsking(false);
              if (regen) {
                // same focus (or scope) as the original answer, without the original answer itself; the new card lands next to it
                const scopeWas = { selection: "viewport", new: "viewport", picks: "viewport", comment: "viewport" }[card.customData.scope] || card.customData.scope || "viewport";
                const options = takeAskPrefs();
                onAsk({
                  ...(regenFocus.length ? { scope: "picks", picks: regenFocus } : { scope: scopeWas }),
                  question: q || regenQuestion, excludeAsk: card.customData.askId, replayId: card.customData.inputRef,
                  legacyReplayId: !("inputRef" in card.customData) ? card.customData.askId : null, ...options, ...extras,
                  steps: extras.steps || card.customData.walkthrough || options.steps,
                });
                return;
              }
              onAsk({ scope: pickList.length ? "auto" : "selection", question: q, ...takeAskPrefs(), ...extras, picks: [...pickList.flatMap((x) => x.elementIds), ...sel] });
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
  const trayRef = useRef(null);
  useDismiss("tray-ask", asking, () => setAsking(false), { ref: trayRef, guard: () => !trayRef.current?.querySelector("textarea")?.value.trim() });
  if (!list.length) return null;
  const goto = (p) => {
    const els = withFamily(p.elementIds, api.getSceneElements());
    if (els.length) api.scrollToContent(els, { animate: true, fitToViewport: false });
  };
  const allIds = list.flatMap((p) => p.elementIds);
  return (
    <div className="context-tray" ref={trayRef} onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
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
          onSend={(q, _ask, extras) => {
            setAsking(false);
            onAsk({ scope: "picks", question: q, ...takeAskPrefs(), ...extras, picks: allIds });
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

const fmtTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n || 0));
const KIND_ICON = { style: "🎨", text: "✎", move: "↔", delete: "🗑", add: "＋", connect: "→", other: "•" };

/** Claude's proposed edits, one row each with accept / reject (used in threads and the panel). */
function Suggestions({ api, p }) {
  const [preview, setPreview] = useState("");
  const [previewText, setPreviewText] = useState("");
  useEffect(() => {
    let active = true, url;
    setPreview(""); setPreviewText("");
    if (p.preview) proposalImage(api, p).then((blob) => {
      if (!active) return;
      if (blob) { url = URL.createObjectURL(blob); setPreview(url); }
      else setPreviewText("The proposed edits remove the selected content.");
    }).catch(() => { if (active) setPreviewText("Preview unavailable."); });
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [p, api]);
  const pending = p.state.filter((s) => s === "pending").length;
  return (
    <div className="suggestions">
      <div className="sugg-head">
        <b>{pending} suggested edit{pending === 1 ? "" : "s"}</b>
        <button
          className={`btn ghost tiny ${p.preview ? "on" : ""}`}
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
      </div>
      {p.preview && (preview ? <img src={preview} alt="Proposed result" style={{ maxWidth: "100%", maxHeight: 320 }} /> : <p>{previewText || "Preparing preview…"}</p>)}
      <ul className="prop-list">
        {p.lines.map((l, i) => (
          <li key={i} className={p.state[i]}>
            <span className="k">{KIND_ICON[l.kind] || "•"}</span>
            <span className="grow">
              {l.text}
              {l.detail && <span className="muted"> · {l.detail}</span>}
              {l.swatches?.map((c) => <span key={c} className="sw" style={{ background: c }} />)}
            </span>
            {p.state[i] === "pending" ? (
              <>
                <button className="mini ok" disabled={blockedEdit(p, i)} title={blockedEdit(p, i) ? "Accept the referenced addition first" : "Accept this edit"} onClick={() => resolveProposal(api, p.id, true, [i])}>✓</button>
                <button className="mini no" title="Reject this edit" onClick={() => resolveProposal(api, p.id, false, [i])}>✕</button>
              </>
            ) : (
              <span className="muted small">{p.state[i]}</span>
            )}
          </li>
        ))}
      </ul>
      <div className="prop-actions">
        <span className="grow" />
        <button className="btn ghost" onClick={() => discardProposal(api, p.id)}>{pending ? "Reject all" : "Dismiss"}</button>
        <button className="btn claude" disabled={!pending} onClick={() => applyProposal(api, p.id)}>Accept all</button>
      </div>
    </div>
  );
}

function Message({ m, api, board, threadId }) {
  const [proposals, setProposals] = useState([]);
  useEffect(() => onProposalsChange(setProposals), []);
  const live = m.proposalId && proposals.find((p) => p.id === m.proposalId);
  return (
    <div className={`msg ${m.author}`}>
      <div className="msg-head">
        <span className="who">{m.author === "claude" ? "✦ Claude" : "You"}</span>
        {m.author === "claude" && (m.model || m.effort) && <span className="tag">{[m.model || "default", m.effort].filter(Boolean).join(" · ")}</span>}
        {m.regenOf && <span className="tag ghost">retry</span>}
        <span className="when">{ago(m.at)}</span>
        {m.author === "claude" && !m.pending && (
          <button className="mini" title="Try again (uses the model and effort chosen below, so you can compare)" onClick={() => regenerateInThread(api, board, threadId, m.id)}>↻</button>
        )}
      </div>
      {m.pending && !m.text ? (
        <div className="msg-status">
          <span className="spinner dark tiny" /> {m.status || "Thinking…"}
          {m.tokens && <span className="muted small"> · {fmtTokens(m.tokens.input)} in · {fmtTokens(m.tokens.output)} out</span>}
        </div>
      ) : m.error ? (
        <div className="msg-error">{m.error}</div>
      ) : (
        <div className="msg-text">{m.text}</div>
      )}
      {m.pending && m.text && <div className="msg-status">{m.status}{m.tokens && <span className="muted small"> {fmtTokens(m.tokens.output)} tokens out</span>}</div>}
      {!m.pending && (m.drew || m.inked || m.edited || m.proposalId || m.costUsd > 0) && (
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
          {m.steps > 0 && <button className="effect-link" onClick={() => startWalkthrough(api, m.askId)}>▶ play {m.steps} steps</button>}
          {m.edited && <span>✓ edited the board (Ctrl+Z undoes)</span>}
          {m.proposalId && !live && <span>suggested edits (handled)</span>}
          {m.costUsd > 0 && <span className="cost" title={m.durationMs ? `${(m.durationMs / 1000).toFixed(0)} s` : ""}>${m.costUsd.toFixed(2)}</span>}
        </div>
      )}
      {live && <Suggestions api={api} p={live} />}
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
  const threadRef = useRef(null);
  // clicking elsewhere closes the thread, unless a reply is being typed in it
  useDismiss("thread", !!t, close, {
    ref: threadRef, keep: [".pin", ".comments-panel"], allow: ["panel"],
    guard: () => !threadRef.current?.querySelector("textarea")?.value.trim(),
  });
  useEffect(() => {
    if (!t) return;
    const onKey = (e) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [t?.id, close]);
  if (!t || !view) return null;
  const { box } = threadBox(view, t);
  const W = 360;
  // start right of the thread's pin (box.x1 + 8, up to ~44 px wide with a count) so the pin stays clickable
  let left = box.x1 + 60;
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
    <div className="thread" ref={threadRef} style={{ left, top, width: W, maxHeight: Math.max(300, window.innerHeight - top - 16) }} onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <div className="thread-head">
        <button className="thread-target" onClick={goto} title="Show on the board">💬 {t.label}</button>
        <div className="thread-tools">
          {t.messages.length > 0 && (
            <button title={t.resolved ? "Reopen" : "Resolve"} onClick={() => { updateThread(t.id, (x) => ({ ...x, resolved: !x.resolved })); if (!t.resolved) close(); }}>
              {t.resolved ? "↺" : "✓"}
            </button>
          )}
          <ExportMenu api={api} t={t} />
          <button title="Delete thread" onClick={() => { comments.set((l) => l.filter((x) => x.id !== t.id)); ui.set((s) => ({ ...s, openThread: null })); }}>🗑</button>
          <button title="Close (Esc)" onClick={close}>✕</button>
        </div>
      </div>
      {t.messages.length > 0 && (
        <div className="thread-msgs" ref={scroller}>
          {t.messages.map((m) => <Message key={m.id} m={m} api={api} board={board} threadId={t.id} />)}
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
          onSend={(text, ask, extras) => postInThread(api, board, t.id, text, ask, extras)}
        />
      )}
    </div>
  );
}

export function CommentsPanel({ api }) {
  const list = useStore(comments);
  const u = useStore(ui);
  const panelRef = useRef(null);
  useDismiss("panel", u.panel, () => ui.set((s) => ({ ...s, panel: false })), { ref: panelRef, keep: [".comments-btn", ".thread", ".pin"], allow: ["thread"] });
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
    <div className="comments-panel" ref={panelRef} onPointerDown={(e) => e.stopPropagation()}>
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
  // suggestions made in a comment thread are shown in that thread
  const shown = list.filter((p) => p.source !== "comment" || !comments.get().some((t) => t.id === p.threadId));
  if (!shown.length || !api) return null;
  const p = shown[shown.length - 1];
  return (
    <div className="proposals" onPointerDown={(e) => e.stopPropagation()}>
      <div className="prop-head">
        <b>✦ Claude suggests edits</b>
        {shown.length > 1 && <span className="muted">+{shown.length - 1} more</span>}
      </div>
      <Suggestions api={api} p={p} />
    </div>
  );
}

// -------------------------------------------------------------- export ----
function threadMarkdown(t) {
  const when = (x) => new Date(x).toLocaleString();
  const lines = [`# 💬 ${t.label}`, "", `_${t.messages.length} messages · started ${when(t.createdAt)}${t.resolved ? " · resolved" : ""}_`, "", "![The commented part of the board](" + slug(t.label) + ".png)", ""];
  for (const m of t.messages) {
    if (m.pending) continue;
    const who = m.author === "claude" ? `✦ Claude${m.model || m.effort ? ` (${[m.model || "default", m.effort].filter(Boolean).join(", ")})` : ""}` : "You";
    lines.push(`**${who}** · ${when(m.at)}`, "", (m.error ? `> ⚠ ${m.error}` : m.text || "").trim(), "");
  }
  return lines.join("\n");
}
const slug = (s) => String(s || "thread").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "thread";
const download = (blob, name) => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};

/** The commented elements plus everything Claude drew or wrote from this thread. */
function threadElements(api, t) {
  const askIds = new Set(t.messages.map((m) => m.askId).filter(Boolean));
  const els = api.getSceneElements();
  return [...withFamily(t.elementIds, els), ...els.filter((e) => e.customData?.threadId === t.id || askIds.has(e.customData?.askId))]
    .filter((e, i, a) => a.findIndex((x) => x.id === e.id) === i && !e.customData?.claudePending);
}

function ExportMenu({ api, t }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  useDismiss("export", open, () => setOpen(false), { ref: wrapRef });
  const copy = async () => {
    await navigator.clipboard.writeText(threadMarkdown(t)).catch(() => {});
    api.setToast({ message: "Thread copied as Markdown.", duration: 2000 });
    setOpen(false);
  };
  const save = async () => {
    setOpen(false);
    download(new Blob([threadMarkdown(t)], { type: "text/markdown" }), `${slug(t.label)}.md`);
    const els = threadElements(api, t);
    if (els.length) {
      const blob = await exportToBlob({
        elements: els, files: api.getFiles(), mimeType: "image/png", exportPadding: 24,
        appState: { ...api.getAppState(), exportBackground: true, viewBackgroundColor: "#ffffff", exportWithDarkMode: false },
      });
      download(blob, `${slug(t.label)}.png`);
    }
  };
  return (
    <span className="export-wrap" ref={wrapRef}>
      <button title="Export this thread" onClick={() => setOpen((o) => !o)}>⤓</button>
      {open && (
        <div className="menu" onMouseLeave={() => setOpen(false)}>
          <button onClick={copy}>Copy as Markdown</button>
          <button onClick={save}>Download Markdown + picture</button>
        </div>
      )}
    </span>
  );
}

// ---------------------------------------------------------- walkthrough ---
export function StepPlayer({ api }) {
  const p = useStore(player);
  useEffect(() => {
    if (!p || !api) return;
    const onKey = (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT") return;
      const sel = Object.values(api.getAppState().selectedElementIds || {}).some(Boolean);
      if (sel) return; // arrows move the selection
      if (e.key === "ArrowRight" || e.key === " ") { e.preventDefault(); e.stopPropagation(); goToStep(api, player.get().index + 1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); goToStep(api, player.get().index - 1); }
      else if (e.key === "Escape") endWalkthrough(api);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [!!p, api]);
  if (!p || !api) return null;
  const s = p.steps[p.index];
  const last = p.index === p.steps.length - 1;
  return (
    <div className="step-player" onPointerDown={(e) => e.stopPropagation()}>
      <div className="step-dots">
        {p.steps.map((_, i) => <button key={i} className={i === p.index ? "on" : i < p.index ? "done" : ""} onClick={() => goToStep(api, i)} title={`Step ${i + 1}`} />)}
      </div>
      <div className="step-body">
        <span className="step-num">Step {p.index + 1} of {p.steps.length}</span>
        <p>{s.say || "…"}</p>
      </div>
      <div className="step-actions">
        <button className="btn ghost" disabled={p.index === 0} onClick={() => goToStep(api, p.index - 1)}>◀ Back</button>
        {last ? (
          <button className="btn claude" onClick={() => endWalkthrough(api)}>Done ✓</button>
        ) : (
          <button className="btn claude" onClick={() => goToStep(api, p.index + 1)}>Next ▶</button>
        )}
        <button className="link" onClick={() => endWalkthrough(api)} title="Show every step and close (Esc)">Show all</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ shortcuts ---
/** Alt+C comments on the selection, Alt+P picks it, Alt+A asks about it, Alt+M opens comments, Alt+K the command bar. */
export function useOverlayShortcuts(api) {
  useEffect(() => {
    if (!api) return;
    const onKey = (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const tag = document.activeElement?.tagName;
      if ((tag === "TEXTAREA" || tag === "INPUT") && e.code !== "KeyK") return;
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
      } else if (e.code === "KeyA" && sel.length) {
        e.preventDefault();
        e.stopPropagation();
        ui.set((s) => ({ ...s, selAsk: s.selAsk + 1 }));
      } else if (e.code === "KeyK") {
        e.preventDefault();
        e.stopPropagation();
        ui.set((s) => ({ ...s, palette: !s.palette }));
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

// ------------------------------------------------------------ command bar ---
/** Alt+K: type to run any action, or to ask Claude straight away. */
export function CommandBar({ api, onAsk, onToggleInk }) {
  const u = useStore(ui);
  const p = useStore(prefs);
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const close = () => { ui.set((s) => ({ ...s, palette: false })); setQ(""); setI(0); };
  const commands = useMemo(() => {
    if (!api || !u.palette) return [];
    const a = api.getAppState();
    const sel = Object.keys(a.selectedElementIds || {}).filter((k) => a.selectedElementIds[k]);
    const hasPicks = picks.get().length > 0;
    const setPref = (k, v, label) => ({ label, hint: p[k] === v ? "current" : "", run: () => prefs.set((s) => ({ ...s, [k]: v })) });
    const list = [
      { label: "Ask Claude…", hint: "▾ menu", run: () => ui.set((s) => ({ ...s, askOpen: s.askOpen + 1 })) },
      sel.length && { label: "Ask about the selection…", hint: "Alt+A", run: () => ui.set((s) => ({ ...s, selAsk: s.selAsk + 1 })) },
      sel.length && { label: "Comment on the selection", hint: "Alt+C", run: () => newThread(api, sel) },
      sel.length && { label: "Pick the selection for context", hint: "Alt+P", run: () => picks.set((l) => [...l, { id: rid(), elementIds: sel, label: describe(withFamily(sel, api.getSceneElements())) }]) },
      hasPicks && { label: "Ask about picked items…", run: () => document.querySelector(".context-tray .btn.claude")?.click() },
      hasPicks && { label: "Clear picked items", run: () => picks.set([]) },
      { label: "Open comments", hint: "Alt+M", run: () => ui.set((s) => ({ ...s, panel: true })) },
      { label: "Show / hide Claude's ink", hint: "Alt+I", run: onToggleInk },
      { label: p.steps ? "Next ask: normal answer" : "Next ask: walk me through it, step by step", run: () => prefs.set((s) => ({ ...s, steps: !s.steps })) },
      ...[...new Map(api.getSceneElements().filter((e) => e.customData?.narration).map((e) => [e.customData.askId, e])).values()].map((e) => ({
        label: `Play walkthrough: ${String(e.text || e.customData.question || "steps").replace(/^✦ /, "").slice(0, 50)}`,
        run: () => startWalkthrough(api, e.customData.askId),
      })),
      ...MODELS.map(([k, l]) => setPref("model", k, `Model: ${l}`)),
      ...EFFORTS.map(([k, l]) => setPref("effort", k, `Effort: ${l}`)),
      ...Object.entries(EDIT_MODES).map(([k, [l]]) => setPref("editMode", k, `Edits: ${l}`)),
      { label: "Cost cap: none", hint: p.maxBudget ? "" : "current", run: () => prefs.set((s) => ({ ...s, maxBudget: 0 })) },
      ...[0.25, 0.5, 1, 2].map((v) => ({ label: `Cost cap: $${v.toFixed(2)} per answer`, hint: p.maxBudget === v ? "current" : "", run: () => prefs.set((s) => ({ ...s, maxBudget: v })) })),
      { label: "Boards…", run: () => document.querySelector(".board-pill")?.click() },
    ].filter(Boolean);
    return list;
  }, [api, u.palette, p]);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = commands.filter((c) => words.every((w) => c.label.toLowerCase().includes(w)));
  // commands that match come first; anything else you type is a question for Claude
  const askItem = { label: `✦ Ask Claude: “${q.trim()}”`, hint: matches.length ? "" : "Enter", run: () => onAsk({ scope: "auto", question: q.trim(), ...takeAskPrefs(), picks: picks.get().flatMap((x) => x.elementIds) }) };
  const items = q.trim() ? [...matches, askItem] : matches;
  useEffect(() => setI(0), [q]);
  const palRef = useRef(null);
  useDismiss("palette", u.palette, close, { ref: palRef });
  if (!u.palette) return null;
  const run = (c) => { close(); c?.run(); };
  return (
    <div className="palette-back" onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="palette" ref={palRef} onKeyDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          placeholder="Type a command, or a question for Claude…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
            else if (e.key === "ArrowDown") { e.preventDefault(); setI((x) => Math.min(items.length - 1, x + 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setI((x) => Math.max(0, x - 1)); }
            else if (e.key === "Enter") { e.preventDefault(); run(items[i]); }
          }}
        />
        <div className="palette-list">
          {items.slice(0, 40).map((c, k) => (
            <button key={c.label} className={k === i ? "on" : ""} onMouseEnter={() => setI(k)} onClick={() => run(c)}>
              <span>{c.label}</span>
              {c.hint && <span className="hint">{c.hint}</span>}
            </button>
          ))}
          {!items.length && <div className="muted empty">Nothing matches. Type a question to ask Claude.</div>}
        </div>
        <div className="palette-foot muted">↑↓ choose · Enter run · Esc close · Alt+K anywhere</div>
      </div>
    </div>
  );
}
