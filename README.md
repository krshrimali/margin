# Whiteboard ✦ Claude

A local whiteboard built on Excalidraw, with calligraphy pens and an **Ask Claude** button. Claude looks at what you drew
and writes its answer on the board, in empty space next to your content. It never draws over your content.

## Run

```sh
npm install        # also patches Excalidraw's pen renderer and copies its fonts locally
npm start          # builds the app, then serves it at http://127.0.0.1:3311
# or: npm run dev  # Vite dev server with hot reload at http://127.0.0.1:5173 (the API is built in)
```

## Boards

Click the board name at the top left (or ☰ → *Boards…*) to see all your boards with thumbnails. From there you can
search, create a **new board**, open one, or **rename** (double-click the name), **duplicate** or **delete** a board.
Deleted boards are moved to `data/trash/`, not erased.

Boards save automatically. The dot next to the name shows the state (green: saved, orange: saving, red: the server
can't be reached). **Ctrl+S** saves immediately. Each board is a plain Excalidraw file at
`data/boards/<id>.excalidraw`, with its title and thumbnail beside it. The app reopens on the last board you used;
`?board=<id>` in the URL opens a specific one. To save to or open a file anywhere else, use ☰ → *Save to…* or *Open*.

## Pens (dock on the right, Alt+1…8)

Ballpoint, Fineliner, Fountain pen, Calligraphy nib, Brush, Pencil, Marker, Highlighter. Click ⚙ (or click the active pen
again) to change colour, size, opacity, nib angle, hairline width and pressure mix. Under *Advanced* you can also set
thinning, smoothing, stabilizer, start and end taper, easing and flat caps. Stylus pressure is used when a pen tablet is
present. With a mouse, speed can stand in for pressure. "Stylus draws, fingers pan" turns on palm rejection.
Strokes are native Excalidraw elements, so select, move, erase, undo and export all work on them.

## Ask Claude

- **✦ Ask Claude** (or **Ctrl+Enter**) uses the default scope, **Auto**: your selection if you have one, otherwise
  whatever you wrote or drew since Claude's last answer, plus the area around it. So you can write a question by hand
  (or circle something and add a note) and press Ctrl+Enter.
- **▾** lets you type a question and pick a scope: **Auto**, **Selection**, **Visible page** or **Whole board**.
  Click *Make default* to change what the main button uses.
- Each ask runs in two steps:
  1. **Pick context.** A fast model (Haiku) looks at your new ink and the list of every earlier answer on the board,
     including the labels in their diagrams. It picks the answers that are relevant, and notes when you're replying
     to a specific card.
  2. **Answer.** The main model gets the snapshots, the board structure and the full text of only those answers.
     When you're replying to a card, it continues a fork of that card's Claude session, so it has the whole thread.
- The answer streams into a violet card (about 120 words) placed in free space next to what it responds to.
  Under the button you see what Claude is doing ("Picking relevant context…", "Reading src/log.rs…"), a timer
  and a ✕ to cancel. Claude adds an editable suggested diagram only when you're designing a flow or system.
- **Claude's ink.** Claude can also mark up your drawing with a pen in its own violet, like a teacher marking a page:
  circles, underlines, ✓ and ✗, strike-throughs, brackets, missing arrows (looped around the side) and short
  handwritten notes. To make this precise, the server sends Claude a third snapshot where your content is grouped
  into labelled regions (R1, R2… for your content, C1… for its cards). Claude refers to those labels, and the app
  draws the strokes with the same pen engine you use. Notes go in free space; marks sit on your content but on
  their own layer. **Alt+I** hides or shows the layer, and the ▾ menu can also clear it. Ink is undoable like
  anything else.
- **Diagram skill.** Claude is started with `--plugin-dir agent-plugin`, which gives it the `board-diagrams` skill
  (`agent-plugin/skills/board-diagrams/SKILL.md`). It loads the skill before drawing: which Mermaid shapes, arrows and
  styles survive the conversion onto the board, layout rules that avoid overlaps, and templates. Codex doesn't load it.
- **Project folder** (in the ▾ menu, saved per board): the folder Claude works in when your board refers to code.
- Claude runs as `claude -p --dangerously-skip-permissions` (headless, all tools allowed).

### When Claude is out of budget → Codex

If Claude Code reports that you're out of usage, the ask is retried with the Codex CLI (`codex exec`), using the same
prompt, images, labelled regions, ink and diagrams. It counts as out of usage when Claude reports its rate limit as
`rejected`, returns an error status of 402, 429 or 529, or says something like "usage limit reached" or
"credit balance too low". After that, Claude is skipped until the reset time it reported (15 minutes if it gave
none, 2 minutes for a temporary overload), so later asks go straight to Codex. Codex answers are labelled
"✦ Codex (Claude out of budget)". Codex doesn't stream token by token, so its answer appears all at once.
`GET /api/health` shows whether Claude is currently being skipped.

Environment variables:

| var | default | meaning |
|---|---|---|
| `PORT` | 3311 | server port |
| `CLAUDE_CWD` | `data/workspace` | default project folder (each board can override it in the UI) |
| `CLAUDE_MODEL` | (CLI default) | model for answers, e.g. `opus`, `sonnet` |
| `CLAUDE_SELECT_MODEL` | `haiku` | model that picks relevant earlier answers |
| `CLAUDE_BIN` | `claude` | path to the Claude Code CLI |
| `CLAUDE_TIMEOUT_MS` | 600000 | per-request timeout |
| `WHITEBOARD_FALLBACK` | `codex` | `codex` or `none` |
| `CODEX_BIN` / `CODEX_MODEL` | `codex` / (Codex default) | fallback CLI and model |
| `WHITEBOARD_FORCE_CODEX` | | set to `1` to always use Codex (handy for testing) |

Each request is logged in `data/asks/<id>/` (snapshot, prompt and result), which helps with debugging.
