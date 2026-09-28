# Agent feedback Stage 0 feasibility

Status: feasibility finalized with a constrained-go decision, 2026-09-28. This
document records observed capabilities of the installed GitHub Copilot app, the
bounded diagnostic harness in this repository, and the contract that Stage 2
may implement. It does not describe a shipped Visualizer feature.

The product baseline remains
[Visual feedback and agent integration](AGENT-FEEDBACK-PROPOSAL.md). Stage 0
must prove that an external Visualizer process can address the intended existing
Copilot task honestly and safely before application integration begins.

## Final outcome

Stage 0 is a **go** for an explicitly paired companion that is initiated from
the intended Copilot task and remains scoped to that host-issued session
identity. It is a **no-go** for seamless task discovery, task activation, task
creation, or reverse startup from Visualizer with the installed host API.

Stage 2 may therefore implement a first integrated workflow only with these
constraints:

- the user opens the companion in the Copilot task they intend to pair;
- that task creates a short-lived, one-time local pairing capability;
- Visualizer binds only explicitly selected documents to that identity;
- a restart or lost provider requires explicit re-pairing;
- immediate steering and queued delivery use separate receipt semantics; and
- the UI never calls admission, a generic idle event, or an ambiguous steering
  result “completed.”

Do not scan task workspaces, infer a task from repository/path/title/recency, or
silently create a second SDK conversation. A future host API can remove the
explicit-pairing limitation only after a new capability check and feasibility
record.

## Tested host

| Component | Observed version |
| --- | --- |
| GitHub Copilot desktop app | `1.1.23` |
| Bundled Copilot CLI | `1.0.87-0` |
| Bundled extension SDK protocol | `3` |
| Platform used for this evidence | macOS arm64 |

These are feasibility observations, not a compatibility promise. Extension and
canvas APIs are experimental and must be capability-checked on every supported
host version.

## What the installed API exposes

The bundled SDK and a live project extension establish the following:

| Capability | Evidence | Product implication |
| --- | --- | --- |
| Join the existing task | A project extension calls `joinSession()` and receives the current foreground task's stable `sessionId`. | A companion can run inside the conversation that already owns repository context. It need not create or resume a second SDK conversation. |
| Immediate and queued delivery | `session.send()` accepts `mode: "immediate"` and `mode: "enqueue"` and returns the submitted user-message ID after admission. | The two requested intents have distinct host operations. Admission is not execution or completion. |
| Ready/working signal | `assistant.turn_start` identifies root-agent work; `session.idle` is emitted only when no background agent or attached shell remains in flight. | Automatic queue advancement can use a stronger signal than `assistant.idle`, which may occur while related background work continues. |
| Blocked states | Separate `permission.requested` / `permission.completed` and `user_input.requested` / `user_input.completed` events include correlation IDs. | Permission and clarification waits can hold automatic delivery and show an explicit reason. |
| Queue observation | Experimental `session.rpc.queue.pendingItems()` reports queued items, immediate steering messages, and in-flight steering count. | The feasibility harness can inspect queue behavior. Product code must isolate this experimental adapter surface and handle its absence. |
| Canvas diagnostics | The host advertises `ui.canvases: true`; project canvas registration, open, action invocation, rehydration, and input-schema rejection work. | A companion canvas is useful for diagnostics, but Visualizer remains the product UI. |
| Session-local artifacts | `session.workspacePath` is present. | A feasibility descriptor can be scoped to this task rather than published through a machine-wide discovery file. |

The same live capability report returned `ui.elicitation: true`,
`ui.mcpApps: false`, and `extensions: false`. The extension still loads through
the app's project-extension mechanism; the unexplained `extensions: false` field
must not be interpreted as a general extension availability check.

No supported external API for listing all desktop tasks, activating a task,
creating a task, or obtaining a session identity by repository was established.
The reverse startup and seamless natural-language launch requirements are
therefore recorded as unsupported for this host version rather than left as
indefinite Stage 0 gates. A joined extension proves control of its own task only.

## Diagnostic harness

The project extension at
`.github/extensions/excalidraw-visualizer-stage0/extension.mjs` joins the current
Copilot task and provides:

- a diagnostic canvas with readiness, queue, capability, and event summaries;
- `get_status` and schema-validated `submit_probe` canvas actions;
- an authenticated HTTP bridge bound to an operating-system-selected port on
  `127.0.0.1`;
- `GET /v1/status` and `POST /v1/messages` for a native-process feasibility
  probe; and
- a session-scoped connection descriptor at
  `<session workspace>/files/excalidraw-visualizer-stage0-bridge.json`.

The descriptor is created with user-only mode `0600` on macOS/Linux and contains
an ephemeral bearer token. The bridge validates the exact loopback `Host`, uses
constant-time token comparison, accepts only bounded `application/json` bodies,
and never logs or returns the token. It is removed when that extension process
shuts down, without deleting a replacement descriptor written by a newer
extension generation.

The bridge accepts only a prompt, delivery mode, and optional display label. It
does not read drawings, invoke shell commands, approve permissions, expose task
history, or accept file paths or attachments. This keeps the first experiment
inside the current security and offline policy: no drawing content is transmitted
by the harness. Product credentials still require the OS-backed ownership and
revocation model in the planning baseline; a mode-`0600` JSON token is only a
local feasibility mechanism.

The helper script exercises the native-process side without printing the token:

```powershell
node scripts/probe-agent-feedback-bridge.mjs <descriptor-path> status
node scripts/probe-agent-feedback-bridge.mjs <descriptor-path> send enqueue "Stage 0 probe"
node scripts/probe-agent-feedback-bridge.mjs <descriptor-path> send immediate "Stage 0 probe"
```

The script refuses non-loopback descriptor endpoints. A successful send prints
the task ID, message ID, requested mode, and admission time. It must not call that
result handled, executed, or complete.

## Evidence captured so far

- The project extension loaded in the installed app and joined the current test
  session; its action and external bridge reported the same host-issued identity.
- Its declared canvas and both actions were discoverable.
- The canvas opened through the host and returned a loopback URL.
- Both the canvas action and external helper returned the same session ID,
  readiness state, host capabilities, and queue summary.
- Invalid action input was rejected by runtime schema validation before dispatch.
- The descriptor was mode `0600`.
- An authenticated bridge status request succeeded; the same request without a
  token returned HTTP `401`.
- An `immediate` submission made while the task was working returned a message
  ID, appeared in the steering lane, and arrived in the same conversation.
- An `enqueue` submission made while the task was working appeared as one pending
  queue item, drained automatically after the active turn ended, and produced a
  correlated `user.message` with delivery `queued`, a new turn, and an assistant
  result. No second Run action was needed.
- An external `enqueue` submission made after a second task reported exactly
  `idle` was consumed with delivery `idle`, produced a correlated assistant
  result, and returned to `session.idle` without another click.
- An external `immediate` submission made after that task reported exactly
  `idle` was also consumed with delivery `idle`, not `steering`, and produced a
  correlated result in the same task.
- In interactive mode, a real `user_input.requested` event changed readiness to
  `blocked`. A subsequently admitted queued probe remained unconsumed with one
  pending queue item. After the matching clarification was answered, the block
  cleared and the queued probe ran automatically with delivery `queued`.
  Autopilot mode instead returned a synthetic user-unavailable answer immediately
  and therefore is not a valid clarification-block test.
- A safe shell probe completed without asking for permission under the current
  host policy, so a persistent permission wait was not manufactured. The SDK's
  correlated permission event contract is present; Stage 2 must preserve the
  host prompt, pause dispatch when it occurs, and include a real interactive
  permission wait in its release acceptance test.
- A second simultaneous Copilot task in the same checkout loaded its own extension
  process, session ID, mode-`0600` descriptor, loopback port, and bearer token.
  The task-local token hashes and endpoints differed. Each authenticated status
  call reported only its owning task, each unauthenticated call returned `401`,
  and the second task's immediate self-probe returned only to that conversation.
- Extension reload reconnected the provider, preserved action routing for the
  open canvas instance, and replaced the descriptor with a new generation.
  The final contract treats broader restart/wake failures as disconnects and
  requires generation validation and explicit re-pair rather than automatic replay.
- Live history showed that host turn IDs can be reused after a resumed turn. The
  diagnostic now includes a connection generation and monotonic event sequence
  and retains the first chronological turn-end match instead of overwriting it.

These checks demonstrate routing, authentication, queue advancement, and
isolation. The finalized product contract below deliberately chooses
disconnect-and-re-pair behavior for lifecycle cases that cannot be made seamless
with the exposed API.

## Acceptance result

| Requirement | Result |
| --- | --- |
| Join the originating task without a second conversation | Proven through `joinSession()` and matching host-issued identity. |
| Immediate while busy | Proven to enter the steering lane in the same task. Admission and global turn completion are observable; a steering reply is not always attributable to one feedback item. |
| Queue while busy | Proven to remain pending, start automatically, and correlate admission, `user.message`, turn, reply, and final idle without a second Run action. |
| Delivery while already idle | Proven through an external authenticated sender after the target reported `idle`; the admitted item started without another click. |
| Questions and permission waits | The host exposes correlated requested/completed events. A clarification wait was exercised with queued work held until the answer. The safe permission probe was auto-allowed, so a real permission wait remains a Stage 2 release test. Permission policy remains the host's responsibility; the companion must never answer it. |
| Two tasks in one checkout | Proven to use separate identities, providers, descriptors, ports, capabilities, and queues. |
| Canvas close and task focus | Canvas UI lifetime is separate from the session bridge. Focus is never used for routing; the bound host identity is. |
| Reload and stale generation | Provider reload rehydrates the canvas and replaces the endpoint/token. Old descriptors do not acquire the replacement identity. |
| Restart and sleep/wake | Final behavior is conservative: pause on disconnect, never replay an accepted/unknown attempt, validate generation after wake, and require explicit re-pair after provider/app restart. |
| Seamless task discovery/activation/creation | Unsupported by the installed API. This is a finalized product limitation, not a deferred implementation assumption. |

## Stage 2 adapter contract

### Pairing and lifecycle

Pairing is initiated inside the target Copilot task. The companion creates an
ephemeral loopback endpoint and a 256-bit one-time bootstrap capability. Its
task-local descriptor is mode `0600` on macOS/Linux, expires after five minutes,
and is removed after exchange or provider shutdown. The user explicitly hands
that pairing capability to Visualizer; Visualizer does not enumerate session
workspaces.

The pairing exchange returns:

- protocol version;
- opaque provider, host, and session identity;
- a random connection generation;
- supported delivery, event, and queue capabilities; and
- current readiness and blocked reason.

The bootstrap capability is rotated after exchange. The first release is
session-only: connection secrets stay in memory, are not written to the feedback
store, and are not automatically restored. Persistent reconnect may be added
later only with OS-backed secret storage; there is no plaintext fallback.
Unpairing revokes the in-memory capability, retires every affected binding
generation, freezes pending work, and closes the bridge. Provider/app restart
does the same implicitly and requires a new explicit pairing.

Closing the diagnostic or future companion canvas does not retarget or silently
unpair an established bridge; explicit Unpair owns that decision. A provider
disconnect pauses dispatch. After sleep/wake, Visualizer must verify endpoint,
session identity, and connection generation before continuing. Any mismatch
retires the connection. An accepted or unknown attempt is never replayed.

### Transport and limits

Authenticated HTTP on an operating-system-selected `127.0.0.1` port is the
selected first transport because the joined extension runs in a separate host
process and the loopback lifecycle has been exercised on both simultaneous
tasks. Every request requires the current bearer capability, exact loopback
`Host`, expected method and content type. Token comparison is constant-time.
There are no callback URLs, non-loopback binds, shell commands, file reads, or
permission decisions in the bridge.

Protocol version 1 uses these operations:

| Operation | Required input and result |
| --- | --- |
| `POST /v1/pair` | One-time bootstrap capability and Visualizer nonce; returns connection identity, generation, capabilities, and readiness. |
| `GET /v1/status` | Returns identity/generation, readiness, blocked reason, queue summary, and last monotonically increasing event sequence. |
| `POST /v1/bindings` | Explicit document ID, canonical-path hash, saved revision, and requested capabilities; returns binding ID and generation. The raw path is shown to the user locally but is not required by the bridge. |
| `POST /v1/submissions` | Submission ID, binding generation, document/dispatch revisions, delivery intent, and frozen feedback context; returns accepted, rejected, or unknown plus provider message ID when supplied. |
| `GET /v1/events` | Cursor and page limit; returns ordered readiness, receipt, reply/result, block, and disconnect events for the current generation. |
| `POST /v1/bindings/{id}/revoke` | Retires the binding generation and returns durable local retirement state. It cannot retract host-accepted content. |

Version 1 limits are:

- 1 MiB maximum JSON request or response body;
- 128 ASCII characters per opaque ID;
- 10,000 characters per feedback item and 32 items per submission;
- 512 KiB maximum generated provider prompt;
- 240 characters for a display label;
- 100 events per event page;
- five seconds for connect/handshake and 30 seconds for host admission; and
- FIFO queued dispatch per session connection, with immediate steering allowed
  to bypass waiting items but never an unresolved accepted/unknown barrier.

Any admission timeout after the host call begins becomes `unknown`, not failed.
Malformed, oversized, stale-generation, unauthorized, or out-of-order requests
are rejected explicitly. Binary attachments and crops are disabled in the first
integrated release. Submitted context is limited to user text, paired document
identity, immutable revision, target IDs/bounds, relevant element data, and
readable labels. An opt-in local crop can be added later only when the adapter
advertises image support.

### Receipts, readiness, and correlation

The adapter exposes `disconnected`, `idle`, `working`, `blocked`, and `error`
readiness. `permission.requested` and `user_input.requested` produce `blocked`
with their host correlation ID; only the matching completed event clears it.
The dispatcher never answers either request.

`session.send()` returning a message ID means **admitted** only. Matching
`user.message` means **consumed**. A correlated assistant message means a
**reply observed**. `assistant.turn_end` followed by `session.idle` means the
host became globally idle after that turn; it does not prove file changes,
user acceptance, or completion of an uncorrelated immediate steering item.
Correlation is scoped to connection generation and chronological event
sequence because host turn IDs may be reused after resume.

Queued submissions can own a distinct correlated turn. Immediate submissions
join the current steering turn and therefore show session-level progress unless
the host supplies a distinct originating message ID. The UI must retain
`accepted` or `unknown` rather than inventing a per-feedback result.

### Durable state

Stage 2 will replace the Stage 1 JSON feedback file with one application-private
SQLite store using the Electron runtime's verified built-in `node:sqlite`.
Feedback, bindings, generations, immutable submissions, outbox ordering,
attempts, receipts, replies, retirement state, and migration state share
transactions. Enable foreign keys, WAL, bounded busy handling, and schema
version migrations. Keep any future crop assets in a private content-addressed
directory referenced by the database; never create repository sidecars.

Before dispatch, persist the immutable submission and attempt. After host
admission, persist the provider message ID and accepted state in one transaction.
A crash in between yields `unknown`, blocks later queued work for that connection,
and requires reconciliation or explicit user override. Local feedback remains
usable offline and integration-disabled editing makes no network request.
