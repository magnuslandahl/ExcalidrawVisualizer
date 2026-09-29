# Project TODO

This file is the handoff queue for unfinished Excalidraw Visualizer work. Read
`AGENTS.md` before starting an item, keep this list current as work progresses,
and do not mark a platform supported until its packaged application has been
tested on that platform.

The first public Windows release is version `0.1.0`. Windows x64 and macOS 13+
on Apple silicon and Intel are now packaged and advertised. The permanent
`v0.1.0` release predates macOS packaging; macOS downloads begin with the next
rolling and tagged releases.

## Agent feedback workflow

Planning reference: [Visual feedback and agent integration](docs/AGENT-FEEDBACK-PROPOSAL.md).
Stage 2 explicit Copilot pairing and delivery are implemented. Broader provider
adapters and walkthrough recording remain future capabilities.

- [x] Record the proposed workflow and the product requirement that queued feedback
  start automatically when the agent is ready and idle; drafts remain unsent.
- [x] Stage 0: finalize same-session GitHub Copilot desktop feasibility, including
  the explicit-pairing boundary where seamless startup is not exposed. Record
  supported versions/capabilities and the transport/storage contract.
  - [x] Record the installed app/CLI/SDK surface and add a bounded same-session
    diagnostic extension with authenticated loopback ingress.
  - [x] Verify extension discovery, canvas/action routing, runtime input validation,
    authenticated status, descriptor permissions, and unauthenticated rejection.
  - [x] Verify that a real immediate send while busy enters the steering lane and
    arrives in the originating conversation.
  - [x] Verify that a real queued send while busy drains automatically after the
    active turn and correlates admission, queued delivery, turn, and result IDs.
  - [x] Correlate queued and immediate sends while already idle and final
    session-idle completion. Exercise clarification blocking and preserve the
    host's permission UI without companion auto-approval.
  - [x] Prove two simultaneous tasks use distinct session IDs, descriptors, ports,
    tokens, queues, and self-routed messages in the same checkout.
  - [x] Exercise provider reload/stale descriptor replacement and define
    disconnect, sleep/wake, and restart behavior conservatively. Record global
    task discovery/activation/creation and seamless reverse startup as unsupported
    by the installed API; require explicit task-originated pairing.
- [x] Stage 1: add document-scoped tabs, anchored comments, persisted drafts and
  copy history, plus bundled local Swedish/English dictation on supported
  platforms.
  - [x] Add canonical path ownership, retained per-document controllers, mounted
    tabs, independent watchers/autosave/conflicts, and Save As copy semantics.
  - [x] Add element, point, region, and whole-drawing feedback overlays outside
    scene state, with atomically persisted drafts and immutable copy snapshots.
  - [x] Add copy-again recovery without claiming provider admission or delivery.
  - [x] Pin and verify the multilingual small model, Silero VAD, Windows helper,
    and universal macOS helper; keep generated assets ignored and outside ASAR.
  - [x] Add audio-only permission handling, bounded PCM capture, serialized local
    jobs, cancellation, unique temporary paths, output limits, and orphan cleanup.
  - [x] Verify synthetic English and Swedish transcription. On the local
    Apple-silicon package, observed cold/warm CLI latency was 7.22s/0.34s for
    short samples; packaged runtime smoke also covers capture and transcription.
- [x] Stage 2: implement explicit task-originated pairing, immediate/queued
  delivery, replies, result review, and session-scoped recovery against the
  finalized adapter contract, with honest receipts and no automatic replay of
  ambiguous sends.
  - [x] Add a five-minute one-time pairing capability to the task-local
    companion, with exact loopback host checks, constant-time bearer checks,
    generation-scoped bindings, bounded payloads, and explicit unpair.
  - [x] Replace JSON feedback persistence with one private SQLite store and
    migrate existing drafts/submissions while keeping connection secrets in
    memory only.
  - [x] Persist immutable delivery attempts before dispatch, distinguish
    accepted/consumed/reply/idle/rejected/unknown states, and block queued
    replay until an unknown attempt is explicitly retired.
  - [x] Add Queue and Send now controls, task readiness/blocking state,
    replies/results, and delivery history to the feedback panel.
  - [x] Streamline feedback into a canvas-first dictation flow that accumulates
    clicked elements, hides editor chrome, collapses during recording, keeps
    Unpair as the final panel action, and gives immediate small edits a focused
    fast-path prompt.
  - [x] Remove target-first composition: capture bounded movement, hover, click
    order, and relative timing automatically, then stop, transcribe, immediately
    send, reset, and prepare the next message through one recording-time action.
  - [x] Bundle the companion in packaged applications and add an explicit
    user-wide install/update action that refuses to overwrite unmanaged copies.
- [ ] Evaluate walkthrough recording and additional agent adapters only after the
  first complete Copilot workflow passes its acceptance gates.

## macOS support

macOS packaging is implemented. Electron 44 sets the baseline at macOS 13
Ventura. Releases build separate Apple silicon (`arm64`) and Intel (`x64`) disk
images.

- [x] Document macOS 13+ with both Apple silicon and Intel in scope.
- [x] Verify `npm ci`, `npm run check`, and `npm run build` on an Apple-silicon
  Mac.
- [x] Add electron-builder macOS targets, application/document icons, native
  menu roles, and `.excalidraw` association without weakening Windows targets.
- [x] Exercise a packaged Apple-silicon application with the sandboxed CommonJS
  preload, launch-path opening, non-zero Excalidraw canvas layers, atomic
  external replacement, application-originated atomic save, local assets, and
  zero remote renderer requests. Shared automated tests continue to cover
  watcher recovery and conflict behavior.
- [x] Add both-architecture macOS packaging and native packaged-runtime smoke
  coverage to GitHub Actions.
- [x] Extend rolling and tagged releases with stable, clearly named macOS
  artifacts and shared checksums while preserving Windows download URLs.
- [x] Include Gatekeeper, damaged-app, architecture, and minimum-version
  guidance in each DMG and in public documentation.
- [ ] Configure Apple Developer ID signing, hardened runtime, entitlements,
  notarization, and stapling. Ad-hoc signatures make the current bundles
  internally runnable but do not remove Gatekeeper warnings.

## Distribution hardening

- [ ] Configure Windows code signing in GitHub Actions when a suitable
  certificate and protected repository secrets are available.
- [ ] Verify signatures on both the NSIS installer and portable executable, then
  remove the unsigned-package warning only after a public release is confirmed
  signed.
- [ ] Configure Apple Developer ID signing and notarization credentials in
  GitHub Actions, verify both architecture-specific DMGs with `codesign`,
  `spctl`, and `stapler`, then remove the Gatekeeper instructions only after a
  public release is confirmed notarized.

## Product and test polish

- [x] Show the running version, fix tab-strip overflow, and add an explicit
  checksum-verified Windows/macOS update flow using the rolling GitHub release.
- [x] Add multi-file tabs with independent autosave/watch/merge state,
  drag-to-reorder, a two-pane side-by-side view, and safe tab detachment into
  additional secured windows.
- [x] Extend packaged runtime smoke coverage across Windows and macOS to verify
  two launch-path tabs, non-zero split canvases, path-isolated external
  updates, autosave, detached windows, and zero remote renderer requests.
- [ ] Replace the functional project/file icons with final original branding
  and verify them in installed shortcuts and `.excalidraw` associations.
- [x] Add a packaged renderer smoke test that proves the editor and both canvas
  layers have non-zero dimensions and that no remote network request occurs.
- [ ] Add privacy-safe product screenshots to the README when suitable sample
  drawings and final branding are available.
- [ ] Gather public feedback before expanding property-level merge behavior,
  Linux packaging, ARM64 packaging beyond the selected macOS target, or
  automatic updates.
