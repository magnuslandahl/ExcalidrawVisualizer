# Visual feedback and agent integration

Status: planning baseline, 2026-09-28. Confirmed requirements are distinguished
from recommendations and technical gates. This document proposes future behavior;
it does not describe implemented functionality or a delivery date.
Application code has not been changed. Examples are synthetic.

## 1. Outcome

Make a drawing a shared working surface for an architect and the existing
coding-agent conversation. The architect can point at a diagram object or region,
write or dictate feedback, and send it to the conversation already responsible
for that drawing. The agent continues using its existing project context and
updates the ordinary `.excalidraw` file. Visualizer displays the change and keeps
the feedback attached to the relevant part of the drawing.

The application must remain useful as an independent local editor and viewer.
Agent integration is optional. A diagram is associated with at most one agent
session at a time; a session may own several related diagrams.

## 2. Confirmed requirements

- First integration target: the standalone GitHub Copilot desktop app.
- Keep working in the same agent conversation from either the agent app or the
  diagram. Preserve its architecture discussion and repository context.
- Support multiple open files and concurrent, independent tasks.
- Support both immediate feedback and feedback queued for later processing.
- Start queued feedback automatically when the connected agent is ready and idle,
  including when it was already idle at submission. Drafts remain unsent.
- Provide a complete silent workflow for shared offices.
- Ship built-in local dictation in the first integrated release, including Swedish.
  Bundle the engine and multilingual model in the installer; no separate model
  installation, first-use download, OS dictation dependency, or cloud dictation API.
- From the current Copilot conversation, understand a request such as "continue
  on this drawing", locate the relevant file, launch Visualizer if needed, open
  the drawing, and bind it to the originating conversation.
- Also support starting in Visualizer, opening a drawing, and connecting from there.
- Retain ordinary editing, watching, compatible files, and explicit conflicts.
- This work produces a design and implementation plan, not implementation.

## 3. Recommended product experience

### Connect once, keep the association visible

Install the companion once. It includes a focused agent skill describing the
drawing workflow and session-bound tools for discovery, opening, binding, and
feedback. The extension provides delivery; the skill makes a natural-language
request invoke that workflow without requiring the user to remember a command.

From the relevant Copilot session, the user says "Let's continue on this drawing."
The agent resolves the drawing from this evidence, in order:

1. An explicit path or attachment in the current request.
2. The drawing previously bound to this session, confirmed to exist.
3. Drawing paths referenced or created in this conversation's available history.
4. Valid `.excalidraw` files in the session's current working directory/worktree,
   prioritizing files relevant to this task and changes on the current branch.

Use one clear candidate automatically. When several candidates are equally
plausible, show a small picker with relative paths and reasons. Do not choose the
globally most recent drawing. Do not scan other conversations or the whole machine.
References to deleted files are evidence, not permission to restore old content
over current files. If no drawing exists, offer to create a named drawing for the
current task. Never silently invent a continuation of a missing document.

An idempotent open/bind operation then starts the installed Visualizer if needed,
waits for its ready handshake, opens or focuses the correct document tab, and
associates it with the calling session. Repeated calls reuse the same document.
If the app is absent, show the installation step instead of claiming it opened.
No branch checkout, Git restoration or worktree creation is needed for discovery.

The skill and bridge remember the document ID and canonical path in the correct
worktree; a branch name alone is not a routing identity. Visualizer displays the
task name and connection status. Changes to branch/worktree paths require path
revalidation and must never redirect a queued submission to another checkout.

Connecting must use a session identity supplied by the host extension. Matching
by window title, most recent task, repository alone, or filename alone is unsafe.
The first pairing shows both the target file and session. Reconnecting the same
authorized binding does not prompt repeatedly. Rebinding to another session is
an explicit action; queued feedback retains its original destination until the
user chooses to move it.

Opening a file normally must not start or message an agent. In the reverse flow,
Visualizer shows **Continue with Copilot**. A valid remembered binding reconnects
to its existing task. Otherwise show matching live sessions registered by the
companion and an explicit **Start a new task** option. Desktop task creation,
activation and resumption must use supported host capabilities verified in stage 0;
the joined-session extension alone does not prove an external task-launch API.
If unavailable, show a single pairing instruction to run in the intended Copilot
task. This is a clearly labeled fallback, not the acceptance target for seamless
two-way startup. Do not silently start an independent SDK conversation instead.

### Select a target and compose

Keep a clear distinction between editing the drawing and commenting on it.
Use a small Edit / Comment mode control and a collapsible feedback panel.

Supported comment targets:

1. One or more selected elements, including their bound labels where relevant.
2. A rectangular region, including empty space where something should be added.
3. A point pin, useful for a precise position or connector.
4. The whole drawing, for general questions or instructions.

Selecting a target opens the same text composer. A short description of the
target and the destination task remains visible while composing. The user can
ask questions, discuss alternatives, or request edits in natural language.
Do not require a category or ticket form for every comment.

Pins and region outlines belong to a feedback overlay, not Excalidraw elements.
Commenting does not dirty the drawing or enter its drawing undo history. Normal
diagram exports exclude the overlay. A future review export can include it only
through an explicit action.

### Delivery controls

- **Send now:** begin a turn if idle; request steering if already working and
  the adapter supports it. Steering is best effort and cannot undo a tool call
  already in progress. Unsupported steering must be visible.
- **Queue:** start automatically when the agent is ready and idle. If working,
  wait for the current turn to finish, then start the next queued batch without
  requiring another click. Preserve FIFO order per session across its drawings.
- **Draft:** typing or placing a pin alone never sends anything. Drafts survive
  tab switching and restarts. Several drafts can be selected and sent as one
  feedback batch, reducing fragmented agent turns.

Automatic queue processing is confirmed. An idle event alone is insufficient:
the adapter must distinguish ready from waiting for clarification, permission,
recovery, or a disconnected host. These blocked states show their reason and
hold the queue. A reply to the blocking question must remain sendable without
waiting behind that queue; approving an operation stays in the host's normal UI.
Once the block is resolved, eligible queued feedback resumes automatically.

The user can pause/resume the local queue and cancel items not yet dispatched.
Send now deliberately takes priority over locally queued items; display that
choice when a backlog exists. It cannot reorder work already accepted by the
host or promise to interrupt an executing tool. If steering is unavailable,
keep the comment ready and offer Queue instead of silently changing its intent.

If disconnected, keep the submission locally and show **Waiting for connection**.
Never show **Sent** merely because it was saved to the local queue.

### Close the loop

Display separate facts: saved locally, accepted by the agent host, acknowledged
by the agent, agent working, agent asking a question, result available, and user
reviewed. A file change alone does not prove that a particular comment was handled.

The agent can post a short reply or a clarification to the comment thread and
identify affected element IDs and the resulting document revision. Clicking the
result focuses the relevant area. Highlight changed objects briefly without
changing the viewport automatically. Agent-reported completion leaves the comment
awaiting user review; the user can mark it resolved or reply again.

The feedback panel is scoped to the drawing. The full project conversation
continues in Copilot. Show a return-to-task action only where supported, without
assuming that a public deep-link API exists.

### Speech

Built-in offline dictation is a first-release requirement. The inspected
FeedbackRecorder desktop implementation uses `whisper.cpp`, the multilingual
`ggml-small.bin` model, and `ggml-silero-v5.1.2.bin` for voice activity detection.
This is Whisper, distinct from the Wispr product name. The legacy Python helper
is not the desktop packaging approach to reuse.

Use that architecture as the baseline, with independent pinned inputs and build
ownership in this repository. Do not require FeedbackRecorder to be installed or
read its private configuration/recordings. Its inspected model is 487,601,967 bytes
(about 488 MB), excluding the runtime and app. Preserve version/hash verification
and license notices; download verified inputs during build and include them in
each Windows x64 and macOS arm64/x64 installer, outside ASAR as appropriate.
No runtime model download is needed. Choose a different model only after comparing
Swedish accuracy and response time on supported hardware.

Read-only reference files in the public FeedbackRecorder project:
`app/src/main/whisper.js`, `app/src/shared/languages.js`,
`app/src/shared/wav.js`, `app/scripts/fetch-vendor.js`,
`app/electron-builder.yml`, and `docs/SHIPPED_COMPONENTS.md`.
Upstream: [whisper.cpp](https://github.com/ggml-org/whisper.cpp).

Provide press-to-talk and click-to-start/stop, with a visible microphone state.
Offer Swedish (`sv`), English (`en`) and automatic detection, remembering the choice.
Pass the language explicitly, including `auto`; omitting the flag can default the
CLI to English. Transcribe Swedish as Swedish, not an English translation. Test
Swedish sentences containing English API names and domain vocabulary.

Lock the document, target and comment draft when recording starts. A later tab
switch cannot attach the transcript to another drawing. Show an editable transcript
before Send now / Queue. Capturing mouse movement alone must not silently change
what a sentence refers to. Silent text input remains an equal first-class path.

Capture audio only after the user activates dictation. Convert to the engine's
required PCM format through bounded typed APIs and transcribe in an isolated
background worker/helper. Give each job unique temporary paths and document IDs;
do not copy the reference's fixed output stem into concurrent dictation jobs.
Support cancellation, permission denial, empty/silent audio, missing or corrupted
assets, and engine failure without losing an existing typed draft. VAD reduces
silence hallucinations but does not prove transcript accuracy. Delete temporary
audio after completion or cancellation by default.

Evaluate keeping the model loaded in a reusable worker so repeated short comments
do not pay the model-startup cost every time. FeedbackRecorder's batch CLI approach
is a packaging/reference baseline, not evidence of instant or streaming dictation.
Measure cold/warm latency, memory and accuracy before specifying streaming behavior.

An advanced walkthrough can collect explicit numbered target clicks alongside
transcript segments. It should produce several reviewable comments, not guess
references from an unstructured audio recording and pointer trail.

Dedicated local dictation is part of the first complete workflow. Multi-target
walkthrough recording is a later enhancement. Do not enable remote speech
processing or persistent raw-audio storage by default.

## 4. Integration recommendation and evidence

### Prefer a session-bound Copilot companion

GitHub documents plugins and canvas extensions in its desktop app. Its public
Spec Kit example uses the extension API to join a session and sends prompts
through the resulting session object. SDK source shows that `joinSession()`
expects a host-started child process and uses the parent connection and provided
session ID. These are promising building blocks for a companion running inside
the existing task, rather than a second independently resumed process.

Sources: [Copilot app customizations](https://docs.github.com/en/copilot/how-tos/github-copilot-app/customize-github-copilot-app),
[canvas extensions](https://docs.github.com/en/copilot/how-tos/github-copilot-app/working-with-canvas-extensions),
[extension API source](https://github.com/github/copilot-sdk/blob/main/nodejs/src/extension.ts),
[GitHub Spec Kit extension example](https://github.com/github/spec-kit-copilot/blob/main/plugins/spec-kit-copilot-sdd/extensions/sdd-canvas/extension.mjs).

Proposed topology:

```text
Visualizer renderer
  -> typed preload -> main-process document/feedback service
  -> authenticated local connection
  -> companion extension inside the selected Copilot session
  -> existing Copilot conversation
  -> atomic update of the .excalidraw file
  -> Visualizer watcher -> merge -> refreshed canvas
```

This exact external-Visualizer-to-extension route has not been tested. The first
implementation milestone must validate the installed desktop app, extension
lifecycle, supported SDK version, permissions, and concurrent session isolation.
Public repository examples are evidence for feasibility, not a compatibility
guarantee for an installed app version.

GitHub's SDK documents immediate and enqueue delivery. A send acknowledgement
means the message was accepted, not necessarily consumed. The adapter should map
these semantics explicitly and verify that the joined extension session exposes
the required methods. [Steering and queueing](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/steering-and-queueing).

Do not start a separate `resumeSession()` against session files as a shortcut to
controlling the active desktop task. Session persistence is not proof of safe
concurrent ownership; the SDK explicitly leaves session locking to applications.
[Session persistence](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/session-persistence).

### MCP is the context/tool interface

A small MCP surface can let agents bind an authorized drawing, inspect submitted
feedback and selected context, acknowledge work, ask questions, and report results.
It can reuse the same local feedback service as the companion.

MCP resource notifications expose changed context; the protocol leaves context
incorporation to the host. Our design must not assume that publishing a resource
notification starts a turn in an idle desktop conversation. Direct dispatch belongs
in the verified host adapter. [MCP resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources).

For the Copilot-first release, native extension tools may provide these operations
without a separate MCP installation. Keep one core service and add an MCP wrapper
when it improves compatibility. Do not build two independent queues or stores.

### Other protocols

| Option | Appropriate role | Decision |
| --- | --- | --- |
| Copilot extension/session API | Feedback into the existing desktop task | Preferred feasibility path |
| MCP | Agent access to scoped diagram context and feedback | Portable boundary; no assumed wakeup |
| ACP | Visualizer acting as a client of an agent runtime | Alternative for CLI or app-managed sessions |
| Copilot SDK with its own runtime | Starting a new conversation under Visualizer | Optional later; changes the user's workflow |
| Codex app-server | Future Codex-specific adapter | Defer until Copilot loop works |
| A2A | Independent agents collaborating with other agents | Not needed for this user-to-agent workflow |
| Copy structured feedback | Manual recovery when integration is unavailable | Keep as a fallback, not seamless acceptance |

Copilot CLI exposes ACP, currently documented as preview. ACP session loading is
capability-dependent and does not alone establish safe attachment to a live desktop
task. [Copilot ACP](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server),
[ACP sessions](https://agentclientprotocol.com/protocol/v1/session-setup).

Codex exposes thread/turn control through app-server; its compatibility and live
desktop attachment must be validated independently. [Codex app-server](https://learn.chatgpt.com/docs/app-server).
A2A targets communication between independent agents. [A2A](https://a2a-protocol.org/).

## 5. Proposed internal model

These are design names, not existing public APIs.

| Entity | Key fields and responsibilities |
| --- | --- |
| Document | Stable local `documentId`, canonical path, disk fingerprint, saved revision, per-document controller |
| Agent binding | `bindingId`, provider, host/session identity, working directory, document IDs, connection state, capabilities, binding generation |
| Feedback thread | `feedbackId`, document ID, target anchor, messages, user resolution state |
| Anchor | Element IDs, original scene bounds/point, source revision, short text labels, optional local crop |
| Submission | Immutable batch ID, binding generation, document revision, feedback IDs, delivery intent, order |
| Delivery receipt | Submission ID, provider message ID if supplied, accepted/unknown/rejected state, timestamps |
| Agent outcome | Submission and feedback IDs, reply, changed IDs, observed result revision, reported result |

Every submission freezes what the user meant, its target, and its destination.
Later edits create an amendment or another submission. They do not rewrite what
the agent already received. Reconnection tokens and secrets never appear in
comments, drawings, portable exports, or normal logs.

### Queue ownership and lifecycle

Use one durable local outbox, managed by a serialized dispatcher per session.
The companion translates requests into verified provider calls; it is not a
second independently advancing queue. For the first release, keep pending Queue
items locally and dispatch one when readiness is confirmed. A provider enqueue
call may handle a busy-state race, but ownership of that accepted message then
belongs to the host: never also replay it from the local pending list.
Host acceptance reserves the session's queued-work slot until the adapter observes
the corresponding turn finish and confirms readiness again. A delayed working
event or stale idle snapshot must not release the next item. Immediate steering
and clarification replies remain distinct from advancing the automatic queue.

| State | Meaning and allowed next action |
| --- | --- |
| Draft | Editable, never eligible for automatic dispatch |
| Queued / waiting | Submission durably stored; waits for connection, readiness, pause, or document safety checks |
| Dispatching | Attempt persisted before calling the host; only one attempt for this submission is in flight |
| Accepted | Receipt identifies host acceptance; local dispatcher cannot resend or claim execution |
| Delivery unknown | Outcome of an attempt is ambiguous; reconcile against host receipts/history or request a user decision |
| Rejected | Host definitively refused; show reason and allow an explicit retry after correction |
| In progress / needs input | Correlated agent acknowledgement or question; no inference from file changes alone |
| Result available | Correlated outcome received; user may resolve or reply |
| Canceled | Unsent item canceled locally; accepted work requires a supported host cancellation result |

Delivery state and user resolution state are stored separately. A resolved comment
does not imply canceled agent work. A provider error or idle notification without a
correlated outcome must not be presented as completion. Stage 0 must establish a
reliable readiness signal; if the host cannot distinguish these conditions, report
the missing capability instead of claiming automatic queue processing works.

Serialize ordering and persist sequence numbers across all documents of one
session. Independent sessions continue independently. A blocked head item remains
visible and holds later Queue items until corrected, canceled, or explicitly moved;
do not silently skip it. Send now and replies to a blocking question use the same
dispatcher but may bypass local waiting items. Neither bypasses document safety
checks for edits or unresolved delivery of the same submission.

### Anchoring and context

Use stable element IDs first. Store scene coordinates, not screen coordinates;
zoom, pan, display scale and window size must not break an anchor. Preserve the
original anchor and optionally derive a current position from surviving IDs.

If an element disappears or is recreated under another ID, show an outdated or
detached anchor. Never attach it to a merely similar object silently. Preserve
the original text and bounds so the comment remains understandable.

Default agent context: user text, document identity/path within the paired scope,
revision, target IDs, relevant element data and readable labels. A locally rendered
crop with a target outline can be added for spatial feedback when the user enables
it and the agent supports images. Avoid desktop screenshots containing other apps.
Support explicit whole-document context when a refinement needs it.

Before dispatching an edit request, finish saving ordinary local edits and capture
a consistent saved revision. Save failure or an unresolved conflict blocks edit
dispatch, while retaining the comment. A later change to targeted elements marks
the submission stale: the agent must reread, reconcile or ask for clarification.
Unrelated changes should not invalidate every queued comment.
Preserve the submission's original revision and separately record the dispatch
revision and stale-target warning; refreshing context must not rewrite history.
Treat any submitted feedback as potentially actionable unless the adapter can
enforce a discussion-only turn. A clarification can be sent while edits are blocked
only with that restriction; otherwise direct the user to the existing Copilot chat.
Revalidate the canonical path, worktree/checkout association and valid on-disk scene
at dispatch time. Missing or malformed files hold the item for recovery; do not
silently recreate them from a stored snapshot or send to a replaced checkout.

### Storage and recovery

Recommended first version: keep feedback, drafts, receipts, bindings and the
outbox in the application's private data directory, using a transactional local
store selected during technical design. Keep crops in a private asset directory.
Do not add comments to `.excalidraw`, and do not create sidecar files inside source
repositories automatically. Optional portable feedback export can come later.

Persist a submission before dispatch. Retry only after resolving whether an earlier
attempt was accepted. Use idempotency keys and adapter receipts, but do not promise
exactly-once agent execution when the provider does not offer it. An ambiguous
send becomes **Delivery unknown**, not an automatic duplicate request.

Queue acceptance, agent execution, file arrival, and user acceptance are different
states. A cancellation after acceptance may be unsupported; show the true result.
On restart, reload durable pending items, validate the original binding generation,
reconcile dispatching/unknown attempts, and only then resume eligible work. A crash
after host acceptance but before receipt persistence must not create a duplicate.
An unknown attempt blocks further queued dispatch to that session until reconciled;
other sessions continue. The absence of a reply is not evidence of rejection.

## 6. Multiple documents

Introduce a document registry and one document controller per open file. Keep
watcher, path, fingerprint state, save pipeline, conflict state, dirty state,
feedback, agent binding, and viewport scoped to `documentId`.

All IPC commands and events must include document identity. Save callbacks must
retain the originating document even if the user switches tabs while a dialog,
write, or agent request is outstanding. Do not route a save by the currently
selected tab. Canonicalize paths, including platform case and symlink policy, to
avoid opening the same physical document twice accidentally.

Use tabs initially, optionally followed by separate windows. Background tabs keep
watching and preserve their state. Mounting policies must balance memory use with
preserving the editor's undo history; measure this before choosing unmount-on-switch.
Quit handling checks every dirty document and outstanding save. Closing a tab
retains feedback; it does not cancel or reassign the Copilot task.
Closing a tab leaves submitted work eligible while the app is running. A pending
item can use a retained document service after the editor unmounts. Quitting stops
local dispatch; accepted host work may continue. On next launch, reconnect and
resume verified pending work automatically. Do not add a background daemon in the
first release or imply that the closed app keeps sending locally queued feedback.

## 7. Security and offline boundary

The standalone editor, watcher and feedback drafts continue to work offline.
The optional integration passes user-submitted context to the chosen local agent
host, which may use its normal cloud model service. The current blanket rule about
never transmitting drawing content needs an explicit, narrowly scoped product
policy update before implementing this feature. Do not claim that AI processing
is offline merely because the bridge is local.

Keep renderer sandboxing and the existing restrictive CSP. Run transport, pairing,
storage and filesystem operations in the trusted process/service. Prefer local
socket/named-pipe IPC; authenticated loopback is an option if required by extension
deployment. No externally reachable listener, arbitrary callback URL, or raw shell
command from drawing contents. If HTTP is used, validate origin/host as well as
authentication and bound all payloads.

The current deny-all Electron permission policy needs one narrow exception for
user-initiated microphone audio capture in the trusted application window. Keep
camera, screen capture, unrelated origins/windows and other permissions denied.
Add the macOS microphone usage description and required packaged helper signing;
validate permissions and native runtime dependencies on both supported platforms.

Pairing grants access only to explicit document bindings and submitted feedback.
Do not expose all recent files or private drafts to every connected task. Revoke
access when unpaired, and reject expired binding generations. A file copied or
saved under a new name does not inherit an agent binding silently.
Unpairing freezes pending submissions and revokes the transport capability; it
cannot retract content already sent to a host. Rebinding offers an explicit move
for unsent items, producing new submissions under the new binding generation.
Accepted or unknown attempts must first be reconciled and cannot be silently moved.

Use the host's existing permissions. The companion must not auto-approve arbitrary
agent operations. Keep user-authored feedback distinct from diagram text, imported
documents and agent replies; imported content cannot become a trusted instruction.

## 8. Delivery stages and acceptance gates

### Stage 0 — Verify the same-session connection

Use synthetic files and two local desktop Copilot sessions. Verify:

- The companion joins the originating task without creating a second conversation.
- An explicit Visualizer message reaches that task, including when idle.
- Immediate and queued messages behave correctly while it is busy.
- Queue while already idle starts without another click; permissions, questions,
  errors, and ambiguous sends hold automatic dispatch until resolved.
- Receiving feedback preserves prior task context and the normal permissions UI.
- Two tasks in the same repository cannot receive each other's messages.
- Tab focus in either app does not change routing.
- Closing a canvas, switching tasks, sleeping, restarting, and reconnecting have
  documented behavior; no stale extension acquires another session's identity.
- Submitted IDs and acknowledgements permit honest delivery reporting.
- Natural-language continuation finds the correct current-worktree drawing,
  launches a closed Visualizer, and focuses the existing tab on repeat requests.
- Reverse startup from Visualizer resumes a known session or pairs with a selected
  session; establish separately whether desktop task creation/activation is exposed.

Record exact app/SDK versions and supported capabilities. If the companion cannot
provide this, return to the user with the demonstrated limitation and alternatives.
Do not call an MCP-only pull queue equivalent to the requested seamless workflow.

Stage 0 also produces the concrete transport and persistence decision, schemas,
size limits, authenticated handshake, and adapter capability contract. Prefer one
transactional embedded store and a local socket/named pipe; use loopback only if
the demonstrated extension lifecycle requires it. Pin compatible dependencies and
record packaged-platform evidence before these choices become implementation facts.

### Stage 1 — Document and feedback foundations

Refactor into per-document controllers and state. Add tabs, point/element/region
comments, drafts, local persistence and a copy-submission recovery action. Keep ordinary
editing, offline behavior and conflict handling intact. Build bundled local
Swedish/English dictation in this stage, including packaged execution, microphone
permissions and cold/warm latency measurements. Speech is required before calling
the first integrated release complete.

### Stage 2 — Complete the Copilot feedback loop

Pair files, dispatch through the verified companion, implement immediate/queued
delivery, display receipts/replies/questions, recover connections, and correlate
agent outcomes with file revisions. Add batch submission and review of results.

### Stage 3 — Walkthroughs and refinement

Build on the already shipped dictation with explicit multi-target walkthroughs
if useful. Consider review exports and a presentation mode for communicating the
finished architecture to a team.

### Stage 4 — Additional agent providers

Add MCP compatibility and Codex/ACP adapters according to proven capabilities.
Keep feedback semantics independent of provider-specific session APIs.

## 9. Required verification when implemented

- Unit tests: anchor resolution, stale revisions, batch ordering, binding validation,
  duplicate delivery handling and feedback state transitions.
- Queue tests: already-idle submission, busy-to-ready transition, pause/resume,
  blocked head items, cross-document FIFO, immediate priority, clarification and
  approval waits, disconnect/restart, and a lost receipt after host acceptance.
- Integration tests: crash/restart recovery, late saves after tab switching,
  file deletion/recreation, concurrent external and local edits, and disconnected
  queue replay without accidental duplicate submissions.
- Conflict tests: a pending autosave or manual save cannot silently write conflicting
  content; no automatic resolution of incompatible concurrent changes.
- UI tests: comment mode does not move drawing objects, annotations track pan/zoom,
  drafts survive tabs, keyboard entry works, and exports omit feedback overlays.
- Provider tests: two actual desktop tasks, idle wakeup, busy steering, enqueue,
  acknowledgements, permission prompts, reconnection, and unchanged conversation.
- Platform checks: Windows/macOS packaging and existing runtime smoke coverage;
  basic editing still makes no remote request with integration disabled.
- Dictation checks: packaged engines/models are complete and verified; first-use
  transcription works without network access or external runtime installation;
  Swedish, English, mixed API terms, silence, cancellation, denied microphone,
  concurrent drafts and tab switches have focused coverage. Benchmark response
  time on representative supported machines; use only consented synthetic samples.
- Privacy checks: no private sample diagrams, task transcripts, credentials, or
  generated review captures enter this public repository.

## 10. Implementation handoff and decision record

The planning baseline covers the user journeys, queue semantics, boundaries,
failure handling, staged work and acceptance tests. It intentionally does not
claim a verified desktop integration or finalized provider wire protocol.

Map implementation to the existing boundaries:

- `src/main/document-controller.ts`: per-document controller instances, with a
  registry owning canonical paths and lifecycle. Keep atomic writes and watcher
  fingerprinting rather than introducing agent-specific file writes.
- `src/main/index.ts`: app launch/readiness, scoped routing, secure IPC, document
  registry, feedback store/dispatcher and speech-helper lifecycle.
- `src/shared/contracts.ts` and `src/preload/index.ts`: typed document-scoped
  commands/events, feedback commands, dictation jobs and validation in main.
- `src/renderer/src/App.tsx`: extract document state and feedback UI so tab focus
  cannot change the destination of outstanding operations.
- New provider adapter: host-provided identity, capability/readiness reporting,
  submission receipts, replies/results, reconnect and revoke. Keep provider code
  outside the scene merge module.
- Build scripts and packaging: verified speech assets, licenses, helpers and
  microphone configuration for every advertised packaged architecture.

The core service needs these logical operations; stage 0 fixes their wire schemas:

| Operation | Required scope and result |
| --- | --- |
| Open/bind | Authenticated host/session and authorized file; idempotent document and binding identity |
| Read submitted context | Binding generation and submission ID; no access to private drafts or unrelated files |
| Submit feedback | Document, frozen batch, revision and intent; durable local receipt before any host send |
| Observe delivery | Submission and provider receipt; separate accepted, unknown and rejected |
| Report reply/result | Matching binding/submission/feedback IDs; bounded reply and optional changed IDs/revision |
| Pause/cancel/revoke | Explicit user action; distinguish unsent cancellation from host cancellation |
| Dictate | Document, draft and job ID; bounded audio input and editable local transcript |

Decision record:

1. Confirm the companion-extension approach while retaining the independent app.
2. Choose the initial target interactions: element selection, region, point, and
   whole-document feedback are recommended; freehand markup can wait.
3. **Confirmed:** queued feedback starts automatically when the agent is ready and
   idle. Drafts provide the deliberate hold-until-send behavior. No second Run click.
4. Validate the proposed bundled Whisper small baseline and set dictation latency
   and accuracy acceptance targets. Built-in Swedish support is already decided.
5. Decide the initial feedback context policy, including optional diagram crops.
6. Establish first-release limits for open editors, retained feedback and snapshots
   from measured behavior rather than arbitrary capacity claims.

Recommendations 1, 2 and 5 are the proposed first-release defaults; validate them
during the feasibility/design stage rather than quietly treating them as shipped.
Items 4 and 6 require measurements. Expand this baseline with the stage-0 evidence
and concrete contracts before implementing delivery. Keep the project briefing,
README and handoff queue aligned without advertising planned features as available.
