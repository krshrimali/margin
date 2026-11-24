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
  circles, underlines, ✓ and ✗, strike-throughs, brackets, braces, parens and angle brackets (on either side or as an enclosing pair), missing arrows (looped around the side) and short
  handwritten notes. To make this precise, the server sends Claude a third snapshot where your content is grouped
  into labelled regions (R1, R2… for your content, D1, D2… for the shapes of its diagrams, C1… for its cards). Claude refers to those labels, and the app
  draws the strokes with the same pen engine you use. Notes go in free space; marks sit on your content but on
  their own layer. **Alt+I** hides or shows the layer, and the ▾ menu can also clear it. Ink is undoable like
  anything else.
- **Model, effort and edits, per answer.** The ▾ menu, the selection toolbar's *Ask*, the context tray and every
  comment box have three pickers. **Model** (Default, Opus, Sonnet, Haiku, Fable) and **Effort** (Default, Low …
  Max) apply to that answer; *Default* means Claude Code's own default, and that's what they start at on each load.
  The model and effort used are shown in the card header and on comment replies. **Edits** (remembered):
  *Auto* lets Claude change your content when your request asks for a change, *Ask first* shows Claude's edits in a
  panel (bottom left) where you **Preview**, **Apply** (one undo step) or **Discard** them, and *Off* never
  changes your content; Claude marks it up with ink instead.
- **Selection toolbar.** Select anything and a small toolbar appears above it: **💬 Comment**, **✦ Ask** (type a
  question about just that) and **＋ Pick**.
- **Picking context from several places** (Alt+P, or *Pick*). Picked items get numbered dashed outlines and appear
  in the **Context** tray at the bottom, so you can pan elsewhere, pick more, and then *Ask* or *Comment* on all of
  them together. Each area is sent to Claude as its own focus image. *Auto* scope uses your picks when there are
  any. Click a chip to jump to it; ✕ removes it.
- **Auto scope**, in order: picked items → your selection → what you wrote since Claude's last answer *plus anything
  it points at or touches* (an arrow to a box, a circle around a word) → the visible page. Asking about "the whole
  board" or "everything" widens it to the whole board.
- **Comments.** Comment on any element, your content or Claude's (select it → 💬 Comment or Alt+C). Threads show
  as pins next to what they're about; 💬 next to the Ask button (Alt+M) lists them, with resolved ones hidden by
  default. Post a plain comment, or mention **@claude** / press **✦ Ask Claude** to get a reply in the thread.
  Claude sees the commented elements and the whole thread (it continues the same session on follow-ups), and if
  you ask it to draw, mark up or change something, it does that on the board next to the commented element. The
  reply shows a link to what it drew. Comments are saved in the board file.
- **Drawing.** Besides Mermaid diagrams (`<diagram>`), Claude can draw freeform with shapes (`<draw>`, see
  `src/draw.js`): rectangles, rounded boxes, pills, ellipses, circles, diamonds, parallelograms, cylinders
  (databases), documents, hexagons, subroutines, trapezoids, queues, clouds, people, sticky notes, speech bubbles,
  curly braces, square, round and angle brackets (single, paired or standalone), dashed group boxes, tables, ticks, crosses, stars, warnings and numbered badges,
  joined by straight, curved or elbow arrows that stay attached when you move things. Shapes are placed on a grid
  whose columns and rows grow to fit their labels and arrow labels. Colours come from Excalidraw's palette. Mermaid
  nodes like `[(DB)]`, `{{prep}}`, `[/io/]`, `[[sub]]` now get their real shapes too, and diagrams keep the colours
  Claude gives them with `classDef` (otherwise they're drawn in Claude's violet ink). Drawings build up item by
  item while Claude writes them: lines draw themselves and shapes fade in.
- **Research.** Ask "research X online and then draw a flowchart / explain it" and Claude searches the web, reads
  a few sources, answers with a `Sources:` line and draws what it found.
- **Changing diagrams in place.** Claude can add a shape (also *between* two connected shapes, re-routing the
  arrow through it), add or remove arrows, besides recolouring, renaming, moving and deleting. New arrows bend
  around shapes in their way and match the existing arrows' colour.
- **Regenerate.** Select one of Claude's cards and press **↻ Regenerate** to ask the same question again (same focus,
  without the old answer), e.g. with another model or effort; the new card lands beside the old one, its header
  says which model answered. In a comment thread, **↻** on a reply asks again and adds the new reply below.
- **Walk me through it.** Tick *▶ Walk me through it, step by step* (one ask only) or just ask Claude to explain step
  by step: it draws the explanation in steps and a player at the bottom plays them one at a time with Claude's
  narration (**Next ▶** / **◀ Back**, or → ← and Space with nothing selected; Esc or *Show all* ends it). Saved
  boards always contain every step; *▶ Play steps* on a selected walkthrough (or the command bar) replays it.
- **Attachments.** Every ask box has **📎 File** (PDFs, images, text, code; up to 8 files of 15 MB) and **🔗 Link**;
  you can also drop files or links onto the box. Files are saved with the ask (`data/asks/<id>/attachments/`)
  and Claude reads them; links are fetched with WebFetch. E.g. attach a paper and ask "diagram this".
- **Suggestions in comments.** With edits on *Ask first*, edits Claude proposes from a comment appear inside the
  thread, each with ✓ / ✕, plus *Preview*, *Accept all* and *Reject all*. Edits from ordinary asks appear in the
  same form in a panel at the bottom left.
- **Command bar (Alt+K).** Type to run anything: ask (whatever doesn't match a command is sent to Claude as a
  question), comment, pick, open comments, toggle ink, play a walkthrough, switch model / effort / edits / cost
  cap, open boards. **Alt+A** opens the ask box for the selection.
- **Live cost and a cap.** While Claude works, the status row shows input↑ / output↓ tokens and the time; cards and
  comment replies show the final cost. **Cap $** (remembered) stops an answer that would cost more
  (`--max-budget-usd`); a stopped answer says so.
- **Export a thread.** ⤓ in a thread copies it as Markdown or downloads Markdown plus a PNG of the commented
  elements and everything Claude drew from the thread.
- **Picked context is saved** with the board, like comments.
- **Edits.** When you ask for existing content to change ("make it colourful", "rename X to Y", "fix the typo",
  "update your diagram", "remove that box"), Claude edits the regions in place instead of telling you how: it
  recolours fills, strokes, ink and text, retypes typed text and labels (boxes grow to fit), or removes regions.
  This works on your content and on its own diagrams, but not on its answer cards or on handwriting (handwriting can
  be recoloured but not retyped). A review or a question never changes your content silently. All edits from one
  answer are a single undo step (Ctrl+Z).
- **Diagram skill.** Claude is started with `--plugin-dir agent-plugin`, which gives it the `board-diagrams` skill
  (`agent-plugin/skills/board-diagrams/SKILL.md`). It loads the skill before drawing: when to use `<draw>` or
  `<diagram>`, which shape means what (standard flowchart conventions plus architecture shapes, UI windows,
  chevron stages, block arrows, triangles, octagons), braces / brackets / parens / angle brackets (single, paired
  or standalone), colour by category (3–5 hues plus grey, red only for problems; a drawing with no colours is
  coloured by shape kind automatically), design rules (one idea per drawing, hierarchy, reading order),
  layout recipes (architecture, comparison, timeline, stack, cycle, pipeline, pyramid, before/after) and templates. Codex doesn't load
  it, but gets the shape reference in its prompt.
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
| `CLAUDE_MODEL` | (CLI default) | default model for answers when the UI says *Default*, e.g. `opus`, `sonnet` |
| `CLAUDE_SELECT_MODEL` | `haiku` | model that picks relevant earlier answers |
| `CLAUDE_BIN` | `claude` | path to the Claude Code CLI |
| `CLAUDE_TIMEOUT_MS` | 600000 | per-request timeout |
| `WHITEBOARD_FALLBACK` | `codex` | `codex` or `none` |
| `CODEX_BIN` / `CODEX_MODEL` | `codex` / (Codex default) | fallback CLI and model |
| `WHITEBOARD_FORCE_CODEX` | | set to `1` to always use Codex (handy for testing) |

Each request is logged in `data/asks/<id>/` (snapshot, prompt and result), which helps with debugging.
