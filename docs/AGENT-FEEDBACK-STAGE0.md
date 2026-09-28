# Agent feedback Stage 0 feasibility

Status: active feasibility work, 2026-09-28. This document records observed
capabilities of the installed GitHub Copilot app and the bounded diagnostic
harness in this repository. It does not describe a shipped Visualizer feature.

The product baseline remains
[Visual feedback and agent integration](AGENT-FEEDBACK-PROPOSAL.md). Stage 0
must prove that an external Visualizer process can address the intended existing
Copilot task honestly and safely before application integration begins.

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
The reverse startup flow and natural-language launch flow therefore remain open
Stage 0 gates. A joined extension proves control of its own task only.

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
- A second simultaneous Copilot task in the same checkout loaded its own extension
  process, session ID, mode-`0600` descriptor, loopback port, and bearer token.
  The task-local token hashes and endpoints differed. Each authenticated status
  call reported only its owning task, each unauthenticated call returned `401`,
  and the second task's immediate self-probe returned only to that conversation.
- Extension reload reconnected the provider, preserved action routing for the
  open canvas instance, and replaced the descriptor with a new generation.
  Broader restart and stale-generation behavior still require focused tests.

These checks demonstrate routing and authentication structure. They do not yet
prove delivery while already idle, blocked-state queue holding, or full
application/crash recovery.

## Remaining Stage 0 gates

1. Run queued and immediate submissions while the task is already idle. Complete
   final `assistant.turn_end` and `session.idle` correlation for admitted messages.
2. Trigger a real permission wait and clarification wait. Confirm local queued
   work does not advance and that the blocking response remains usable.
3. Reload the extension, restart the app, sleep/wake the machine, close canvases,
   and switch foreground tasks. Record descriptor cleanup, provider rehydration,
   and stale-generation rejection.
4. Establish a supported launch/pairing route from a task to the external
   Visualizer and a supported reverse pairing route without matching by filename,
   title, repository, or recency.
5. After those results, define the versioned adapter capability contract and
   choose the production local transport and transactional store.

Application code must not consume this bridge until these gates establish the
session identity, lifecycle, and recovery contracts.
