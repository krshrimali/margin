import { useCallback, useEffect, useRef, useState } from "react";
import { Excalidraw, MainMenu, exportToBlob, getSceneVersion, serializeAsJSON } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import PenInput from "./PenInput.jsx";
import PenDock from "./PenDock.jsx";
import { PRESETS, loadPenSettings, savePenSettings } from "./pens.js";
import { clearInk, inkState, setInkHidden } from "./ink.js";
import Boards from "./Boards.jsx";
import { SCOPES, SCOPE_HINTS, askClaude, cancelAsk, showDrawing, onRunningChange, savedProposals, restoreProposals, onProposalsChange } from "./claude.js";
import { LS, comments, picks, prefs, ui, useStore, takeAskPrefs, useDismiss } from "./store.js";
import {
  AskOptions, Attachments, CommandBar, CommentPins, CommentsPanel, ContextTray, PickHighlights, ProposalsPanel, SelectionBar, StepPlayer, ThreadPopover,
  useCommentCount, useOverlayShortcuts, useView,
} from "./Overlay.jsx";
import { withAllSteps } from "./steps.js";
// The open board: ?board=<id>, else the last one you had open, else "default".
const BOARD = new URLSearchParams(location.search).get("board") || LS.get("whiteboard.lastBoard", "default");
LS.set("whiteboard.lastBoard", BOARD);
if (new URLSearchParams(location.search).get("board") !== BOARD) {
  const u = new URL(location.href);
  u.searchParams.set("board", BOARD);
  history.replaceState(null, "", u);
}

let boardRevision, loadFailure;
const loadBoard = async () => {
  try {
    const r = await fetch(`/api/board?name=${encodeURIComponent(BOARD)}`);
    if (r.status === 404) return { appState: { currentItemRoughness: 0 }, scrollToContent: true };
    if (!r.ok) throw new Error("HTTP " + r.status);
    boardRevision = r.headers.get("etag");
    const data = await r.json();
    if (!Array.isArray(data.elements)) throw new Error("Invalid board file");
    restoreProposals(data.proposals);
    // comment threads are saved alongside the elements
    // picked context is saved per board too
    picks.set(Array.isArray(data.picks) ? data.picks : []);
    comments.set(Array.isArray(data.comments) ? data.comments.map((t) => ({ ...t, messages: (t.messages || []).map((m) => (m.pending ? { ...m, pending: false, error: m.text ? undefined : "Interrupted (the page was reloaded)." } : m)) })) : []);
    return { ...data, scrollToContent: true };
  } catch (error) {
    loadFailure = error.message;
    return null;
  }
};
const initialData = loadBoard();

function useRunning() {
  const [list, setList] = useState([]);
  const [, tick] = useState(0);
  useEffect(() => onRunningChange(setList), []);
  useEffect(() => {
    if (!list.length) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [list.length]);
  return list;
}

const SCOPE_SHORT = { selection: "Selection", new: "New ink", viewport: "Page", board: "Board", picks: "Picked", comment: "Comment" };

const fmtK = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n || 0));
const EDIT_HINT = "Auto lets Claude change your content when you ask for a change; Ask first shows a preview to apply or discard; Off only marks up.";

function ClaudeControls({ api }) {
  const pickList = useStore(picks);
  const commentCount = useCommentCount();
  const u = useStore(ui);
  const [open, setOpen] = useState(false);
  const popRef = useRef(null);
  useDismiss("ask", open, () => setOpen(false), { ref: popRef, keep: [".claude-caret"] });
  const [question, setQuestion] = useState("");
  const [defaultScope, setDefaultScope] = useState(() => LS.get("whiteboard.claude.scope.v2", "auto"));
  const [scope, setScope] = useState(defaultScope);
  const [cwd, setCwd] = useState(() => LS.get(`whiteboard.cwd.${BOARD}`, ""));
  const [defaultCwd, setDefaultCwd] = useState("");
  const running = useRunning();
  const [ink, setInk] = useState({ count: 0, hidden: false });
  const refreshInk = useCallback(() => api && setInk(inkState(api)), [api]);
  const toggleInk = useCallback(() => {
    if (!api) return;
    const st = inkState(api);
    if (!st.count) return api.setToast({ message: "Claude hasn't drawn anything yet.", duration: 2000 });
    setInkHidden(api, !st.hidden);
    api.setToast({ message: st.hidden ? "Claude's ink shown" : "Claude's ink hidden (Alt+I to show)", duration: 1800 });
    refreshInk();
  }, [api, refreshInk]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.altKey && e.code === "KeyI") {
        e.preventDefault();
        e.stopPropagation();
        toggleInk();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [toggleInk]);

  useEffect(() => {
    fetch("/api/health").then((r) => r.json()).then((h) => setDefaultCwd(h.claudeCwd)).catch(() => {});
  }, []);

  const [files, setFiles] = useState([]);
  const [links, setLinks] = useState([]);
  const run = useCallback(
    (s, q, extras = {}) => {
      if (!api) return;
      askClaude(api, { scope: s, question: q, cwd, ...takeAskPrefs(), ...extras, picks: picks.get().flatMap((x) => x.elementIds) }).catch((e) => console.error(e));
    },
    [api, cwd],
  );
  // the command bar can open this popover
  const askOpenSeen = useRef(u.askOpen);
  useEffect(() => {
    if (u.askOpen !== askOpenSeen.current) {
      askOpenSeen.current = u.askOpen;
      setScope(defaultScope);
      setOpen(true);
    }
  }, [u.askOpen, defaultScope]);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !open) {
        e.preventDefault();
        run(defaultScope, "");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [run, defaultScope, open]);

  const submit = () => {
    setOpen(false);
    run(scope, question, { attachments: files, links });
    setQuestion("");
    setFiles([]);
    setLinks([]);
  };

  return (
    <div className="claude-controls">
      <div className="claude-split">
        <button className="claude-btn" onClick={() => run(defaultScope, "")} title={`Ask Claude: ${SCOPE_HINTS[defaultScope]} (Ctrl+Enter)`}>
          {running.length ? <span className="spinner" /> : "✦"} <span className="claude-label">Ask Claude</span>
          <small>{SCOPES[defaultScope]}</small>
        </button>
        <button className="claude-caret" onClick={() => { setScope(defaultScope); refreshInk(); setOpen((o) => !o); }} title="Ask with a question; choose model, effort, edits, scope or project folder">▾</button>
        <button className={`comments-btn ${u.panel ? "on" : ""}`} onClick={() => ui.set((s) => ({ ...s, panel: !s.panel }))} title="Comments (Alt+M)">
          💬{commentCount > 0 && <span className="badge">{commentCount}</span>}
        </button>
      </div>

      {running.length > 0 && (
        <div className="claude-running">
          {running.map((r) => (
            <div key={r.id} className="run-row">
              <span className="spinner dark" />
              <span className="run-status" title={`${r.status}${r.choice ? ` (${r.choice})` : ""}`}>{SCOPE_SHORT[r.scope] || r.scope} · {r.status || "Working…"}</span>
              {r.tokens && (
                <span className="run-tokens" title={`${r.tokens.input} input tokens (incl. cache), ${r.tokens.output} output tokens so far${r.maxBudget ? ` · capped at $${r.maxBudget.toFixed(2)}` : ""}`}>
                  {fmtK(r.tokens.input)}↑ {fmtK(r.tokens.output)}↓
                </span>
              )}
              {r.maxBudget > 0 && <span className="run-cap" title="Cost cap for this answer">≤${r.maxBudget.toFixed(2)}</span>}
              <span className="run-time">{Math.round((Date.now() - r.startedAt) / 1000)}s</span>
              {r.status === "Drawing…" && <button onClick={() => showDrawing(r.id)}>Show now</button>}
              <button className="run-cancel" title="Cancel" onClick={() => cancelAsk(r.id)}>✕</button>
            </div>
          ))}
        </div>
      )}

      {open && (
        <div className="claude-pop" ref={popRef} onKeyDown={(e) => e.stopPropagation()}>
          <textarea
            autoFocus
            placeholder="Optional. You can also just write on the board. Try “research X online and draw a flowchart”, “explain this”, “make it colourful”."
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit();
              if (e.key === "Escape") setOpen(false);
            }}
          />
          <div className="scope-row">
            {Object.entries(SCOPES).map(([k, label]) => (
              <label key={k} className={scope === k ? "sel" : ""}>
                <input type="radio" name="scope" checked={scope === k} onChange={() => setScope(k)} /> {label}
              </label>
            ))}
          </div>
          <Attachments files={files} setFiles={setFiles} links={links} setLinks={setLinks} />
          <p className="hint">{SCOPE_HINTS[scope]}{pickList.length > 0 && (scope === "auto" || scope === "selection") ? ` You have ${pickList.length} picked item${pickList.length > 1 ? "s" : ""}: Auto uses them.` : ""}</p>
          <AskOptions />
          <p className="hint">Model and effort apply to each answer; Default uses Claude Code's own default. Edits: {EDIT_HINT}</p>
          <label className="cwd-row">
            <span>Project folder</span>
            <input
              type="text"
              spellCheck={false}
              placeholder={defaultCwd || "default"}
              value={cwd}
              onChange={(e) => { setCwd(e.target.value); LS.set(`whiteboard.cwd.${BOARD}`, e.target.value); }}
            />
          </label>
          <p className="hint">Enable Read project files to use this folder for one ask. The folder is saved per board.</p>
          <div className="ink-row">
            <span>Claude's ink{ink.count ? ` (${ink.count} strokes${ink.hidden ? ", hidden" : ""})` : ": none yet"}</span>
            <button className="link" disabled={!ink.count} onClick={toggleInk}>{ink.hidden ? "Show" : "Hide"} <kbd>Alt+I</kbd></button>
            <button className="link danger" disabled={!ink.count} onClick={() => { clearInk(api); refreshInk(); }}>Clear</button>
          </div>
          <div className="pop-actions">
            <button
              className="link"
              disabled={scope === defaultScope}
              onClick={() => { setDefaultScope(scope); LS.set("whiteboard.claude.scope.v2", scope); }}
            >
              {scope === defaultScope ? "✓ default scope" : "Make default"}
            </button>
            <button className="claude-btn small" onClick={submit}>Ask ⏎</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => { initialData.then(() => setLoaded(true)); }, []);
  const [api, setApi] = useState(null);
  const [penSettings, setPenSettings] = useState(loadPenSettings);
  const [penId, setPenId] = useState(() => LS.get("whiteboard.pen", "fountain"));
  const [penActive, setPenActive] = useState(false);
  const [stylusOnly, setStylusOnly] = useState(() => LS.get("whiteboard.stylusOnly", false));
  const [theme, setTheme] = useState("light");
  const saveRef = useRef({ version: -1, timer: 0, thumbAt: 0, dirty: false, retired: false, queue: Promise.resolve(true) });
  const [saveStatus, setSaveStatus] = useState("saved");
  const [boardsSignal, setBoardsSignal] = useState(0);

  const pickPen = useCallback(
    (id) => {
      setPenId(id);
      LS.set("whiteboard.pen", id);
      api?.setActiveTool({ type: "custom", customType: "pen" });
      setPenActive(true);
      document.querySelector(".excalidraw-container")?.focus({ preventScroll: true });
    },
    [api],
  );

  const updatePen = (id, p) => {
    const next = { ...penSettings, [id]: p };
    setPenSettings(next);
    savePenSettings(next);
  };
  const resetPen = (id) => updatePen(id, structuredClone(PRESETS[id]));

  // Alt+1..8 selects pens
  useEffect(() => {
    const ids = Object.keys(PRESETS);
    const onKey = (e) => {
      if (e.altKey && /^Digit[1-9]$/.test(e.code)) {
        const id = ids[Number(e.code.slice(5)) - 1];
        if (id) { e.preventDefault(); e.stopPropagation(); pickPen(id); }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pickPen]);

  const write = useCallback(async () => {
    if (!api || loadFailure || saveRef.current.retired) return false;
    saveRef.current.dirty = false;
    // a walkthrough being played hides later steps; the file always has everything visible
    const elements = withAllSteps(api.getSceneElements().filter((e) => !e.customData?.claudePending));
    const scene = JSON.parse(serializeAsJSON(elements, api.getAppState(), api.getFiles(), "local"));
    const body = JSON.stringify({ ...scene, comments: comments.get().filter((t) => t.messages.length), picks: picks.get(), proposals: savedProposals() });
    setSaveStatus("saving");
    try {
      const r = await fetch(`/api/board?name=${encodeURIComponent(BOARD)}`, { method: "PUT", headers: boardRevision ? { "If-Match": boardRevision } : { "If-None-Match": "*" }, body, keepalive: body.length < 60000 });
      if (!r.ok) throw new Error(r.status === 409 ? "Board changed in another session. Export your edits before reloading." : `Save failed (HTTP ${r.status})`);
      boardRevision = r.headers.get("etag");
      setSaveStatus(saveRef.current.timer ? "unsaved" : "saved");
    } catch (error) {
      saveRef.current.dirty = true;
      setSaveStatus("error");
      api.setToast({ message: error.message, closable: true });
      return false;
    }
    // refresh the board's thumbnail at most every 8 seconds
    if (elements.length && Date.now() - saveRef.current.thumbAt > 8000) {
      saveRef.current.thumbAt = Date.now();
      exportToBlob({
        elements,
        files: api.getFiles(),
        appState: { ...api.getAppState(), exportBackground: true, viewBackgroundColor: "#ffffff", exportWithDarkMode: false },
        mimeType: "image/png",
        exportPadding: 24,
        getDimensions: (w, h) => {
          const scale = Math.min(1, 480 / Math.max(w, h));
          return { width: w * scale, height: h * scale, scale };
        },
      })
        .then((blob) => fetch(`/api/board/thumb?name=${encodeURIComponent(BOARD)}`, { method: "PUT", body: blob }))
        .catch(() => {});
    }
    return true;
  }, [api]);

  const save = useCallback(() => {
    const state = saveRef.current;
    state.queue = state.queue.catch(() => false).then(async () => {
      state.inFlight = true;
      try { return await write(); }
      catch (error) {
        state.dirty = true;
        setSaveStatus("error");
        api?.setToast({ message: error.message, closable: true });
        return false;
      } finally { state.inFlight = false; }
    });
    return state.queue;
  }, [write, api]);
  const flushBoard = async () => {
    const state = saveRef.current;
    do {
      clearTimeout(state.timer);
      state.timer = 0;
      if (state.dirty ? !(await save()) : !(await state.queue)) return false;
    } while (state.dirty);
    return true;
  };

  // Ctrl+S saves the board now (files: ☰ menu → Save to…)
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        e.stopPropagation();
        clearTimeout(saveRef.current.timer);
        saveRef.current.timer = 0;
        save()?.then((ok) => ok && api?.setToast({ message: "Board saved", duration: 1500 }));
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [save, api]);

  const openBoard = async (id) => {
    if (!saveRef.current.retired && !(await flushBoard())) return;
    LS.set("whiteboard.lastBoard", id);
    const u = new URL(location.href);
    u.searchParams.set("board", id);
    location.href = u.toString();
  };

  useEffect(() => {
    const flush = (event) => {
      const state = saveRef.current;
      if (!state.retired && (state.dirty || state.inFlight)) {
        event.preventDefault();
        event.returnValue = "";
        if (state.dirty) { clearTimeout(state.timer); state.timer = 0; save(); }
      }
    };
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, [save]);

  // comments are part of the board file: save when they change
  useEffect(() => {
    const later = () => {
      clearTimeout(saveRef.current.timer);
      saveRef.current.dirty = true;
      setSaveStatus("unsaved");
      saveRef.current.timer = setTimeout(() => { saveRef.current.timer = 0; save(); }, 800);
    };
    let ready = false;
    const unsubs = [comments.subscribe(later), picks.subscribe(later), onProposalsChange(() => { if (ready) later(); })];
    ready = true;
    return () => unsubs.forEach((stop) => stop());
  }, [save]);

  const view = useView(api);
  useOverlayShortcuts(api);
  const ask = useCallback(
    (opts) => api && askClaude(api, { cwd: LS.get(`whiteboard.cwd.${BOARD}`, ""), ...opts }).catch((e) => console.error(e)),
    [api],
  );

  const onChange = (elements, appState) => {
    const isPen = appState.activeTool.type === "custom" && appState.activeTool.customType === "pen";
    if (isPen !== penActive) setPenActive(isPen);
    if (appState.theme !== theme) setTheme(appState.theme);
    const v = getSceneVersion(elements);
    if (v !== saveRef.current.version) {
      const first = saveRef.current.version === -1;
      saveRef.current.version = v;
      if (first) return;
      clearTimeout(saveRef.current.timer);
      saveRef.current.dirty = true;
      setSaveStatus("unsaved");
      saveRef.current.timer = setTimeout(() => { saveRef.current.timer = 0; save(); }, 800);
    }
  };

  if (!loaded) return null;
  if (loadFailure) return <p role="alert">Board could not be loaded ({loadFailure}). <button onClick={() => location.reload()}>Retry</button></p>;
  return (
    <div className={`app ${penActive ? "pen-active" : ""} theme-${theme}`}>
      <Excalidraw
        excalidrawAPI={(a) => { setApi(a); window.excalidrawAPI = a; }}
        initialData={initialData}
        onChange={onChange}
        name={BOARD}
        handleKeyboardGlobally
        renderTopRightUI={() => <ClaudeControls api={api} />}
      >
        <MainMenu>
          <MainMenu.Item onSelect={() => setBoardsSignal((n) => n + 1)} shortcut="">Boards…</MainMenu.Item>
          <MainMenu.Item onSelect={() => ui.set((s) => ({ ...s, panel: true }))} shortcut="Alt+M">Comments…</MainMenu.Item>
          <MainMenu.Separator />
          <MainMenu.DefaultItems.LoadScene />
          <MainMenu.DefaultItems.SaveToActiveFile />
          <MainMenu.DefaultItems.Export />
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.Separator />
          <MainMenu.DefaultItems.ToggleTheme />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
          <MainMenu.Separator />
          <MainMenu.DefaultItems.Help />
        </MainMenu>
      </Excalidraw>
      <Boards board={BOARD} status={saveStatus} onOpen={openBoard} flush={flushBoard} retire={(value) => { saveRef.current.retired = value; }} openSignal={boardsSignal} />
      <PickHighlights view={view} />
      <CommentPins view={view} />
      {api && <SelectionBar api={api} view={view} board={BOARD} onAsk={ask} />}
      {api && <ThreadPopover api={api} view={view} board={BOARD} />}
      {api && <CommentsPanel api={api} />}
      {api && <ContextTray api={api} view={view} onAsk={ask} />}
      <ProposalsPanel api={api} />
      <StepPlayer api={api} />
      <CommandBar api={api} onAsk={ask} onToggleInk={() => {
        if (!api) return;
        const st = inkState(api);
        if (!st.count) return api.setToast({ message: "Claude hasn't drawn anything yet.", duration: 2000 });
        setInkHidden(api, !st.hidden);
      }} />
      <PenDock
        settings={penSettings}
        penId={penId}
        active={penActive}
        onPick={pickPen}
        onChange={updatePen}
        onReset={resetPen}
        stylusOnly={stylusOnly}
        setStylusOnly={(v) => { setStylusOnly(v); LS.set("whiteboard.stylusOnly", v); }}
      />
      {api && <PenInput api={api} active={penActive} penId={penId} pen={penSettings[penId]} stylusOnly={stylusOnly} />}
    </div>
  );
}
