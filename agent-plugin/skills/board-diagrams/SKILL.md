---
name: board-diagrams
description: How to draw on the Margin whiteboard — flowcharts (Mermaid <diagram>) and freeform visual explanations (<draw> with shapes, braces, tables, colours) — so they come out clear, well laid out and good-looking. Use whenever you are about to write a <diagram> or <draw> block, or when the user asks you to "draw", "sketch", "diagram", "visualise", "explain with a picture", "show the flow" or to research something and draw it.
---

# Drawing on the board

You have two ways to draw. Both become native, editable Excalidraw shapes placed under your answer card (or next
to the commented element when you reply in a comment thread), and both stream: the user watches the picture build
item by item, so write in reading order.

| Use | Block | Best for |
|---|---|---|
| Mermaid, laid out for you | `<diagram>` | Processes with decisions, request paths, sequences of messages, state machines, data models |
| Shapes you place on a grid | `<draw>` | Explainers, architectures with different kinds of things (people, clouds, databases, documents), comparisons, tables, timelines, layered stacks, cycles, annotated concepts, "before / after" |

Rule of thumb: if the picture is mostly **boxes joined by arrows with branches**, use `<diagram>`. If it's about
**what things are and how they relate** — kinds, groups, parts of a whole, a comparison — use `<draw>`.
Use at most one per answer.

## 1. Decide whether to draw at all

Draw when the user asks you to draw, sketch, diagram, visualise or explain something visual, or is designing a
system / flow and a corrected version helps more than a list of fixes. Don't draw for plain Q&A, and don't
redraw what's already on the board: to fix one or two things in the user's drawing, use ink or edits instead.

The card and the drawing split the work. The card says **why** (the insight, what changed, 2–4 bullets). The
drawing shows **what**. Don't narrate the drawing node by node in the card.

### Research, then draw

When asked to "research X and draw / explain": search first (WebSearch, 2–4 focused queries), read the 2–4 best
sources (WebFetch), then draw from what you learned. Put concrete facts in labels ("p99 40 ms", "since 2024"),
keep the card to the key takeaways, and end the card with `Sources: domain.com, other.org`.

## 2. Design principles (apply to every drawing)

1. **One idea per drawing.** Give it a title (`{"title":"…"}`) that states the idea, not the topic:
   "Cache misses hit the database" beats "Caching".
2. **Shape = kind of thing.** Pick the shape by meaning (tables below) and use it consistently: all databases are
   cylinders, all people are `person`, all external services are clouds. Viewers decode shapes before reading.
3. **Colour = category or emphasis, never decoration.** At most 3–4 colours in one drawing, roughly 60/30/10:
   most shapes neutral or one main hue, a secondary hue for a second category, one accent for the thing that
   matters. Meaning must also be in the words (colour alone isn't enough); add a small legend note if you use
   colour to encode categories.
4. **Semantic colours** (match the user's expectations):
   - `red` — errors, risks, the bottleneck, "wrong". Never for ordinary items.
   - `green` — success, done, healthy, "new / added", the recommended option.
   - `yellow` — notes, assumptions, highlights (sticky notes are yellow by default).
   - `blue` — the main system / your components. Good default primary.
   - `violet` / `purple` — the user's focus, AI / Claude, special.
   - `orange` — warnings, in-progress, attention.
   - `teal` / `cyan` — data, storage, infrastructure.
   - `grey` — context, external, out-of-scope, "unchanged".
5. **Hierarchy by size and weight.** The key element can be `"bold":true` or bigger (`"w":1.1`); secondary items
   normal; context items grey. One bold item per drawing.
6. **Reading direction.** Left → right for time and pipelines, top → bottom for layers and hierarchies. Put the
   start top-left. Keep arrows flowing one way; one back-edge at most.
7. **Alignment and whitespace.** Use whole grid cells; line related items up in the same row or column. Leave an
   empty column or row between groups rather than cramming. 5–12 shapes reads best; 20+ is a poster.
8. **Labels: 1–4 words, in the user's terms.** Numbers and specifics in labels ("3 retries", "~95% hit"). Arrow
   labels ≤ 3 words. Use `\n` for a deliberate second line.
9. **Group, then summarise.** A `group` box around related shapes names a boundary ("VPC", "Frontend"). A `brace`
   beside several items summarises them ("one round trip", "Phase 1"). A `bracket` is a lighter version.
10. **Point at the insight.** Finish with one annotation that carries the message: a `note`, a `brace` with
    text, a `warning` mark on the risk, a `check` on the recommendation, or numbered `number` badges for steps.

## 3. `<draw>` reference

One JSON object per line (so it can stream). First line may be options. Grid cells: `"at":[col,row]`, fractions
allowed (`[1.5,0]` sits between columns). Columns and rows automatically widen to fit their shapes, so you only
choose the arrangement — never pixel positions. Items are drawn in the order written, so write them in reading order:
title, then shapes along the flow, then arrows, then groups/braces/notes.

```
<draw>
{"title":"How a CDN serves a page","style":"color"}
{"id":"u","shape":"person","text":"Visitor","at":[0,1]}
{"id":"e","shape":"cloud","text":"Edge cache","at":[1,1],"color":"blue"}
{"id":"o","shape":"cylinder","text":"Origin DB","at":[2,1],"color":"teal"}
{"shape":"arrow","from":"u","to":"e","label":"GET /"}
{"shape":"arrow","from":"e","to":"o","label":"miss","dashed":true}
{"shape":"brace","around":["e","o"],"side":"bottom","text":"only on a cache miss"}
{"shape":"note","text":"Hit ratio ~95%","at":[1,2.2]}
</draw>
```

Options line: `"title"`, `"style":"color"` (default: coloured fills, dark outlines) or `"style":"ink"` (everything
in your violet pen, no fills — use it for quick sketches, corrections, or when the board is hand-drawn and
monochrome).

### Shapes that hold text (choose by meaning)

| shape | looks like | use for (flowchart convention in brackets) |
|---|---|---|
| `rect` | rectangle | a step, a component, a thing (process) |
| `rounded` | rounded rectangle | a service, a softer step, a UI screen |
| `pill` | stadium | start / end (terminator) |
| `diamond` | diamond | a decision — label it as a question |
| `parallelogram` | slanted box | input / output, data in or out (data, I/O) |
| `cylinder` | database drum | database, storage, a table, a bucket (stored data) |
| `document` | page with wavy bottom | a document, report, file, config file (document) |
| `hexagon` | hexagon | preparation, setup, config, a condition to meet (preparation) |
| `subroutine` | box with side bars | a reusable sub-process, a library, a function (predefined process) |
| `trapezoid` | trapezoid | a manual step (manual operation) |
| `queue` | horizontal drum | a queue, stream, topic, buffer |
| `cloud` | cloud | the internet, a third-party / external service, "the cloud" |
| `person` | stick figure + name | a user, actor, role, team |
| `ellipse` / `circle` | oval / circle | an event, a concept in a concept map, a hub, a state |
| `note` | sticky note (yellow) | an assumption, a tip, a side remark, a number to remember |
| `callout` | speech bubble | what someone says / asks, a quote, a UI message |

Keys: `id` (to connect it), `text`, `at`, `color` (name or `#hex`), `fill:"none"` for an outline only,
`"bold":true`, `"dashed":true` (planned / optional / new), `"w"` / `"h"` in cells to resize, `"size":"s|m|l|xl"`
for the label, `"link":"https://…"`.

### Connectors

`{"shape":"arrow","from":"a","to":"b","label":"calls"}` — keys: `dashed` (async, optional, later), `thick`
(main path), `ends:"both"` (two-way), `route:"curve"` (to avoid crossing a shape, or for a back-edge),
`route:"elbow"` (tidy right angles in grids), `head:"dot"|"bar"`. Use `shape:"line"` for an association
without direction. One arrow per pair of shapes.

### Annotations

| item | keys | use |
|---|---|---|
| `brace` | `around:[ids]`, `side:"left|right|top|bottom"`, `text` | curly brace summarising a range: phases, "these 3 are the read path" |
| `bracket` | same | square bracket, a lighter grouping |
| `group` | `around:[ids]`, `text`, `color` | dashed boundary box with a title: a system, a team, a network zone |
| `text` / `title` | `text`, `at`, `size`, `align`, `color` | free text, headings, axis labels, a legend |
| `table` | `rows:[[…],[…]]`, `at`, `color` | comparisons; first row is the header |
| `check` / `cross` / `star` / `warning` | `near:id` or `at` | verdicts on a shape: right, wrong, recommended, risky |
| `number` | `text:"1"`, `near:id` | numbered steps on an architecture: 1 → 2 → 3 |

## 4. Layout recipes for `<draw>`

- **Architecture**: actors (`person`) in column 0, entry points (`cloud`/`rounded`) column 1, services column 2,
  data (`cylinder`, `queue`) column 3. `group` around each zone, `number` badges for the request path.
- **Comparison**: a `table` (≤ 5 columns × 6 rows), header row first, then a `check`/`star` near the winner or a
  `note` with the recommendation. Or two columns of shapes with a `brace` per side.
- **Timeline**: shapes in one row, `at:[0,0] … [n,0]`, arrows between, dates in labels, a `brace` over a period.
- **Layered stack**: rectangles in one column, `w:1.6`, top = closest to the user, one colour per layer family,
  braces on the side naming tiers ("runs in browser").
- **Cycle**: 4–6 ellipses around a ring (e.g. `[1,0] [2,1] [1,2] [0,1]`), `route:"curve"` arrows.
- **Concept map**: the central idea as a bold `ellipse` in the middle, related ideas around it, labelled lines.
- **Before / after**: two groups side by side (`group` "Before", grey; `group` "After", green), with a `cross`
  on the problem and a `check` on the fix.
- **Explaining one thing**: the thing in the middle, `callout` / `note` items around it naming its parts, with
  arrows from the notes to it.

## 5. `<diagram>` (Mermaid) reference

```
<diagram>
flowchart TD
  A([Upload file]) --> B{Valid?}
  B -->|no| C[/Show error/]
  B -->|yes| D[(Store in S3)]
  D --> E{Scan OK?}
  E -->|fail| F[Quarantine]
  E -->|pass| G([Publish])
  F -.->|retry once| D
  classDef bad fill:#ffc9c9,stroke:#e03131
  classDef good fill:#b2f2bb,stroke:#2f9e44
  class C,F bad
  class G good
</diagram>
```

Types: `flowchart TD` (default), `flowchart LR` (short pipelines), `sequenceDiagram` (≤ 5 participants,
≤ 10 messages), `stateDiagram-v2`, `classDiagram`, `erDiagram`. Avoid pie, mindmap, gitGraph, journey, sankey:
they become flat pictures, not editable shapes.

Flowchart node shapes — all of these are drawn as real shapes on the board:

| Syntax | Drawn as | Use it for |
|---|---|---|
| `A[Text]` | rectangle | a step |
| `A(Text)` / `A([Text])` | rounded / stadium | a service / start-end |
| `A{Text?}` | diamond | a decision |
| `A((Text))` / `A(((Text)))` | circle / double circle | an event, junction / final state |
| `A[(Text)]` | cylinder | a database, storage |
| `A{{Text}}` | hexagon | preparation, config |
| `A[/Text/]` | parallelogram | input / output |
| `A[/Text\]` | trapezoid | manual step |
| `A[[Text]]` | box with side bars | sub-process |
| `A>Text]` | flag / callout | a signal, notification |

Edges: `-->` arrow, `-->|label|` labelled, `-.->` dashed (async, optional), `==>` thick (main path), `---` line,
`<-->` two-way.

**Colour**: without any `classDef`/`style` colours, the diagram is drawn in your violet ink (good for corrections
and quick sketches). With `classDef name fill:#hex,stroke:#hex` (hex colours only), the colours are kept, so use
them with the same semantic palette as above. Good pairs (stroke / fill): red `#e03131`/`#ffc9c9`, green
`#2f9e44`/`#b2f2bb`, blue `#1971c2`/`#a5d8ff`, yellow `#f08c00`/`#ffec99`, violet `#6741d9`/`#d0bfff`,
orange `#e8590c`/`#ffd8a8`, teal `#099268`/`#96f2d7`, grey `#495057`/`#e9ecef`. `stroke-dasharray: 6 4` and
`stroke-width: 4px` also survive; say in the card what dashed or thick means.

Layout rules: ≤ 12 nodes, no subgraphs (put the group in the label, or use `<draw>` with `group`), node labels
1–4 words, edge labels ≤ 3 words, one edge per pair, ≤ 1–2 back-edges, decisions have 2–3 labelled exits,
fan-out ≤ 4. The app tries several variants (as written, shortened labels, TD, LR) and keeps the cleanest.

Syntax traps: `end` is reserved as a node id (use `Done`); ids starting with `o`/`x` right after `--` read as
edge heads; quote labels with punctuation `A["Retry (3x)"]`; no markdown or HTML in labels; close every
`alt`/`loop` in sequence diagrams. Font is always Excalifont 16px.

## 6. Walkthroughs (step by step)

When the user asks to explain step by step, walk through, teach, or "animate" a process (or the request says
STEP-BY-STEP), split a `<draw>` into steps. A marker line starts a step; everything after it belongs to that
step; items before the first marker (the title, a legend) are always shown:

```
<draw>
{"title":"What happens when you type a URL"}
{"step":1,"say":"The browser checks its cache, then asks a DNS resolver for the IP."}
{"id":"b","shape":"person","text":"Browser","at":[0,1]}
{"id":"r","shape":"rounded","text":"DNS resolver","at":[1,1],"color":"blue"}
{"shape":"arrow","from":"b","to":"r","label":"example.com?"}
{"step":2,"say":"With the IP, the browser opens a TCP + TLS connection to the server."}
{"id":"s","shape":"cloud","text":"Web server","at":[2,1],"color":"teal"}
{"shape":"arrow","from":"b","to":"s","label":"TLS handshake","route":"curve"}
{"step":3,"say":"The server returns HTML; the browser parses it and fetches CSS, JS and images."}
{"id":"h","shape":"document","text":"HTML","at":[2,2]}
{"shape":"arrow","from":"s","to":"h"}
</draw>
```

The user plays it one step at a time and reads your `say` line under the board, so: 3–7 steps, one idea per
step, 1–2 plain sentences per `say` that explain *why*, not just what appears. Lay the final picture out as a
whole first (all steps visible must still read well), then cut it into steps in reading order. Keep the card to
a short summary: the narration carries the explanation.

## 7. Changing an existing diagram (instead of redrawing)

To change the structure of a diagram already on the board — the user's or your own — use edit commands on its
labelled regions rather than drawing a new one (when edits are allowed):

- insert a step: `{"do":"add","shape":"cylinder","text":"Redis cache","between":["D2","D3"],"color":"teal"}` —
  placed between them, and the arrow between them is re-routed through it (keeping its label);
- add beside: `{"do":"add","shape":"document","text":"Audit log","near":"D5","side":"below","from":"D5","label":"writes"}`;
- connect / disconnect: `{"do":"connect","from":"D2","to":"R4","label":"retry","dashed":true}`,
  `{"do":"disconnect","from":"D2","to":"D3"}`;
- plus `style`, `relabel`, `move`, `delete` for everything else.

New arrows bend around shapes in their way and match the colour of existing arrows. Redraw from scratch only when
most of the diagram changes.

## 8. Write labels in the user's words

Labels are saved with the drawing, and a context picker later uses them to find which earlier drawing the user is
pointing at. Use the user's own terms from the board ("Ingest", "Ranker", "Kafka"), not "Service A".

## 9. Checklist before you emit

1. Is a picture better than words or ink here? `<diagram>` or `<draw>`?
2. Title states the idea. 5–12 shapes. One bold focal item.
3. Every shape chosen for its meaning; same kind → same shape.
4. ≤ 4 colours, semantic, red only for problems; meaning also in the words.
5. Reading order: left→right or top→bottom; items written in that order.
6. Labels ≤ 4 words in the user's terms; arrow labels ≤ 3 words.
7. One annotation (brace / note / check / warning / numbers) carrying the key message.
8. The card explains why; it doesn't re-list the shapes.
