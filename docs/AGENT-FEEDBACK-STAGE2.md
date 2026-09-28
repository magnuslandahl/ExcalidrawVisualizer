# Agent feedback Stage 2 implementation

Status: implemented for version 0.4.0 on 2026-09-28.

Stage 2 completes the first GitHub Copilot feedback loop within the
[finalized Stage 0 capability boundary](AGENT-FEEDBACK-STAGE0.md). It does not
add task discovery, activation, creation, or seamless reverse startup.

## User workflow

1. Open the **Excalidraw Visualizer Companion** canvas inside the intended
   Copilot task.
2. Generate a five-minute, one-time pairing code.
3. Paste the code into the drawing's Comments panel and pair.
4. Create one or more local feedback drafts.
5. Choose **Queue for paired task** or **Send now**.
6. Review admission, consumption, reply, final-idle, rejection, or unknown state
   in the same panel.

Clipboard submission remains available without pairing. Dictation remains
fully local and only its reviewed text can enter a provider submission.

## Trust and transport

- Pairing starts in the target task; Visualizer never enumerates or infers tasks.
- The companion binds an operating-system-selected `127.0.0.1` port and checks
  the exact `Host` header.
- A 256-bit bootstrap capability is single-use and expires after five minutes.
- Pairing returns a separate 256-bit bearer capability scoped to the current
  connection generation.
- Bearer comparison is constant-time. Requests are bounded JSON with fixed
  methods and routes.
- Connection capabilities remain in memory. Provider or application restart
  requires explicit re-pairing; there is no plaintext persistence fallback.
- Explicit Unpair retires bindings and invalidates the active capability.
- Visualizer sends only frozen feedback text, target metadata, opaque document
  identity, readable filename, and revision. It does not send the drawing file,
  unrelated scene content, local path, crop, or dictation audio.

## Receipt semantics

The UI preserves the distinctions established in Stage 0:

- `prepared`: persisted before host dispatch;
- `accepted`: `session.send()` returned a provider message ID;
- `consumed`: the matching `user.message` was observed;
- `reply observed`: a correlated assistant reply was observed;
- `idle after turn`: the host later became globally idle;
- `rejected`: the provider rejected before admission;
- `unknown`: admission could not be confirmed after dispatch began; and
- `retired`: the user explicitly ended an unresolved attempt without replay.

An accepted or unknown attempt is never retried automatically. An unresolved
unknown attempt blocks later queued dispatch for that generation until the user
retires it. Immediate steering may remain session-level when the host cannot
attribute a distinct reply.

## Private persistence

`feedback.sqlite` replaces the Stage 1 JSON store under Electron user data.
The database enables foreign keys, WAL, a bounded busy timeout, and schema
versioning. It stores:

- feedback drafts and immutable submission snapshots;
- paired generations without their bearer capabilities;
- document bindings;
- ordered delivery attempts and provider message IDs;
- receipt/reply event history; and
- retirement state.

An existing `feedback.json` is strictly parsed, imported once in a transaction,
and renamed after successful migration. Invalid legacy data is not silently
reset.

## Companion protocol

The project extension at
`.github/extensions/excalidraw-visualizer-companion/extension.mjs` exposes:

- `POST /v1/pair`
- `GET /v1/status`
- `POST /v1/bindings`
- `POST /v1/submissions`
- `GET /v1/events`
- `POST /v1/bindings/{id}/revoke`
- `POST /v1/unpair`

The companion retains the bounded Stage 0 diagnostic endpoints and descriptor
for feasibility regression checks. Product delivery uses only the one-time
pairing path.

## Verification

Automated coverage verifies:

- SQLite persistence, migration, immutable snapshots, document identity moves,
  generation-scoped bindings, and unknown-attempt state;
- explicit pairing against a loopback companion;
- accepted dispatch and consumed/reply/idle correlation;
- unknown admission blocking without a second provider submission; and
- existing watcher, merge, document-registry, dictation, and audio behavior.

Live validation against the installed companion verified one-time pairing,
binding creation, event paging, explicit unpair, and rejection of the revoked
bearer capability. A real provider submission was deliberately not injected
into the implementation task during its active turn.

## Known boundary

The installed host still exposes no supported global task listing,
activation, or creation API. Pairing must begin inside the intended task.
Restart requires re-pairing. These are explicit product constraints, not hidden
recovery behavior.
