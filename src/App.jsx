import { useCallback, useEffect, useRef, useState } from "react";
import { Excalidraw, MainMenu, getSceneVersion, serializeAsJSON } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import PenInput from "./PenInput.jsx";
import PenDock from "./PenDock.jsx";
import { PRESETS, loadPenSettings, savePenSettings } from "./pens.js";
import { clearInk, inkState, setInkHidden } from "./ink.js";
import { SCOPES, SCOPE_HINTS, askClaude, cancelAsk, onRunningChange } from "./claude.js";

const BOARD = new URLSearchParams(location.search).get("board") || "default";
const LS = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
};

const loadBoard = async () => {
  try {
    const r = await fetch(`/api/board?name=${encodeURIComponent(BOARD)}`);
    if (!r.ok) return { appState: { currentItemRoughness: 0 }, scrollToContent: true };
    const data = await r.json();
    return { ...data, scrollToContent: true };
  } catch {
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

const SCOPE_SHORT = { selection: "Selection", new: "New ink", viewport: "Page", board: "Board" };

function ClaudeControls({ api }) {
  const [open, setOpen] = useState(false);
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

  const run = useCallback(
    (s, q) => {
      if (!api) return;
      askClaude(api, { scope: s, question: q, cwd }).catch((e) => console.error(e));
    },
    [api, cwd],
  );

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
    run(scope, question);
    setQuestion("");
  };

  return (
    <div className="claude-controls">
      <div className="claude-split">
        <button className="claude-btn" onClick={() => run(defaultScope, "")} title={`Ask Claude: ${SCOPE_HINTS[defaultScope]} (Ctrl+Enter)`}>
          {running.length ? <span className="spinner" /> : "✦"} <span className="claude-label">Ask Claude</span>
          <small>{SCOPES[defaultScope]}</small>
        </button>
        <button className="claude-caret" onClick={() => { setScope(defaultScope); refreshInk(); setOpen((o) => !o); }} title="Ask with a question, choose scope or project folder">▾</button>
      </div>

      {running.length > 0 && (
        <div className="claude-running">
          {running.map((r) => (
            <div key={r.id} className="run-row">
              <span className="spinner dark" />
              <span className="run-status" title={r.status}>{SCOPE_SHORT[r.scope] || r.scope} · {r.status || "Working…"}</span>
              <span className="run-time">{Math.round((Date.now() - r.startedAt) / 1000)}s</span>
              <button className="run-cancel" title="Cancel" onClick={() => cancelAsk(r.id)}>✕</button>
            </div>
          ))}
        </div>
      )}

      {open && (
        <div className="claude-pop" onKeyDown={(e) => e.stopPropagation()}>
          <textarea
            autoFocus
            placeholder="Optional. You can also just write your question on the board."
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
          <p className="hint">{SCOPE_HINTS[scope]}</p>
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
          <p className="hint">Claude can read and run things in this folder when your board refers to code. It's saved for this board; leave it empty to use the default.</p>
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
  const [api, setApi] = useState(null);
  const [penSettings, setPenSettings] = useState(loadPenSettings);
  const [penId, setPenId] = useState(() => LS.get("whiteboard.pen", "fountain"));
  const [penActive, setPenActive] = useState(false);
  const [stylusOnly, setStylusOnly] = useState(() => LS.get("whiteboard.stylusOnly", false));
  const [theme, setTheme] = useState("light");
  const saveRef = useRef({ version: -1, timer: 0 });

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

  const save = useCallback(() => {
    if (!api) return;
    const elements = api.getSceneElements().filter((e) => !e.customData?.claudePending);
    const body = serializeAsJSON(elements, api.getAppState(), api.getFiles(), "local");
    return fetch(`/api/board?name=${encodeURIComponent(BOARD)}`, { method: "PUT", body, keepalive: body.length < 60000 }).catch(() => {});
  }, [api]);

  useEffect(() => {
    const flush = () => { if (saveRef.current.timer) { clearTimeout(saveRef.current.timer); save(); } };
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, [save]);

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
      saveRef.current.timer = setTimeout(() => { saveRef.current.timer = 0; save(); }, 800);
    }
  };

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
