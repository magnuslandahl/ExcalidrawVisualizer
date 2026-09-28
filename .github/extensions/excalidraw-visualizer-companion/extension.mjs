import { Buffer } from "node:buffer";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { URL } from "node:url";
import { createCanvas, joinSession } from "@github/copilot-sdk/extension";

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_DIAGNOSTIC_PROMPT_LENGTH = 4_000;
const MAX_PROVIDER_PROMPT_LENGTH = 512 * 1024;
const MAX_DISPLAY_PROMPT_LENGTH = 240;
const PROTOCOL_VERSION = 1;
const PAIRING_TTL_MS = 5 * 60 * 1000;
const connectionGeneration = randomBytes(16).toString("hex");
const canvasServers = new Map();
const recentEvents = [];
const admittedMessages = [];
const pendingCorrelationEvents = [];
const integrationEvents = [];
const bindings = new Map();
let eventSequence = 0;
let integrationEventSequence = 0;

let session;
let bridge;
let descriptorPath;
let descriptorToken;
let bootstrapCapability;
let activeConnection;
let shuttingDown = false;

const runtimeState = {
  readiness: "unknown",
  blockedReason: null,
  activeTurnId: null,
  lastEventAt: null
};

function recordEvent(type, timestamp = new Date().toISOString()) {
  runtimeState.lastEventAt = timestamp;
  eventSequence += 1;
  recentEvents.push({ sequence: eventSequence, type, timestamp });
  if (recentEvents.length > 20) {
    recentEvents.shift();
  }
}

function recordIntegrationEvent(type, data, createdAt = new Date().toISOString()) {
  integrationEventSequence += 1;
  integrationEvents.push({
    sequence: integrationEventSequence,
    type,
    createdAt,
    data
  });
  if (integrationEvents.length > 2000) {
    integrationEvents.shift();
  }
}

function replyText(data) {
  for (const value of [data?.content, data?.text, data?.message]) {
    if (typeof value === "string" && value.trim()) {
      return value.slice(0, 100_000);
    }
  }
  return null;
}

function applyCorrelationEvent(event) {
  if (event.type === "user.message") {
    const admitted = admittedMessages.find(
      (entry) => entry.messageId === event.data.messageId
    );
    if (!admitted) {
      return false;
    }
    admitted.delivery = event.data.delivery ?? null;
    admitted.consumedAt = event.timestamp;
    admitted.turnId = event.data.turnId ?? null;
    if (admitted.attemptId) {
      recordIntegrationEvent(
        "submission.consumed",
        {
          attemptId: admitted.attemptId,
          submissionId: admitted.submissionId,
          messageId: admitted.messageId,
          delivery: admitted.delivery,
          turnId: admitted.turnId
        },
        event.timestamp
      );
    }
    return true;
  }
  if (event.type === "assistant.message") {
    const admitted = admittedMessages.find(
      (entry) => entry.messageId === event.data.originatingMessageId
    );
    if (!admitted) {
      return false;
    }
    admitted.assistantMessageId = event.data.messageId;
    admitted.resultObservedAt = event.timestamp;
    if (admitted.attemptId) {
      recordIntegrationEvent(
        "submission.reply",
        {
          attemptId: admitted.attemptId,
          submissionId: admitted.submissionId,
          messageId: admitted.messageId,
          assistantMessageId: admitted.assistantMessageId,
          reply: replyText(event.data)
        },
        event.timestamp
      );
    }
    return true;
  }
  if (event.type === "assistant.turn_end") {
    let matched = false;
    for (const admitted of admittedMessages) {
      if (
        admitted.turnId === event.data.turnId &&
        admitted.consumedAt &&
        !admitted.turnEndedAt &&
        event.timestamp >= admitted.consumedAt
      ) {
        admitted.turnEndedAt = event.timestamp;
        matched = true;
      }
    }
    return matched;
  }
  if (event.type === "session.idle") {
    let matched = false;
    for (const admitted of admittedMessages) {
      if (
        admitted.consumedAt &&
        !admitted.sessionIdleAt &&
        event.timestamp >= admitted.consumedAt
      ) {
        admitted.sessionIdleAt = event.timestamp;
        matched = true;
        if (admitted.attemptId) {
          recordIntegrationEvent(
            "submission.idle",
            {
              attemptId: admitted.attemptId,
              submissionId: admitted.submissionId,
              messageId: admitted.messageId,
              turnId: admitted.turnId
            },
            event.timestamp
          );
        }
      }
    }
    return matched;
  }
  return false;
}

function bufferCorrelationEvent(event) {
  pendingCorrelationEvents.push(event);
  if (pendingCorrelationEvents.length > 100) {
    pendingCorrelationEvents.shift();
  }
}

function reconcileCorrelationEvents() {
  for (let index = 0; index < pendingCorrelationEvents.length; ) {
    if (applyCorrelationEvent(pendingCorrelationEvents[index])) {
      pendingCorrelationEvents.splice(index, 1);
    } else {
      index += 1;
    }
  }
}

function updateRuntimeState(event) {
  recordEvent(event.type, event.timestamp);

  switch (event.type) {
    case "user.message": {
      if (!applyCorrelationEvent(event)) {
        bufferCorrelationEvent(event);
      }
      break;
    }
    case "assistant.turn_start":
      if (!event.agentId) {
        runtimeState.readiness = "working";
        runtimeState.blockedReason = null;
        runtimeState.activeTurnId = event.data.turnId;
      }
      break;
    case "assistant.message": {
      if (!applyCorrelationEvent(event)) {
        bufferCorrelationEvent(event);
      }
      break;
    }
    case "assistant.turn_end":
      if (!event.agentId) {
        if (!applyCorrelationEvent(event)) {
          bufferCorrelationEvent(event);
        }
        if (runtimeState.activeTurnId === event.data.turnId) {
          runtimeState.activeTurnId = null;
        }
      }
      break;
    case "permission.requested":
      runtimeState.readiness = "blocked";
      runtimeState.blockedReason = {
        kind: "permission",
        requestId: event.data.requestId
      };
      break;
    case "permission.completed":
      if (
        runtimeState.blockedReason?.kind === "permission" &&
        runtimeState.blockedReason.requestId === event.data.requestId
      ) {
        runtimeState.readiness = "working";
        runtimeState.blockedReason = null;
      }
      break;
    case "user_input.requested":
      runtimeState.readiness = "blocked";
      runtimeState.blockedReason = {
        kind: "user-input",
        requestId: event.data.requestId
      };
      break;
    case "user_input.completed":
      if (
        runtimeState.blockedReason?.kind === "user-input" &&
        runtimeState.blockedReason.requestId === event.data.requestId
      ) {
        runtimeState.readiness = "working";
        runtimeState.blockedReason = null;
      }
      break;
    case "session.idle":
      if (!applyCorrelationEvent(event)) {
        bufferCorrelationEvent(event);
      }
      runtimeState.readiness = "idle";
      runtimeState.blockedReason = null;
      runtimeState.activeTurnId = null;
      break;
    case "session.error":
      runtimeState.readiness = "error";
      runtimeState.blockedReason = {
        kind: "session-error",
        errorType: event.data.errorType
      };
      runtimeState.activeTurnId = null;
      break;
    case "session.shutdown":
      runtimeState.readiness = "disconnected";
      runtimeState.blockedReason = {
        kind: "shutdown",
        shutdownType: event.data.shutdownType
      };
      runtimeState.activeTurnId = null;
      break;
  }

  if (
    event.type === "assistant.turn_start" ||
    event.type === "permission.requested" ||
    event.type === "permission.completed" ||
    event.type === "user_input.requested" ||
    event.type === "user_input.completed" ||
    event.type === "session.idle" ||
    event.type === "session.error" ||
    event.type === "session.shutdown"
  ) {
    recordIntegrationEvent(
      "connection.status",
      {
        readiness: runtimeState.readiness,
        blockedReason: runtimeState.blockedReason
      },
      event.timestamp
    );
  }
}

function validateSubmission(input, maximumPromptLength) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("The request body must be a JSON object.");
  }

  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) {
    throw new Error("prompt must be a non-empty string.");
  }
  if (prompt.length > maximumPromptLength) {
    throw new Error(`prompt must not exceed ${maximumPromptLength} characters.`);
  }

  const mode = input.mode ?? "enqueue";
  if (mode !== "enqueue" && mode !== "immediate") {
    throw new Error('mode must be either "enqueue" or "immediate".');
  }

  let displayPrompt;
  if (input.displayPrompt !== undefined) {
    if (typeof input.displayPrompt !== "string" || !input.displayPrompt.trim()) {
      throw new Error("displayPrompt must be a non-empty string when provided.");
    }
    displayPrompt = input.displayPrompt.trim();
    if (displayPrompt.length > MAX_DISPLAY_PROMPT_LENGTH) {
      throw new Error(
        `displayPrompt must not exceed ${MAX_DISPLAY_PROMPT_LENGTH} characters.`
      );
    }
  }

  return { prompt, mode, displayPrompt };
}

async function submitMessage(input, tracking = {}) {
  if (!session) {
    throw new Error("The Copilot session is not connected.");
  }

  const submission = validateSubmission(
    input,
    tracking.attemptId
      ? MAX_PROVIDER_PROMPT_LENGTH
      : MAX_DIAGNOSTIC_PROMPT_LENGTH
  );
  const messageId = await session.send(submission);
  const admittedAt = new Date().toISOString();
  admittedMessages.push({
    connectionGeneration,
    attemptId: tracking.attemptId ?? null,
    submissionId: tracking.submissionId ?? null,
    messageId,
    mode: submission.mode,
    admittedAt,
    delivery: null,
    consumedAt: null,
    turnId: null,
    assistantMessageId: null,
    resultObservedAt: null,
    turnEndedAt: null,
    sessionIdleAt: null
  });
  if (admittedMessages.length > 20) {
    admittedMessages.shift();
  }
  reconcileCorrelationEvents();

  return {
    messageId,
    mode: submission.mode,
    admittedAt
  };
}

async function getStatus() {
  let queue;
  let queueError;

  try {
    queue = await session.rpc.queue.pendingItems();
  } catch (error) {
    queueError = error instanceof Error ? error.message : String(error);
  }

  return {
    protocolVersion: PROTOCOL_VERSION,
    connectionGeneration,
    sessionId: session.sessionId,
    workspaceAvailable: Boolean(session.workspacePath),
    capabilities: session.capabilities,
    readiness: runtimeState.readiness,
    blockedReason: runtimeState.blockedReason,
    activeTurnId: runtimeState.activeTurnId,
    lastEventAt: runtimeState.lastEventAt,
    lastEventSequence: eventSequence,
    queue: queue
      ? {
          itemCount: queue.items.length,
          steeringMessageCount: queue.steeringMessages.length,
          inFlightSteeringCount: queue.inFlightSteeringCount ?? null
        }
      : null,
    queueError: queueError ?? null,
    admittedMessages: [...admittedMessages],
    recentEvents: [...recentEvents]
  };
}

function boundedString(value, label, maximum = 128) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > maximum ||
    !/^[\x20-\x7e]+$/.test(value)
  ) {
    throw new Error(`${label} must be a non-empty ASCII string of at most ${maximum} characters.`);
  }
  return value;
}

function createPairingCode() {
  if (!bridge) {
    throw new Error("The companion bridge is not ready.");
  }
  bootstrapCapability = {
    token: randomBytes(32).toString("base64url"),
    expiresAt: new Date(Date.now() + PAIRING_TTL_MS).toISOString()
  };
  const payload = {
    endpoint: bridge.descriptor.endpoint,
    bootstrapToken: bootstrapCapability.token,
    generation: connectionGeneration,
    expiresAt: bootstrapCapability.expiresAt
  };
  return `evp1:${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
}

function pairVisualizer(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("The pairing request must be an object.");
  }
  if (
    !bootstrapCapability ||
    new Date(bootstrapCapability.expiresAt).getTime() <= Date.now() ||
    typeof input.bootstrapToken !== "string" ||
    !tokenMatches(input.bootstrapToken, bootstrapCapability.token)
  ) {
    throw new Error("The pairing capability is invalid or expired.");
  }
  boundedString(input.visualizerNonce, "visualizerNonce", 128);
  const connectionToken = randomBytes(32).toString("base64url");
  activeConnection = {
    token: connectionToken,
    visualizerNonce: input.visualizerNonce,
    pairedAt: new Date().toISOString()
  };
  bootstrapCapability = undefined;
  bindings.clear();
  recordIntegrationEvent("connection.paired", {
    sessionId: session.sessionId,
    generation: connectionGeneration
  });
  return {
    protocolVersion: PROTOCOL_VERSION,
    connectionToken,
    connectionGeneration,
    sessionId: session.sessionId,
    readiness: runtimeState.readiness,
    blockedReason: runtimeState.blockedReason,
    lastEventSequence: integrationEventSequence,
    capabilities: {
      delivery: ["enqueue", "immediate"],
      events: true,
      textFeedback: true
    }
  };
}

function createBinding(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("The binding request must be an object.");
  }
  const documentId = boundedString(input.documentId, "documentId");
  boundedString(input.canonicalPathHash, "canonicalPathHash");
  boundedString(input.savedRevision, "savedRevision", 1024);
  const existing = [...bindings.values()].find(
    (binding) => binding.documentId === documentId && !binding.retiredAt
  );
  if (existing) {
    return {
      bindingId: existing.id,
      generation: connectionGeneration,
      createdAt: existing.createdAt
    };
  }
  const binding = {
    id: randomBytes(16).toString("hex"),
    documentId,
    createdAt: new Date().toISOString(),
    retiredAt: null
  };
  bindings.set(binding.id, binding);
  return {
    bindingId: binding.id,
    generation: connectionGeneration,
    createdAt: binding.createdAt
  };
}

async function submitIntegration(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("The submission request must be an object.");
  }
  const attemptId = boundedString(input.attemptId, "attemptId");
  const submissionId = boundedString(input.submissionId, "submissionId");
  const bindingId = boundedString(input.bindingId, "bindingId");
  if (input.bindingGeneration !== connectionGeneration) {
    throw new Error("The binding generation is stale.");
  }
  const binding = bindings.get(bindingId);
  if (!binding || binding.retiredAt) {
    throw new Error("The binding is unavailable.");
  }
  boundedString(input.documentRevision, "documentRevision", 1024);
  boundedString(input.dispatchRevision, "dispatchRevision", 1024);
  const submission = await submitMessage(
    {
      prompt: input.prompt,
      mode: input.deliveryIntent,
      displayPrompt: input.displayPrompt
    },
    { attemptId, submissionId }
  );
  recordIntegrationEvent("submission.accepted", {
    attemptId,
    submissionId,
    messageId: submission.messageId,
    mode: submission.mode
  }, submission.admittedAt);
  return {
    status: "accepted",
    messageId: submission.messageId,
    admittedAt: submission.admittedAt
  };
}

function revokeBinding(bindingId) {
  const binding = bindings.get(bindingId);
  if (!binding) {
    throw new Error("The binding was not found.");
  }
  binding.retiredAt = new Date().toISOString();
  return { bindingId, retiredAt: binding.retiredAt };
}

function listIntegrationEvents(url) {
  const cursor = Number(url.searchParams.get("cursor") ?? "0");
  const limit = Number(url.searchParams.get("limit") ?? "100");
  if (!Number.isInteger(cursor) || cursor < 0) {
    throw new Error("cursor must be a non-negative integer.");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("limit must be between 1 and 100.");
  }
  const firstAvailableSequence = integrationEvents[0]?.sequence;
  if (
    firstAvailableSequence !== undefined &&
    cursor < firstAvailableSequence - 1
  ) {
    throw new Error("The event cursor expired; explicit re-pairing is required.");
  }
  const events = integrationEvents
    .filter((event) => event.sequence > cursor)
    .slice(0, limit);
  return {
    events,
    nextCursor: events.at(-1)?.sequence ?? cursor,
    readiness: runtimeState.readiness,
    blockedReason: runtimeState.blockedReason
  };
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(value));
}

function sendText(response, statusCode, value) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(value);
}

async function readJsonBody(request) {
  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !contentType.toLowerCase().startsWith("application/json")
  ) {
    throw new Error("Content-Type must be application/json.");
  }

  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes.`);
    }
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) {
    throw new Error("Request body is required.");
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Request body must contain valid JSON.");
  }
}

function tokenMatches(provided, expected) {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return (
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  );
}

function hasBearerToken(request, expectedToken) {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    return false;
  }
  return tokenMatches(authorization.slice("Bearer ".length), expectedToken);
}

function hasCanvasToken(request, expectedToken) {
  const token = request.headers["x-stage0-canvas-token"];
  return typeof token === "string" && tokenMatches(token, expectedToken);
}

function validateHost(request, port) {
  return request.headers.host === `127.0.0.1:${port}`;
}

function escapedJson(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function renderCanvasHtml(instanceId, canvasToken) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Excalidraw Visualizer companion</title>
    <style>
      :root { color-scheme: light dark; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        padding: 20px;
        background: var(--background-color-default, #fff);
        color: var(--text-color-default, #1f2328);
        font-family: var(--font-sans, system-ui, sans-serif);
        font-size: var(--text-body-medium, 14px);
        line-height: var(--leading-body-medium, 20px);
      }
      h1 { margin: 0 0 6px; font-size: var(--text-title-large, 24px); }
      h2 { margin: 20px 0 8px; font-size: var(--text-title-medium, 18px); }
      p { margin: 6px 0; color: var(--text-color-muted, #59636e); }
      code, pre { font-family: var(--font-mono, ui-monospace, monospace); }
      .card {
        margin-top: 16px;
        padding: 14px;
        border: 1px solid var(--border-color-default, #d1d9e0);
        border-radius: 8px;
      }
      .grid {
        display: grid;
        grid-template-columns: minmax(120px, 0.4fr) minmax(0, 1fr);
        gap: 8px 12px;
      }
      .label { color: var(--text-color-muted, #59636e); }
      textarea, select, button {
        width: 100%;
        margin-top: 8px;
        padding: 8px 10px;
        border: 1px solid var(--border-color-default, #d1d9e0);
        border-radius: 6px;
        background: var(--background-color-default, #fff);
        color: var(--text-color-default, #1f2328);
        font: inherit;
      }
      textarea { min-height: 96px; resize: vertical; }
      button {
        cursor: pointer;
        background: var(--true-color-blue, #0969da);
        color: var(--color-white, #fff);
        font-weight: var(--font-weight-semibold, 600);
      }
      button:disabled { cursor: wait; opacity: 0.6; }
      pre {
        max-height: 220px;
        overflow: auto;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .error { color: var(--true-color-red, #cf222e); }
      .success { color: var(--true-color-green, #1a7f37); }
    </style>
  </head>
  <body>
    <h1>Excalidraw Visualizer companion</h1>
    <p>Pair Visualizer explicitly with this Copilot task, or inspect the diagnostic state.</p>

    <section class="card">
      <h2>Pair Excalidraw Visualizer</h2>
      <p>Generate a one-time code, then paste it into Visualizer within five minutes.</p>
      <button id="pair" type="button">Copy one-time pairing code</button>
      <textarea id="pair-code" readonly hidden aria-label="Pairing code"></textarea>
      <p id="pair-result" hidden></p>
    </section>

    <section class="card">
      <div class="grid">
        <span class="label">Instance</span><code>${instanceId}</code>
        <span class="label">Session</span><code id="session-id">Loading…</code>
        <span class="label">Generation</span><code id="generation">Loading…</code>
        <span class="label">Readiness</span><strong id="readiness">Loading…</strong>
        <span class="label">Queued</span><span id="queued">Loading…</span>
        <span class="label">Last event</span><span id="last-event">Loading…</span>
      </div>
      <p id="status-error" class="error" hidden></p>
    </section>

    <section class="card">
      <h2>Submit a probe message</h2>
      <p>The runtime returns admission, not proof that the agent completed the request.</p>
      <textarea id="prompt">Reply with “Stage 0 probe received” and do not modify files.</textarea>
      <select id="mode">
        <option value="enqueue">Queue</option>
        <option value="immediate">Send now / steer</option>
      </select>
      <button id="send" type="button">Submit probe</button>
      <p id="send-result" hidden></p>
    </section>

    <section class="card">
      <h2>Recent runtime events</h2>
      <pre id="events">Loading…</pre>
    </section>

    <script>
      const canvasToken = ${escapedJson(canvasToken)};
      const headers = { "x-stage0-canvas-token": canvasToken };

      async function readResponse(response) {
        const value = await response.json();
        if (!response.ok) throw new Error(value.error || "Request failed.");
        return value;
      }

      async function refreshStatus() {
        const error = document.querySelector("#status-error");
        try {
          const status = await readResponse(await fetch("/api/status", { headers }));
          document.querySelector("#session-id").textContent = status.sessionId;
          document.querySelector("#generation").textContent =
            status.connectionGeneration;
          document.querySelector("#readiness").textContent = status.readiness;
          document.querySelector("#queued").textContent =
            status.queue ? String(status.queue.itemCount) : "Unavailable";
          document.querySelector("#last-event").textContent =
            status.lastEventAt || "No event observed";
          document.querySelector("#events").textContent =
            JSON.stringify(status.recentEvents, null, 2);
          error.hidden = true;
        } catch (cause) {
          error.textContent = cause instanceof Error ? cause.message : String(cause);
          error.hidden = false;
        }
      }

      document.querySelector("#send").addEventListener("click", async () => {
        const button = document.querySelector("#send");
        const result = document.querySelector("#send-result");
        button.disabled = true;
        result.hidden = true;
        result.className = "";
        try {
          const submission = await readResponse(await fetch("/api/messages", {
            method: "POST",
            headers: {
              ...headers,
              "content-type": "application/json"
            },
            body: JSON.stringify({
              prompt: document.querySelector("#prompt").value,
              mode: document.querySelector("#mode").value,
              displayPrompt: "Visualizer Stage 0 probe"
            })
          }));
          result.textContent =
            "Admitted as " + submission.messageId + " using " + submission.mode + ".";
          result.className = "success";
          result.hidden = false;
          await refreshStatus();
        } catch (cause) {
          result.textContent = cause instanceof Error ? cause.message : String(cause);
          result.className = "error";
          result.hidden = false;
        } finally {
          button.disabled = false;
        }
      });

      document.querySelector("#pair").addEventListener("click", async () => {
        const button = document.querySelector("#pair");
        const result = document.querySelector("#pair-result");
        button.disabled = true;
        result.hidden = true;
        result.className = "";
        try {
          const pairing = await readResponse(await fetch("/api/pairing", {
            method: "POST",
            headers
          }));
          const code = document.querySelector("#pair-code");
          code.value = pairing.pairingCode;
          code.hidden = false;
          try {
            await navigator.clipboard.writeText(pairing.pairingCode);
            result.textContent =
              "Pairing code copied. It expires at " +
              new Date(pairing.expiresAt).toLocaleTimeString() + ".";
          } catch {
            code.select();
            result.textContent =
              "Copy the code above. It expires at " +
              new Date(pairing.expiresAt).toLocaleTimeString() + ".";
          }
          result.className = "success";
        } catch (cause) {
          result.textContent = cause instanceof Error ? cause.message : String(cause);
          result.className = "error";
        } finally {
          result.hidden = false;
          button.disabled = false;
        }
      });

      refreshStatus();
      setInterval(refreshStatus, 1500);
    </script>
  </body>
</html>`;
}

async function startCanvasServer(instanceId) {
  const canvasToken = randomBytes(24).toString("hex");
  let port = 0;

  const server = createServer(async (request, response) => {
    if (!validateHost(request, port)) {
      sendText(response, 400, "Invalid Host header.");
      return;
    }

    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
        "Content-Type": "text/html; charset=utf-8",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff"
      });
      response.end(renderCanvasHtml(instanceId, canvasToken));
      return;
    }

    if (!hasCanvasToken(request, canvasToken)) {
      sendJson(response, 401, { error: "Authentication required." });
      return;
    }

    try {
      if (request.method === "GET" && url.pathname === "/api/status") {
        sendJson(response, 200, await getStatus());
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/messages") {
        sendJson(response, 202, await submitMessage(await readJsonBody(request)));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/pairing") {
        const pairingCode = createPairingCode();
        sendJson(response, 201, {
          pairingCode,
          expiresAt: bootstrapCapability.expiresAt
        });
        return;
      }
      sendJson(response, 404, { error: "Not found." });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}/` };
}

function createDiagnosticCanvas() {
  return createCanvas({
    id: "excalidraw-visualizer-companion",
    displayName: "Excalidraw Visualizer Companion",
    description:
      "Pair Excalidraw Visualizer with this task and inspect delivery state.",
    actions: [
      {
        name: "get_status",
        description:
          "Return the observed session readiness, queue summary, and host capabilities.",
        handler: getStatus
      },
      {
        name: "create_pairing_code",
        description:
          "Create a five-minute one-time pairing code for Excalidraw Visualizer.",
        handler: () => ({
          pairingCode: createPairingCode(),
          expiresAt: bootstrapCapability.expiresAt
        })
      },
      {
        name: "submit_probe",
        description:
          "Submit a bounded diagnostic message to this same Copilot session.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            prompt: {
              type: "string",
              minLength: 1,
              maxLength: MAX_DIAGNOSTIC_PROMPT_LENGTH
            },
            mode: {
              type: "string",
              enum: ["enqueue", "immediate"]
            },
            displayPrompt: {
              type: "string",
              minLength: 1,
              maxLength: MAX_DISPLAY_PROMPT_LENGTH
            }
          },
          required: ["prompt", "mode"]
        },
        handler: async (context) => submitMessage(context.input)
      }
    ],
    open: async (context) => {
      let entry = canvasServers.get(context.instanceId);
      if (!entry) {
        entry = await startCanvasServer(context.instanceId);
        canvasServers.set(context.instanceId, entry);
      }
      return {
        title: "Excalidraw Visualizer companion",
        status: runtimeState.readiness,
        url: entry.url
      };
    },
    onClose: async (context) => {
      const entry = canvasServers.get(context.instanceId);
      if (!entry) {
        return;
      }
      canvasServers.delete(context.instanceId);
      await new Promise((resolve) => entry.server.close(resolve));
    }
  });
}

async function startBridgeServer() {
  const token = randomBytes(32).toString("base64url");
  let port = 0;

  const server = createServer(async (request, response) => {
    if (!validateHost(request, port)) {
      sendText(response, 400, "Invalid Host header.");
      return;
    }
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    try {
      if (request.method === "POST" && url.pathname === "/v1/pair") {
        sendJson(response, 201, pairVisualizer(await readJsonBody(request)));
        return;
      }
      const diagnosticAuthenticated = hasBearerToken(request, token);
      const connectionAuthenticated =
        activeConnection &&
        hasBearerToken(request, activeConnection.token);
      if (!diagnosticAuthenticated && !connectionAuthenticated) {
        sendJson(response, 401, { error: "Authentication required." });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/status") {
        sendJson(response, 200, await getStatus());
        return;
      }
      if (
        diagnosticAuthenticated &&
        request.method === "POST" &&
        url.pathname === "/v1/messages"
      ) {
        sendJson(response, 202, await submitMessage(await readJsonBody(request)));
        return;
      }
      if (!connectionAuthenticated) {
        sendJson(response, 403, { error: "A paired connection is required." });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/bindings") {
        sendJson(response, 201, createBinding(await readJsonBody(request)));
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/submissions") {
        sendJson(
          response,
          202,
          await submitIntegration(await readJsonBody(request))
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/events") {
        sendJson(response, 200, listIntegrationEvents(url));
        return;
      }
      const revokeMatch = url.pathname.match(
        /^\/v1\/bindings\/([A-Za-z0-9._-]{1,128})\/revoke$/
      );
      if (request.method === "POST" && revokeMatch) {
        sendJson(response, 200, revokeBinding(revokeMatch[1]));
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/unpair") {
        const retiredAt = new Date().toISOString();
        for (const binding of bindings.values()) {
          binding.retiredAt ??= retiredAt;
        }
        activeConnection = undefined;
        recordIntegrationEvent("connection.unpaired", { retiredAt });
        sendJson(response, 200, { retiredAt });
        return;
      }
      sendJson(response, 404, { error: "Not found." });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;

  return {
    server,
    descriptor: {
      protocolVersion: PROTOCOL_VERSION,
      connectionGeneration,
      sessionId: session.sessionId,
      endpoint: `http://127.0.0.1:${port}`,
      authentication: {
        type: "bearer",
        token
      },
      createdAt: new Date().toISOString()
    }
  };
}

function writeDescriptor(descriptor) {
  if (!session.workspacePath) {
    throw new Error("The session workspace is unavailable.");
  }

  const filesDirectory = join(session.workspacePath, "files");
  mkdirSync(filesDirectory, { recursive: true });
  descriptorPath = join(
    filesDirectory,
    "excalidraw-visualizer-stage0-bridge.json"
  );
  descriptorToken = descriptor.authentication.token;
  const temporaryPath = `${descriptorPath}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(descriptor, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, descriptorPath);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary descriptor may not have been created.
    }
    throw error;
  }
}

function removeDescriptor() {
  if (!descriptorPath) {
    return;
  }

  try {
    const current = JSON.parse(readFileSync(descriptorPath, "utf8"));
    if (
      current.sessionId === session?.sessionId &&
      current.authentication?.token === descriptorToken
    ) {
      unlinkSync(descriptorPath);
    }
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      return;
    }
  }
}

async function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  removeDescriptor();

  const closePromises = [...canvasServers.values()].map(
    (entry) => new Promise((resolve) => entry.server.close(resolve))
  );
  canvasServers.clear();
  if (bridge) {
    closePromises.push(new Promise((resolve) => bridge.server.close(resolve)));
  }
  await Promise.all(closePromises);
}

session = await joinSession({
  canvases: [createDiagnosticCanvas()]
});
session.on(updateRuntimeState);

bridge = await startBridgeServer();
writeDescriptor(bridge.descriptor);
recordEvent("extension.ready");

process.once("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});
process.once("exit", removeDescriptor);
