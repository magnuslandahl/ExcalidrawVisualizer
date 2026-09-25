# Diagram design guidelines

These guidelines describe the visual system used for the overview and detailed
architecture diagrams that inspired Excalidraw Visualizer. They are intended for
people and coding agents creating new `.excalidraw` architecture drawings in the
same family.

The goal is not to make every diagram identical. The goal is to make related
diagrams immediately recognizable, easy to scan, and predictable to extend.

## Design principles

1. **Tell one story from top to bottom.** Arrange sections in the order a reader
   should understand them. Do not make the reader discover the reading order.
2. **Use color semantically.** A color represents the same kind of concept
   throughout the drawing. Do not assign colors only to make adjacent boxes
   different.
3. **Separate domains with sections, not decoration.** Large, lightly tinted
   dashed regions create the main hierarchy. Cards inside them carry the actual
   concepts.
4. **Prefer explicit labels over visual cleverness.** Name boundaries,
   transitions, request results, and open questions.
5. **Keep Excalidraw's hand-drawn character, but use precise geometry.** Rounded
   cards, handwritten headings, and slightly rough strokes make the drawing
   approachable; consistent spacing and alignment make it architectural.
6. **Make the overview and detailed drawing complementary.** The overview is a
   map of the idea. The architecture drawing is the evidence behind it.
7. **Make source files safe to regenerate.** Use stable semantic element IDs and
   deterministic scene generation when a diagram is produced from code.

## The two drawing types

### Overview

Use an overview when the reader needs to understand the proposal in one screen.
It should answer:

- What are the primary concepts?
- Where is the important boundary?
- What is the main happy-path flow?
- What stays unchanged?
- Which terms should everyone use?

Recommended characteristics:

- Landscape canvas, approximately 4:3.
- Three or four numbered sections.
- One primary flow per section.
- Large cards and short text.
- No exhaustive endpoint, field, or error catalogues.
- A compact term directory as the final section.
- Export at 2x when practical so labels remain readable in documents.

A useful overview structure is:

1. Existing or authoritative state.
2. New mixed view or proposed capability.
3. Main lifecycle or booking flow.
4. Term directory.

### Detailed architecture

Use a detailed architecture drawing when implementation and review require the
contracts, ownership, lifecycle, and unresolved decisions behind the overview.

Recommended characteristics:

- Long portrait canvas that reads like an illustrated technical document.
- Numbered sections with a clear vertical sequence.
- Repeated concepts are allowed when they explain a different viewpoint.
- Contract examples, endpoint directories, and sequence diagrams may use
  denser text than the overview.
- Keep every section independently understandable.
- Export at 1x if the full scene is already very large; prefer a valid native
  export over exceeding browser canvas limits.

A useful architecture structure is:

1. Term directory and system boundary.
2. Public APIs and wire model.
3. Domain model and projections.
4. Service ownership and aggregation.
5. Lifecycle or state transitions.
6. API contract directory.
7. Important sequences.
8. Examples, invariants, and open questions.

The exact sections may change, but terminology and boundaries should appear
before detailed flows.

## Shared canvas and typography

| Token | Value | Use |
| --- | --- | --- |
| Canvas background | `#f8f9fa` | Neutral page behind all sections |
| Primary text | `#212529` | Titles, paths, and important labels |
| Secondary text | `#495057` | Explanations and supporting detail |
| Neutral line | `#868e96` | Separators and non-semantic connectors |
| Card background | Usually a semantic pastel or `#ffffff` | Concept surfaces |
| Default stroke width | `2` | Cards and normal connectors |
| Emphasis stroke width | `3` | Primary concepts and important transitions |
| Fine stroke width | `1` | Bands, pills, and separators |
| Shape roughness | `1` | Normal Excalidraw hand-drawn appearance |
| Text roughness | `0` | Keep text crisp |
| Line height | `1.2` to `1.25` | Compact but readable multi-line text |

Use Excalidraw's handwritten font for board titles, section headings, concept
names, and prose labels. Use its monospace font for JSON, schema fragments, and
wire examples.

Recommended type scale:

| Content | Size |
| --- | ---: |
| Board title | `42`-`46` |
| Board subtitle | `20` |
| Section title | `25` |
| Overview concept title | `22`-`28` |
| Detailed concept title | `18`-`25` |
| Body/detail text | `13`-`17` |
| Pill or connector label | `13`-`16` |

Avoid text smaller than `13`. If text does not fit, increase the card or remove
detail; do not solve density by making the drawing unreadable.

## Semantic color system

Use a pale fill with a stronger stroke and title color from the same family.

| Meaning | Fill | Strong | Typical use |
| --- | --- | --- | --- |
| Public API / orchestration | `#d0ebff` | `#1971c2` | BFFs, public contracts, wrapper unions, transformations |
| Discoverable event/content | `#c5f6fa` | `#0c8599` | Available content, event services, event-facing models |
| Scheduled / committed / success | `#d3f9d8` | `#2b8a3e` | Authoritative state, successful outcomes, persisted projections |
| Excursion / established adjacent flow | `#ffe8cc` | `#d9480f` | Excursion concepts or an existing retained flow |
| Rule / decision / aggregation | `#fff3bf` | `#e67700` | Decision points, filtering rules, assumptions, warnings |
| View / terminology / supporting output | `#e5dbff` | `#6741d9` | Term directories, view projections, supplementary outputs |
| Payment / asynchronous branch | `#ffdeeb` | `#c2255c` | Redirects, payment-only paths, asynchronous work |
| Cancellation / destructive outcome | `#ffc9c9` | `#c92a2a` | Cancellation, rejection, failure, or conflict |
| Neutral infrastructure | `#e9ecef` | `#5c636a` | De-emphasized systems or implementation detail |

Color assignments are semantic defaults, not universal domain names. For a new
domain, map its concepts onto these meanings once, document any change, and
reuse that mapping everywhere in the drawing.

Do not:

- Use several colors for the same concept.
- Change a concept's color between the overview and detailed drawing.
- Use red merely for emphasis.
- Use strong saturated fills; reserve saturation for strokes and text.
- Depend on color alone. Every card and connector must also have a label.

## Visual grammar

### Section

A section is the largest grouping primitive:

- Very light semantic background.
- Dashed semantic border at reduced opacity.
- Locked so normal editing does not move it accidentally.
- Solid tinted header band inset from the outer border.
- Numbered title on the left.
- Short explanatory subtitle aligned to the right.

Keep the same horizontal margins for every section in a drawing. Leave visible
space between sections so the page reads as a sequence rather than one large
container.

### Card

A card represents a concept, service, model, state, or step:

- Rounded rectangle.
- Solid semantic fill and stroke.
- Centered concept title.
- Muted explanatory detail below the title.
- Approximately `20` units of internal horizontal padding.
- Use a `3`-unit border only for the main concept in a section.

Prefer a noun for a concept card and a short verb phrase for a process step.
Keep body text to the minimum needed to understand the relationship.

### Note

A note is a supporting rule, invariant, or caveat:

- Rounded rectangle.
- Dashed stroke.
- Usually a white or pale-yellow background.
- Smaller title and body than a normal card.

Notes should clarify the model, not become a second prose document.

### Pill

Use a pill for compact metadata:

- HTTP method.
- Proposal state.
- Workstream or version marker.
- Small category label.

Pills use a one-unit stroke and `roughness: 0` so they read as metadata rather
than domain objects.

### Decision diamond

Use a diamond only when a flow genuinely branches. Put the decision or returned
status inside it and label outgoing connectors with their outcome.

### Endpoint row

Display an endpoint as:

1. A small colored HTTP-method pill.
2. A path in primary text.
3. The response or purpose beneath it in muted text.

Group endpoints by owner or workflow. Do not draw a separate box around every
single endpoint when a contract directory can present them as aligned rows.

### Term card

A term card contains:

- A category title.
- Repeated term-and-description rows.
- Thin, low-opacity separators between rows.

Term names use the category's strong color. Definitions use muted text. Keep
definitions short enough to be read without zooming into each row individually.

### Sequence participant

Sequence diagrams use:

- Small participant cards.
- Dashed vertical lifelines.
- Horizontal arrows.
- Short numbered labels above arrows.
- Pink/red only for payment or failure branches.

Do not recreate a full UML tool. Show only the interactions needed to explain
the architectural decision.

## Connectors and flow

| Style | Meaning |
| --- | --- |
| Solid arrow | Primary flow, dependency, wrapping, or successful transition |
| Dashed arrow | Optional, asynchronous, derived, exceptional, or secondary flow |
| Solid line without arrowhead | Association, separator, or sequence lifeline |
| Three-unit arrow | Main architectural transition |
| One- or two-unit arrow | Supporting relationship |

Choose connector color from the meaning of the transition or destination:

- Green for becoming committed or successful.
- Cyan for discoverable content.
- Orange for the established adjacent flow.
- Pink for payment or asynchronous work.
- Red for cancellation or failure.
- Gray for neutral relationships.

Connect cards edge-to-edge when possible. Avoid lines passing through cards.
Use parallel lanes for related flows, and leave enough room for labels above the
connector.

## Layout and spacing

- Start with the narrative, then choose coordinates.
- Keep an outer page margin of roughly `60`-`80` units.
- Use approximately `18` units between a section edge and its header band.
- Use `20`-`40` units between nearby cards and larger gaps between independent
  lanes.
- Align card edges and centers deliberately.
- Use equal card sizes for sibling concepts.
- Use a larger or heavier card for the parent union, orchestrator, or source of
  truth.
- Prefer left-to-right for transformations and booking flows.
- Prefer top-to-bottom for section order and lifecycle progression.
- Keep crossing connectors to an absolute minimum.

Whitespace is structural. A diagram is not improved by filling every empty
area.

## Content rules

- State the boundary or source of truth explicitly.
- Distinguish authoritative models from read-model wrappers.
- Show where data changes state, not only where it moves.
- Label retained behavior as retained instead of redrawing it as if it were new.
- Put unresolved implementation choices in an open-questions area.
- Keep terminology identical across titles, cards, endpoints, examples, and the
  term directory.
- Remove obsolete terminology from the final drawing. Migration history belongs
  in accompanying documentation, not in the target-state visual.
- Use concrete response and wrapper names when the contract is important.
- Use examples only when they clarify shape or invariants.

## Relationship between overview and architecture

The overview is not a cropped architecture drawing. Build it independently:

- Preserve the same concept names and semantic colors.
- Keep only the parent concepts and main transition.
- Collapse implementation services into a single step where possible.
- Replace endpoint directories with one representative endpoint.
- Keep one sentence explaining the central rule.
- Retain the term directory so readers share the same vocabulary.

The architecture drawing expands the overview:

- Add ownership and service boundaries.
- Add wrapper and discriminator details.
- Add complete endpoint groups.
- Add lifecycle and sequence views.
- Add wire examples, invariants, and open questions.

If the two drawings disagree, fix the disagreement rather than explaining it in
a note.

## Generating Excalidraw scenes

When creating scenes programmatically:

- Produce ordinary Excalidraw version-2 JSON.
- Use semantic stable IDs such as `calendar-section`,
  `booking-success-arrow`, or `terms-card-title`.
- Derive `seed` and `versionNonce` deterministically from the element ID when
  generating a fresh scene.
- Use `fillStyle: "solid"`.
- Use rounded rectangles with `roundness: { "type": 3 }`.
- Use rounded arrows with `roundness: { "type": 2 }`.
- Lock section backgrounds and header bands.
- Keep text as separate elements with explicit width and alignment.
- Use a shared palette and helper functions for rectangles, text, arrows,
  sections, cards, pills, notes, endpoints, and term cards.
- Validate unique IDs and finite `x`, `y`, `width`, and `height` values.
- Write the complete JSON atomically instead of streaming into the target file.

A minimal token object:

```js
const COLORS = {
  ink: "#212529",
  muted: "#495057",
  line: "#868e96",
  page: "#f8f9fa",
  white: "#ffffff",
  blue: "#d0ebff",
  blueStrong: "#1971c2",
  cyan: "#c5f6fa",
  cyanStrong: "#0c8599",
  green: "#d3f9d8",
  greenStrong: "#2b8a3e",
  orange: "#ffe8cc",
  orangeStrong: "#d9480f",
  yellow: "#fff3bf",
  yellowStrong: "#e67700",
  purple: "#e5dbff",
  purpleStrong: "#6741d9",
  pink: "#ffdeeb",
  pinkStrong: "#c2255c",
  red: "#ffc9c9",
  redStrong: "#c92a2a",
  gray: "#e9ecef",
  grayStrong: "#5c636a",
};
```

## Export conventions

Keep the editable `.excalidraw` file as the source of truth. A PNG or PDF is a
review and distribution artifact.

- Export with a light background.
- Export the complete scene, not an editor screenshot.
- Do not include editor chrome, selections, cursors, or open dialogs.
- Use 2x PNG for a normal landscape overview.
- Use 1x PNG for a very large portrait architecture drawing when higher scale
  would exceed browser canvas limits.
- Inspect the complete export for clipped text, missing fonts, crossed
  connectors, and blank regions.
- Name related artifacts consistently:

```text
feature-overview.excalidraw
feature-overview.png
feature-architecture.excalidraw
feature-architecture.png
```

Do not commit private source drawings or generated exports to this public
repository. These guidelines describe the visual language only.

## Review checklist

Before considering a drawing complete, verify:

- [ ] The reading order is obvious.
- [ ] The overview fits as one coherent visual.
- [ ] The detailed drawing is divided into numbered sections.
- [ ] Semantic colors are consistent between related drawings.
- [ ] Each primary concept has one stable name.
- [ ] The source of truth and read-model boundaries are explicit.
- [ ] Solid and dashed connectors have consistent meanings.
- [ ] Connector labels do not overlap cards or other lines.
- [ ] Text is readable at the intended export size.
- [ ] The term directory matches the diagram.
- [ ] Obsolete terminology is absent from the target-state visual.
- [ ] Open questions are visibly separated from decided architecture.
- [ ] Element IDs are unique and geometry is finite.
- [ ] The `.excalidraw` file opens in Excalidraw Visualizer.
- [ ] The exported PNG or PDF contains the whole scene without editor chrome.

