import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const serverFile = fileURLToPath(new URL("../dist/server.js", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "ichat-smoke-"));
const databasePath = join(directory, "chat.sqlite");
const password = randomUUID();
let running;

function launch() {
  const child = spawn(process.execPath, [serverFile], {
    env: { ...process.env, ICHAT_PORT: "0", ICHAT_DB_PATH: databasePath },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", (error) => resolve({ error }));
  });
  const lines = createInterface({ input: child.stdout });
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("El servidor no arrancó en 8 segundos.")), 8000);
    void exited.then(({ code, error }) => {
      clearTimeout(timeout);
      reject(error ?? new Error(`El servidor salió antes de estar listo (código ${code}).`));
    });
    lines.on("line", (line) => {
      const match = line.match(/^iChatBackend escuchando en (http:\/\/127\.0\.0\.1:\d+)$/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
  });
  return { child, exited, ready };
}

async function stop({ child, exited }) {
  child.kill("SIGTERM");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const result = await exited;
    assert.equal(result.code, 0, "El servidor debe cerrar limpiamente");
  } finally {
    clearTimeout(timeout);
  }
}

async function request(base, method, path, status, { body, token } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, status, `${method} ${path}`);
  return status === 204 ? undefined : response.json();
}

try {
  running = launch();
  let base = await running.ready;
  assert.deepEqual(await request(base, "GET", "/health", 200), { status: "ok" });

  const a = await request(base, "POST", "/api/v1/auth/register", 201, { body: { username: "ana", password } });
  const b = await request(base, "POST", "/api/v1/auth/register", 201, { body: { username: "paco", password } });
  const { chat } = await request(base, "POST", "/api/v1/chats", 201, {
    token: a.session.token,
    body: { type: "direct", participantIds: [b.user.id] },
  });

  const path = `/api/v1/chats/${chat.id}/messages`;
  const { message } = await request(base, "POST", path, 201, {
    token: a.session.token,
    body: { content: "Hola desde el proceso compilado", clientMessageId: randomUUID() },
  });
  assert.equal(message.senderId, a.user.id);
  assert.deepEqual((await request(base, "GET", path, 200, { token: b.session.token })).messages, [message]);

  const first = running;
  running = undefined;
  await stop(first);

  running = launch();
  base = await running.ready;
  assert.deepEqual((await request(base, "GET", path, 200, { token: b.session.token })).messages, [message]);
  const { chats } = await request(base, "GET", "/api/v1/chats", 200, { token: b.session.token });
  assert.equal(chats[0].lastMessage.id, message.id);
  await request(base, "POST", "/api/v1/auth/logout", 204, { token: b.session.token });
  await request(base, "GET", path, 401, { token: b.session.token });

  console.log("Smoke OK: alta, chat, envío, lectura del destinatario, reinicio con persistencia y revocación.");
} finally {
  try {
    if (running) await stop(running);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
