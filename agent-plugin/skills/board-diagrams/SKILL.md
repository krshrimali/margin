---
name: board-diagrams
description: How to draw flowcharts and other diagrams on the Margin whiteboard, so they convert cleanly into hand-drawn Excalidraw shapes under your answer card. Use whenever you are about to write a <diagram> block — a flowchart, a corrected version of the user's flow or system, a sequence of messages, a state machine, a class or data model — or when the user asks you to "draw", "sketch", "diagram" or "show the flow".
---

# Drawing diagrams on the board

Your `<diagram>` block is Mermaid source. The app converts it into native Excalidraw elements (via
`@excalidraw/mermaid-to-excalidraw`, laid out by Pele), redraws it in your violet ink with a hand-drawn stroke,
and places it under your answer card with the title "Suggested diagram". The user can then move, edit and
extend every box and arrow. Everything below is what that pipeline actually does, so follow it closely.

## 1. Decide whether to draw at all

Draw only when a picture beats words:

- the user asked you to draw, sketch or diagram something, or
- the user is designing a system, flow or process and a corrected or completed version helps more than a list
  of fixes.

Don't draw for plain Q&A, and don't draw what's already on the board. To fix one or two things in the user's
own drawing, use ink instead (circle, cross, arrow, note on their regions). Draw a diagram when the fix is a
redesign: re-ordered steps, a new branch, a missing component, a different structure.

When you do draw, the card and the diagram split the work. The card says *why* (what was wrong, what changed),
in 2–4 bullets. The diagram shows *what* (the corrected shape). Don't describe the diagram node by node in the
card.

## 2. Output contract

```
<answer>
- short bullets…
</answer>
<diagram>
flowchart TD
  A[Request] --> B{Cached?}
  B -->|yes| C[Return cached]
  B -->|no| D[Query DB]
</diagram>
```

- Raw Mermaid inside the tags. Code fences are stripped, but you don't need them.
- One diagram per answer. Leave the whole `<diagram>` tag out when there's none.
- **It streams.** Every time a full line arrives, the app re-parses everything so far and redraws it. A line
  that doesn't parse yet (for example an unclosed `{` or `alt … end` block) is skipped and the last good drawing
  stays. So:
  - write the header line first, then edges **in reading order** (top to bottom along the flow), so the
    diagram visibly grows the way it is read;
  - give a node its label the first time you mention it (`A[Request] --> B{Cached?}`) instead of declaring all
    nodes up front and all edges after;
  - put `classDef`/`class` lines last; they're cosmetic.

## 3. Pick the diagram type

| Use | When | Notes |
|---|---|---|
| `flowchart TD` | **Default.** Processes, decisions, request paths, architectures | Top-down fits under the card best |
| `flowchart LR` | A short linear pipeline (≤ 5 steps, few branches) | Wide diagrams get cramped |
| `sequenceDiagram` | Who sends what to whom, in order (protocols, auth, API calls) | ≤ 5 participants, ≤ 10 messages |
| `stateDiagram-v2` | Lifecycles: an order, a connection, a job, a UI mode | `[*]` start/end become circles |
| `classDiagram` | Types with fields/methods and their relations | Keep members to 2–4 per class |
| `erDiagram` | Database tables and cardinality | Crow's-foot ends are drawn natively |

Avoid `pie`, `mindmap`, `gitGraph`, `journey`, `sankey` and other types: they're inserted as a flat picture,
not editable shapes, and don't get your ink style. Gantt, quadrant and timeline convert but rarely fit an
answer card.

## 4. Flowchart vocabulary (verified against the converter)

Node shapes — only these render as distinct shapes:

| Syntax | Drawn as | Use it for |
|---|---|---|
| `A[Text]` | rectangle | a step, a component |
| `A(Text)` | rounded rectangle | a softer step, a service |
| `A([Text])` | rounded rectangle | start / end |
| `A{Text?}` | diamond | a decision (label it as a question) |
| `A((Text))` | circle | a junction, an event, a single-word state |
| `A(((Text)))` | double circle | a terminal/accepting state |

`[(DB)]`, `{{hex}}`, `[/para/]`, `[[sub]]` and `>flag]` all fall back to a **plain rectangle**. Don't rely on them
to mean anything; say it in the label instead: `DB[(Postgres)]` → `DB[Postgres DB]`.

Edges:

| Syntax | Drawn as | Convention on the board |
|---|---|---|
| `A --> B` | arrow | normal flow |
| `A -->\|yes\| B` | arrow with label | decision exits, named calls |
| `A -.-> B` | dashed arrow | optional, async, background, "later" |
| `A ==> B` | thick arrow | the main path, or the part you changed |
| `A --- B` | line, no head | association, "talks to" |
| `A <--> B` | two-headed arrow | genuinely two-way (one edge, not two) |
| `A --o B` / `A --x B` | circle / bar head | rarely needed; bar can mean "blocked" |

Styling: everything is redrawn in your ink colour with a transparent fill, so `fill`, `stroke` and `color`
are ignored. **Dashes and stroke width survive.** Use them to show what's new or what's wrong:

```
  classDef new stroke-dasharray: 6 4
  classDef key stroke-width: 4px
  class C,D new
```

Say what the convention means in the card ("dashed = new"), the first time you use it.

Links survive too: `click A "https://…"` makes the box clickable. Useful to point at a doc or a file URL.

Font: every label (nodes, edges, sequence messages, class members, state names) is drawn in **Excalifont**,
Excalidraw's default hand-drawn font, at 16px, the same font the user gets with Excalidraw's text tool.
Boxes are sized and laid out with Excalifont's measurements. You can't change it: `font-family`, `font-size`
and `font-weight` in `style`/`classDef` are ignored, as are `<b>`, `<i>`, `<code>`, markdown and Font Awesome
icons (`fa:fa-…`). Excalifont runs wider than a typical UI font, which is another reason to keep labels short.
Put emphasis in the wording or use a thick border (`stroke-width`), not in typography.

## 5. Layout rules that keep it clean

The board can't hand-fix a layout, so prevent overlaps up front:

- **At most 10 nodes** (fewer is better; 5–7 reads best under a card). If it needs more, draw the part
  that changed and put "…" nodes at the edges (`X[... rest of pipeline]`).
- **No subgraphs.** Their titles collide with nodes; the app may flatten them anyway and drop the title. Put the
  group in the label: `API[API server: auth]`, `W1[Worker 1]`.
- **Labels: 1–4 words per node**, a 5th only if unavoidable. Use `<br>` for a deliberate second line:
  `B["Retry<br>max 3x"]`. Put numbers and details in node labels, not on edges.
- **Edge labels: 3 words or fewer.** Anything over 18 characters is cut at a word boundary.
- **One edge per pair of nodes.** For two-way, use a single `<-->`.
- **Few back-edges.** One retry loop is fine; two or more loops tangle. Prefer an explicit node
  (`F[Give up]`) over a second loop.
- **Decisions have 2 (at most 3) labelled exits**: `|yes|` / `|no|`, `|hit|` / `|miss|`.
- **Fan-out ≤ 4** from one node. Past that, insert a grouping node.

The app renders several variants (as written, with shortened edge labels, without subgraphs, as TD, as LR)
and keeps the one with the fewest overlapping labels and crossing arrows. Your direction may get flipped if it
overlaps, so following the rules above is what keeps your choice.

## 6. Syntax that breaks parsing

- `end` as a node id (`B --> end`): reserved. Use `Done`, `Stop`, `Fin`.
- A node id starting with `o` or `x` right after `--` (`A --oops`) reads as a circle/cross edge. Use
  `A --> Oops` with a space, or capitalised ids.
- Parentheses, brackets, quotes, `:`, `#`, `;`, `|` inside a label: wrap the label in double quotes,
  `A["Retry (3x)"]`. Inside quotes use `#quot;` for a literal quote.
- Markdown and HTML in labels are stripped (`**bold**` → `bold`). Write plain text.
- Node ids: short, letters/digits only (`A`, `Auth`, `Q1`). The label is what the user sees.
- In sequence diagrams, keep `participant X as Long name` on one line, and close every `alt`/`loop`/`opt`
  with `end`.

## 7. Write labels in the user's words

Diagram labels are saved with your answer. Later, a context picker reads them to decide which earlier card the
user is pointing at when they draw an arrow or write "this one". Name boxes with the user's own terms from the
board ("Ingest", "Ranker", "Kafka") rather than generic ones ("Service A", "Step 2"), so their follow-ups find
the right card.

## 8. Templates

Decision with a retry loop:

```
flowchart TD
  A([Upload file]) --> B{Valid?}
  B -->|no| C[Show error]
  B -->|yes| D[Store in S3]
  D --> E{Scan OK?}
  E -->|fail| F[Quarantine]
  E -->|pass| G([Publish])
  F -.->|retry once| D
```

Review of the user's design (dashed = what you added):

```
flowchart TD
  U[Client] --> G[API gateway]
  G --> R[Rate limiter]
  R --> S[Order service]
  S --> Q[Queue]
  Q --> W[Worker]
  W --> DB[Orders DB]
  S -.-> C[Cache]
  classDef new stroke-dasharray: 6 4
  class R,C new
```

Short pipeline:

```
flowchart LR
  A[Parse] --> B[Validate] --> C[Transform] --> D[Load]
```

Request/response:

```
sequenceDiagram
  participant B as Browser
  participant A as Auth server
  participant API
  B->>A: login
  A-->>B: access token
  B->>API: request + token
  API-->>B: data
```

Lifecycle:

```
stateDiagram-v2
  [*] --> Pending
  Pending --> Paid: pay
  Pending --> Cancelled: timeout
  Paid --> Shipped: ship
  Shipped --> [*]
  Cancelled --> [*]
```

## 9. Checklist before you emit

1. Is a diagram really better than words or ink here?
2. Type: flowchart TD unless another row in section 3 clearly fits.
3. ≤ 10 nodes, no subgraphs, one edge per pair, ≤ 1–2 back-edges.
4. Node labels ≤ 4 words in the user's terms; edge labels ≤ 3 words; punctuation quoted.
5. Only the six real shapes; meaning carried by labels, dashes and thick lines, not colour.
6. Lines in reading order, labels on first mention, `classDef` last.
7. No `end` ids. Every `alt`/`loop` closed.
8. The card explains why. It doesn't re-list the boxes.
