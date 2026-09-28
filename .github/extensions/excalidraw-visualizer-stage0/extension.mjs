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

const MAX_BODY_BYTES = 16 * 1024;
const MAX_PROMPT_LENGTH = 4_000;
const MAX_DISPLAY_PROMPT_LENGTH = 240;
const PROTOCOL_VERSION = 1;
const canvasServers = new Map();
const recentEvents = [];
const admittedMessages = [];

let session;
let bridge;
let descriptorPath;
let descriptorToken;
let shuttingDown = false;

const runtimeState = {
  readiness: "unknown",
  blockedReason: null,
  activeTurnId: null,
  lastEventAt: null
};

function recordEvent(type, timestamp = new Date().toISOString()) {
  runtimeState.lastEventAt = timestamp;
  recentEvents.push({ type, timestamp });
  if (recentEvents.length > 20) {
    recentEvents.shift();
  }
}

function updateRuntimeState(event) {
  recordEvent(event.type, event.timestamp);

  switch (event.type) {
    case "user.message": {
      const admitted = admittedMessages.find(
        (entry) => entry.messageId === event.data.messageId
      );
      if (admitted) {
        admitted.delivery = event.data.delivery ?? null;
        admitted.consumedAt = event.timestamp;
        admitted.turnId = event.data.turnId ?? null;
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
      const admitted = admittedMessages.find(
        (entry) => entry.messageId === event.data.originatingMessageId
      );
      if (admitted) {
        admitted.assistantMessageId = event.data.messageId;
        admitted.resultObservedAt = event.timestamp;
      }
      break;
    }
    case "assistant.turn_end":
      if (!event.agentId) {
        for (const admitted of admittedMessages) {
          if (admitted.turnId === event.data.turnId) {
            admitted.turnEndedAt = event.timestamp;
          }
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
      for (const admitted of admittedMessages) {
        if (admitted.consumedAt && !admitted.sessionIdleAt) {
          admitted.sessionIdleAt = event.timestamp;
        }
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
}

function validateSubmission(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("The request body must be a JSON object.");
  }

  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) {
    throw new Error("prompt must be a non-empty string.");
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new Error(`prompt must not exceed ${MAX_PROMPT_LENGTH} characters.`);
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

async function submitMessage(input) {
  if (!session) {
    throw new Error("The Copilot session is not connected.");
  }

  const submission = validateSubmission(input);
  const messageId = await session.send(submission);
  const admittedAt = new Date().toISOString();
  admittedMessages.push({
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
    sessionId: session.sessionId,
    workspaceAvailable: Boolean(session.workspacePath),
    capabilities: session.capabilities,
    readiness: runtimeState.readiness,
    blockedReason: runtimeState.blockedReason,
    activeTurnId: runtimeState.activeTurnId,
    lastEventAt: runtimeState.lastEventAt,
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
    <title>Agent feedback Stage 0</title>
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
    <h1>Agent feedback Stage 0</h1>
    <p>Diagnostic surface for the current Copilot session. This is not product UI.</p>

    <section class="card">
      <div class="grid">
        <span class="label">Instance</span><code>${instanceId}</code>
        <span class="label">Session</span><code id="session-id">Loading…</code>
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
    id: "excalidraw-visualizer-stage0",
    displayName: "Excalidraw Visualizer Stage 0",
    description:
      "Inspect and exercise same-session Excalidraw Visualizer delivery capabilities.",
    actions: [
      {
        name: "get_status",
        description:
          "Return the observed session readiness, queue summary, and host capabilities.",
        handler: getStatus
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
              maxLength: MAX_PROMPT_LENGTH
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
        title: "Agent feedback Stage 0",
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
    if (!hasBearerToken(request, token)) {
      sendJson(response, 401, { error: "Authentication required." });
      return;
    }

    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    try {
      if (request.method === "GET" && url.pathname === "/v1/status") {
        sendJson(response, 200, await getStatus());
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/messages") {
        sendJson(response, 202, await submitMessage(await readJsonBody(request)));
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
