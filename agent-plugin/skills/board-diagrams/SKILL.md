---
name: board-diagrams
description: Compose editable visual explanations for the Margin whiteboard.
---

# Drawing on the board

Use one visual when the user asks for a drawing or a picture materially helps. Give it a takeaway title, one reading direction and a caption of up to 30 words in <answer> (sources may follow). Prefer neutral ink with one meaningful accent. The app verifies the complete layout and then reveals it.

## Structured lessons

Use one JSON object on one line inside <draw>. Margin chooses positions and typography.

- Two-way comparison. Use short labels, keep code indentation with escaped newlines, and set "code":true for code. Both sides have equal emphasis by default. Optional "focus":0 or 1 highlights the relevant side.
  {"layout":"comparison","title":"A let chain reuses the first binding","panels":[{"label":"Nested checks","body":"if let Some(x) = value {\n  if x > 0 { use_it(x); }\n}","code":true},{"label":"Let chain","body":"if let Some(x) = value\n  && x > 0 { use_it(x); }","code":true}]}
- Short process. Give 2–12 stages in reading order. With no edges they connect sequentially. For branches supply every edge and condition explicitly.
  {"layout":"process","title":"Cache hits return immediately","stages":[{"id":"hit","text":"Cache hit?","decision":true},{"id":"cached","text":"Return cached value"},{"id":"origin","text":"Fetch origin"}],"edges":[{"from":"hit","to":"cached","label":"yes"},{"from":"hit","to":"origin","label":"no"}]}
- Annotated example. Give the literal snippet or multiline object, a one-based line number and one explanation.
  {"layout":"example","title":"The guard checks the bound value","label":"Guard","snippet":"if let Some(x) = value\n  && x > 0 { use_it(x); }","line":2,"note":"The guard only runs when the first match succeeds."}

## Custom diagrams and walkthroughs

For graphs, sequences, state machines or data models use <diagram> with editable Mermaid. Start with a comment such as “%% title: Cache misses reach the origin”. Preserve branch labels and group boundaries. Limit the main path to the concepts needed to answer the question.

For custom architecture, tables or walkthroughs use <draw> with one JSON object per line. Start with {"title":"Takeaway"}. Place nodes at [column,row]. Choose short labels and meaningfully distinct shapes. Node keys include id, shape, text, at, color, fill, bold, dashed, w, h. Shapes include rounded, rect, diamond, cylinder, document, person, cloud, queue, ellipse, note, window and chevron. Use arrow or line with from/to node IDs, optional label, dashed and route ("curve" or "elbow"). Groups, braces, brackets, parens and angles take around:[ids], side and text. Tables take rows and at. Text and title take text and at. Check, cross, warning, star and number can name a nearby node with near.

For step-by-step teaching use a freeform drawing with {"step":1,"say":"Why this happens."} before the first step's items. Each following marker starts another step. Items before the first marker stay visible. Design the final picture first, then split the explanation into 3–7 steps. To change an existing diagram use board edit commands when permitted.
