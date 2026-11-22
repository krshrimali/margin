import { useEffect, useMemo, useRef, useState } from "react";

const ago = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
};

const api = {
  list: () => fetch("/api/boards").then((r) => r.json()).then((d) => d.boards || []),
  create: (title, from) =>
    fetch("/api/boards", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, from }) }).then((r) => r.json()),
  rename: (id, title) =>
    fetch(`/api/boards/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) }),
  remove: (id) => fetch(`/api/boards/${id}`, { method: "DELETE" }),
};

/**
 * Board switcher: the current board's name + save status at the top left;
 * click for the list of boards (thumbnails, search, new, rename, duplicate, delete).
 */
export default function Boards({ board, status, onOpen, openSignal }) {
  const [open, setOpen] = useState(false);
  const [boards, setBoards] = useState([]);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [editing, setEditing] = useState(null); // board id being renamed
  const [editTitle, setEditTitle] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(null);
  const panelRef = useRef(null);

  const refresh = () => api.list().then(setBoards).catch(() => {});
  useEffect(() => { refresh(); }, [status === "saved"]);
  useEffect(() => { if (openSignal) { setOpen(true); refresh(); } }, [openSignal]);
  useEffect(() => {
    if (!open) return;
    const close = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target) && !e.target.closest(".board-pill")) setOpen(false);
    };
    window.addEventListener("pointerdown", close, true);
    return () => window.removeEventListener("pointerdown", close, true);
  }, [open]);

  const current = boards.find((b) => b.id === board);
  const title = current?.title || (board === "default" ? "My board" : board);
  useEffect(() => { document.title = `${title} · Whiteboard ✦ Claude`; }, [title]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? boards.filter((b) => b.title.toLowerCase().includes(q)) : boards;
  }, [boards, query]);

  const create = async () => {
    const t = newTitle.trim() || `Untitled board ${new Date().toLocaleDateString()}`;
    const { id } = await api.create(t);
    onOpen(id);
  };
  const rename = async (id) => {
    await api.rename(id, editTitle);
    setEditing(null);
    refresh();
  };
  const duplicate = async (b) => {
    const { id } = await api.create(`${b.title} (copy)`, b.id);
    await refresh();
    setEditing(id);
    setEditTitle(`${b.title} (copy)`);
  };
  const remove = async (b) => {
    await api.remove(b.id);
    setConfirmDelete(null);
    if (b.id === board) {
      const next = boards.find((x) => x.id !== b.id);
      if (next) onOpen(next.id);
      else onOpen((await api.create("My board")).id);
    } else refresh();
  };

  const statusText = { saved: "Saved", saving: "Saving…", unsaved: "Unsaved changes", error: "Not saved: server unreachable" }[status] || "";

  return (
    <div className="boards" onKeyDown={(e) => e.stopPropagation()}>
      <button className="board-pill" onClick={() => { setOpen((o) => !o); refresh(); }} title={`${title}: ${statusText} (Ctrl+S saves now)`}>
        <span className={`save-dot ${status}`} />
        <span className="board-title">{title}</span>
        <span className="caret">▾</span>
      </button>

      {open && (
        <div className="boards-panel" ref={panelRef}>
          <div className="boards-head">
            <input autoFocus placeholder="Search boards…" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setOpen(false)} />
            <button className="claude-btn small" onClick={() => { setCreating(true); setNewTitle(""); }}>+ New board</button>
          </div>
          {creating && (
            <div className="new-row">
              <input
                autoFocus
                placeholder="Board name"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") create(); if (e.key === "Escape") setCreating(false); }}
              />
              <button className="claude-btn small" onClick={create}>Create ⏎</button>
              <button className="link" onClick={() => setCreating(false)}>Cancel</button>
            </div>
          )}
          <div className="boards-grid">
            {shown.map((b) => (
              <div key={b.id} className={`board-card ${b.id === board ? "current" : ""}`}>
                <button className="thumb" onClick={() => b.id !== board && onOpen(b.id)} title={b.id === board ? "Current board" : `Open ${b.title}`}>
                  {b.thumb ? <img src={`/api/board/thumb?name=${b.id}&v=${b.thumb}`} alt="" /> : <span className="empty">{b.elements ? "no preview yet" : "empty"}</span>}
                </button>
                {editing === b.id ? (
                  <input
                    className="rename"
                    autoFocus
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") rename(b.id); if (e.key === "Escape") setEditing(null); }}
                    onBlur={() => rename(b.id)}
                  />
                ) : (
                  <div className="board-name" onDoubleClick={() => { setEditing(b.id); setEditTitle(b.title); }}>{b.title}</div>
                )}
                <div className="board-meta">
                  {ago(b.updated)}{b.elements != null ? ` · ${b.elements} item${b.elements === 1 ? "" : "s"}` : ""}{b.id === board ? " · open" : ""}
                </div>
                {confirmDelete === b.id ? (
                  <div className="board-actions">
                    <span>Delete?</span>
                    <button className="link danger" onClick={() => remove(b)}>Yes</button>
                    <button className="link" onClick={() => setConfirmDelete(null)}>No</button>
                  </div>
                ) : (
                  <div className="board-actions">
                    <button className="link" onClick={() => { setEditing(b.id); setEditTitle(b.title); }}>Rename</button>
                    <button className="link" onClick={() => duplicate(b)}>Duplicate</button>
                    <button className="link danger" onClick={() => setConfirmDelete(b.id)}>Delete</button>
                  </div>
                )}
              </div>
            ))}
            {!shown.length && <p className="hint">No boards match “{query}”.</p>}
          </div>
          <p className="hint">Boards save automatically to data/boards/ on this machine. Deleted boards go to data/trash/. Ctrl+S saves now; to save a file, use the ☰ menu.</p>
        </div>
      )}
    </div>
  );
}
