import { readFile } from "node:fs/promises";
import process from "node:process";
import { URL } from "node:url";

function usage() {
  return [
    "Usage:",
    "  node scripts/probe-agent-feedback-bridge.mjs <descriptor> status",
    "  node scripts/probe-agent-feedback-bridge.mjs <descriptor> send <enqueue|immediate> <prompt>"
  ].join("\n");
}

function parseDescriptor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The descriptor must be a JSON object.");
  }
  if (value.protocolVersion !== 1) {
    throw new Error(`Unsupported protocol version: ${value.protocolVersion}`);
  }
  if (typeof value.sessionId !== "string" || !value.sessionId) {
    throw new Error("The descriptor is missing sessionId.");
  }
  if (
    !value.authentication ||
    value.authentication.type !== "bearer" ||
    typeof value.authentication.token !== "string" ||
    !value.authentication.token
  ) {
    throw new Error("The descriptor is missing bearer authentication.");
  }

  const endpoint = new URL(value.endpoint);
  if (
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error("The descriptor endpoint must be an HTTP loopback origin.");
  }

  return {
    sessionId: value.sessionId,
    endpoint: endpoint.origin,
    token: value.authentication.token
  };
}

async function request(descriptor, path, options = {}) {
  const response = await fetch(`${descriptor.endpoint}${path}`, {
    ...options,
    headers: {
      ...options.headers,
      authorization: `Bearer ${descriptor.token}`
    }
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error || `Bridge request failed with HTTP ${response.status}.`);
  }
  return body;
}

async function main() {
  const [, , descriptorFile, command, ...args] = process.argv;
  if (!descriptorFile || !command) {
    throw new Error(usage());
  }

  const descriptor = parseDescriptor(
    JSON.parse(await readFile(descriptorFile, "utf8"))
  );

  if (command === "status" && args.length === 0) {
    const status = await request(descriptor, "/v1/status");
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return;
  }

  if (command === "send" && args.length >= 2) {
    const [mode, ...promptParts] = args;
    const result = await request(descriptor, "/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode,
        prompt: promptParts.join(" "),
        displayPrompt: "Visualizer Stage 0 probe"
      })
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          sessionId: descriptor.sessionId,
          messageId: result.messageId,
          mode: result.mode,
          admittedAt: result.admittedAt
        },
        null,
        2
      )}\n`
    );
    return;
  }

  throw new Error(usage());
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
