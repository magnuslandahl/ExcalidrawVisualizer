# Agent feedback Stage 1 implementation

Status: implemented and locally verified, 2026-09-28.

This record covers the local document, feedback, persistence, recovery, and
dictation foundation from
[the agent feedback proposal](AGENT-FEEDBACK-PROPOSAL.md). It does not claim
that Visualizer can pair with or deliver to a GitHub Copilot task. Those
capabilities remain behind the open
[Stage 0 feasibility gates](AGENT-FEEDBACK-STAGE0.md) and Stage 2.

## Document model

- `DocumentRegistry` owns canonical paths, document IDs, visible tabs, retained
  controllers, and Save As destination reservations.
- Each controller keeps its own scene, fingerprint tracker, directory watcher,
  and document event stream.
- All open React editors remain mounted. A tab switch therefore preserves undo,
  viewport, selection, local changes, autosave, conflicts, and watcher state.
- Opening a canonical path that is already owned activates that document.
  Symlink aliases resolve to the same owner.
- A first save assigns an untitled document's path without changing its ID.
- Save As from a file-backed document to another canonical path atomically
  creates a new document and tab. The original document, dirty state, watcher,
  feedback, and history stay with the original.
- A destination already owned or reserved by another document is rejected.
  Cancellation and failed writes leave identities unchanged.

Focused tests cover multiple files, duplicate activation, retained reopen,
untitled first save, Save As copies, occupied destinations, cancellation, and
symlink aliases.

## Local feedback

The feedback panel supports targets in scene coordinates:

1. selected element IDs plus their original aggregate bounds;
2. a point;
3. a rectangular region; and
4. the whole drawing.

Feedback annotations are React overlays. They are not Excalidraw elements, do
not dirty a drawing, and are absent from serialized `.excalidraw` JSON.
Pan/zoom state drives overlay projection without adding transient viewport state
to the saved scene.

Drafts are schema-validated and stored under application-private user data by
`FeedbackStore`. File-backed records use a SHA-256-derived canonical-path key,
so reopening a file after an application restart recovers its feedback without
writing the private path into the store. A first untitled save migrates its
records to that stable key. Mutations are serialized, copied before
modification, and written atomically. The store rejects malformed existing data
instead of silently replacing it.

**Copy for agent** creates an immutable local submission snapshot, marks the
included drafts `submitted-local`, and writes a revision-labelled text form to
the operating-system clipboard. This is a local copy operation, not an
admission or delivery receipt. **Copy again** reconstructs the clipboard text
from the persisted snapshot so recovery does not depend on mutable current
drafts.

## Offline dictation

The package owns its speech inputs independently:

| Component | Pin | SHA-256 |
| --- | --- | --- |
| `whisper.cpp` | tag `b4938`, commit `371b5a7561823ab2bb32142d2751e35e7534727b` | Source commit verified before build |
| Multilingual `ggml-small.bin` | revision `5359861c739e955e79d9a303bcbc70fb988958b1` | `1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b` |
| Silero `ggml-silero-v5.1.2.bin` | revision `9ffd54a1e1ee413ddf265af9913beaf518d1639b` | `29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf` |
| Windows x64 helper archive | release `b4938` | `c2a4b60edb11f7e11a9191ffb50929535527d4d91c9903dbe3e554583bbbc63d` |

The asset script streams downloads and hashes rather than buffering the
approximately 488 MB model. macOS builds a static universal `arm64`/`x86_64`
helper with a macOS 13 deployment target. Generated assets stay under ignored
`vendor/whisper/`; electron-builder copies them outside ASAR. CI verifies model
hashes, helper presence/architectures, microphone usage text, and the ad-hoc
signature.

The renderer requests microphone access only after the user presses
**Dictate**. Main-process permission handlers allow only audio media from the
trusted renderer window. An `AudioWorklet` captures PCM off the renderer's main
thread. Capture is bounded to five minutes, downsampled to 16 kHz mono PCM16,
and sent through typed preload methods. No raw renderer IPC, filesystem,
process, or shell object is exposed.

`DictationService`:

- validates job/document/draft IDs, language, WAV format, and byte size;
- accepts literal `sv`, `en`, or `auto`;
- serializes native jobs so only one helper is active;
- invokes the helper without a shell and always enables verified VAD;
- uses unique private job, audio, and output paths;
- supports queued and active cancellation;
- limits process and transcript output and enforces a timeout;
- deletes each job directory in `finally`; and
- removes only owned orphan `job-*` directories at startup.

The target and draft IDs are captured when recording starts. Tab switching does
not reroute the job. The transcript remains editable and is appended to existing
typed text. Permission denial, cancellation, silence, missing assets, or helper
failure leaves the prior text intact and reports an explicit error.

## Verification evidence

- Full Vitest, TypeScript, and ESLint checks pass.
- Production Electron build passes.
- The pinned model and VAD hashes match.
- The macOS helper contains both `x86_64` and `arm64`.
- Synthetic local speech produced:
  - English: “Please update the API diagram and review the database connection.”
  - Swedish: “Uppdatera api-diagrammet och granska databasanslutningen.”
- Observed native CLI latency on the local Apple-silicon machine was 7.22 seconds
  cold and 0.34 seconds warm for those short samples. These are measurements,
  not performance guarantees.
- Both macOS application architectures and DMGs package successfully.
- The native packaged smoke test verifies launch-path opening, non-zero canvas
  layers, external replacement, application save, two tabs, duplicate-path
  activation, feedback persistence, copy recovery, microphone capture, bundled
  transcription, zero remote renderer requests, and no renderer errors.

## Deliberate limitations

- Copying feedback is not provider delivery. No task binding, send receipt,
  reply, result review, or ambiguous-send recovery is claimed.
- The joined extension still exposes no supported global desktop-task listing,
  activation, or creation API. Seamless startup in both directions remains
  blocked.
- The CLI is process-per-job. A reusable model worker may improve repeated cold
  starts, but it requires separate memory, lifecycle, and latency evidence.
- Windows packaging is wired to the verified prebuilt archive and checked in CI;
  the local verification machine is macOS.
