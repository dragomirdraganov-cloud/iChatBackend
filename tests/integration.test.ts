import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { randomUUID } from "node:crypto";

import { createApp } from "../src/app.js";
import { openDatabase } from "../src/database.js";

type User = { id: string; username: string; createdAt: string };
type Account = { user: User; session: { token: string; expiresAt: string } };
type Chat = {
  id: string;
  type: "direct" | "group";
  title: string | null;
  createdBy: string;
  createdAt: string;
  participants: User[];
  lastMessage: Message | null;
};
type Message = {
  id: string;
  sequence: number;
  chatId: string;
  senderId: string;
  content: string;
  sentAt: string;
  clientMessageId: string | null;
};
type MessagePage = { messages: Message[]; hasMore: boolean };
type ErrorBody = { error: { code: string; message: string } };
type ServerOptions = NonNullable<Parameters<typeof createApp>[1]>;
type RequestOptions = {
  method?: string;
  token?: string;
  json?: unknown;
  rawJson?: string;
  expectHeaders?: Record<string, RegExp>;
};
type Api = <T = unknown>(
  path: string,
  expectedStatus: number,
  options?: RequestOptions,
) => Promise<T>;

const password = "sample-passphrase-2026";

async function withHttpServer(
  run: (api: Api) => Promise<void>,
  configuration: { path?: string; options?: ServerOptions } = {},
): Promise<void> {
  const db = openDatabase(configuration.path ?? ":memory:");
  try {
    const server = createApp(db, configuration.options).listen(0, "127.0.0.1");

    try {
      await once(server, "listening");
      const { port } = server.address() as AddressInfo;

      const api: Api = async <T>(path: string, expectedStatus: number, options: RequestOptions = {}) => {
        const headers = new Headers();
        if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
        let body: string | undefined;
        if (options.rawJson !== undefined) body = options.rawJson;
        else if (options.json !== undefined) body = JSON.stringify(options.json);
        if (body !== undefined) headers.set("Content-Type", "application/json");

        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: options.method,
          headers,
          body,
          signal: AbortSignal.timeout(10_000),
        });
        const payload = await response.text();
        assert.equal(
          response.status,
          expectedStatus,
          `${options.method ?? "GET"} ${path} returned unexpected status`,
        );

        for (const [name, pattern] of Object.entries(options.expectHeaders ?? {})) {
          assert.match(response.headers.get(name) ?? "", pattern);
        }
        if (expectedStatus === 204) {
          assert.equal(payload, "");
          return undefined as T;
        }
        assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/);
        return JSON.parse(payload) as T;
      };

      await run(api);
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
      }
    }
  } finally {
    db.close();
  }
}

async function register(api: Api, username: string): Promise<Account> {
  return api<Account>("/api/v1/auth/register", 201, {
    method: "POST",
    json: { username, password },
  });
}

async function direct(api: Api, actor: Account, participant: Account): Promise<Chat> {
  const { chat } = await api<{ chat: Chat }>("/api/v1/chats", 201, {
    method: "POST",
    token: actor.session.token,
    json: { type: "direct", participantIds: [participant.user.id] },
  });
  return chat;
}

function history(chatId: string): string {
  return `/api/v1/chats/${chatId}/messages`;
}

test("health, registro, búsqueda, perfil y revocación de una sesión", async () => {
  await withHttpServer(async (api) => {
    assert.deepEqual(await api("/health", 200), { status: "ok" });

    const ana = await register(api, "Ana");
    const bea = await register(api, "Beatriz");
    assert.deepEqual(Object.keys(ana.user).sort(), ["createdAt", "id", "username"]);
    assert.equal(ana.user.username, "Ana");
    assert.ok(Number.isFinite(Date.parse(ana.user.createdAt)));
    assert.ok(ana.session.token.length > 0);

    const duplicate = await api<ErrorBody>("/api/v1/auth/register", 409, {
      method: "POST",
      json: { username: "aNA", password },
    });
    assert.equal(duplicate.error.code, "USERNAME_TAKEN");

    const invalid = await api<ErrorBody>("/api/v1/auth/login", 401, {
      method: "POST",
      json: { username: "Ana", password: "another-valid-length-password" },
    });
    assert.equal(invalid.error.code, "INVALID_CREDENTIALS");

    await api("/api/v1/users/me", 401);
    assert.deepEqual(
      await api("/api/v1/users/me", 200, { token: ana.session.token }),
      { user: ana.user },
    );
    assert.deepEqual(
      await api("/api/v1/users?q=bEA&limit=1", 200, { token: ana.session.token }),
      { users: [bea.user] },
    );
    assert.deepEqual(
      await api("/api/v1/users?q=aNA", 200, { token: ana.session.token }),
      { users: [] },
    );

    const login = await api<Account>("/api/v1/auth/login", 200, {
      method: "POST",
      json: { username: "aNA", password },
    });
    assert.deepEqual(login.user, ana.user);
    assert.notEqual(login.session.token, ana.session.token);
    await api("/api/v1/auth/logout", 204, { method: "POST", token: login.session.token });
    await api("/api/v1/users/me", 401, { token: login.session.token });
    await api("/api/v1/users/me", 200, { token: ana.session.token });
  });
});

test("la sesión deja de ser válida al alcanzar su vencimiento", async () => {
  let now = Date.UTC(2026, 10, 26);
  await withHttpServer(async (api) => {
    const account = await register(api, "Paco");
    assert.equal(Date.parse(account.session.expiresAt), now + 1000);
    now += 999;
    await api("/api/v1/users/me", 200, { token: account.session.token });
    now += 1;
    const result = await api<ErrorBody>("/api/v1/users/me", 401, { token: account.session.token });
    assert.equal(result.error.code, "UNAUTHORIZED");
  }, { options: { now: () => now, sessionTtlMs: 1000 } });
});

test("validación de entradas HTTP sin crear registros parciales", async () => {
  await withHttpServer(async (api) => {
    const malformed = await api<ErrorBody>("/api/v1/auth/register", 400, {
      method: "POST",
      rawJson: '{"username":',
    });
    assert.equal(typeof malformed.error.code, "string");
    await api("/api/v1/auth/register", 400, {
      method: "POST",
      json: { username: "x", password },
    });
    await api("/api/v1/auth/register", 400, {
      method: "POST",
      json: { username: "Alice", password: "small" },
    });
    const ana = await register(api, "Alice");
    const bea = await register(api, "Beatriz");
    const token = ana.session.token;
    for (const json of [
      { type: "direct", participantIds: [ana.user.id] },
      { type: "direct", participantIds: [randomUUID()] },
      { type: "group", title: "Equipo", participantIds: [bea.user.id, bea.user.id] },
    ]) {
      const response = await api<ErrorBody>("/api/v1/chats", 400, { method: "POST", json, token });
      assert.equal(response.error.code, "INVALID_PARTICIPANTS");
    }
    assert.deepEqual(await api("/api/v1/chats", 200, { token }), { chats: [] });

    const invalidPath = await api<ErrorBody>("/api/v1/chats/%FF", 400, { token });
    assert.equal(invalidPath.error.code, "INVALID_PATH");

    const chat = await direct(api, ana, bea);
    for (const content of ["  \n ", "\u0000Texto", "Fragmento\uD800"]) {
      const error = await api<ErrorBody>(history(chat.id), 400, {
        method: "POST",
        json: { content },
        token,
      });
      assert.equal(error.error.code, "INVALID_CONTENT");
    }
    await api(`${history(chat.id)}?before=2&after=0`, 400, { token });
    await api(`${history(chat.id)}?limit=0`, 400, { token });
    assert.deepEqual(await api(history(chat.id), 200, { token }), { messages: [], hasMore: false });
  });
});

test("el límite de intentos de autenticación devuelve 429 y Retry-After", async () => {
  await withHttpServer(async (api) => {
    const options = { method: "POST", json: { username: "x", password } };
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const path = attempt % 2 === 0 ? "/api/v1/auth/register" : "/api/v1/auth/login";
      await api(path, 400, options);
    }

    const limited = await api<ErrorBody>("/api/v1/auth/login", 429, {
      ...options,
      expectHeaders: { "Retry-After": /^[1-9]\d*$/ },
    });
    assert.equal(limited.error.code, "TOO_MANY_ATTEMPTS");
    await api("/health", 200);
  });
});

test("un directo por pareja, grupos y acceso restringido a los miembros", async () => {
  await withHttpServer(async (api) => {
    const ana = await register(api, "Ana");
    const bea = await register(api, "Bea");
    const carla = await register(api, "Carla");
    const diana = await register(api, "Diana");

    const chat = await direct(api, ana, bea);
    assert.equal(chat.type, "direct");
    assert.equal(chat.title, null);
    assert.equal(chat.createdBy, ana.user.id);
    assert.equal(chat.lastMessage, null);
    assert.deepEqual(new Set(chat.participants.map(({ id }) => id)), new Set([ana.user.id, bea.user.id]));
    const existing = await api<{ chat: Chat }>("/api/v1/chats", 200, {
      method: "POST",
      token: bea.session.token,
      json: { type: "direct", participantIds: [ana.user.id] },
    });
    assert.equal(existing.chat.id, chat.id);
    assert.deepEqual(await api(`/api/v1/chats/${chat.id}`, 200, { token: bea.session.token }), { chat });

    const { chat: group } = await api<{ chat: Chat }>("/api/v1/chats", 201, {
      method: "POST",
      token: ana.session.token,
      json: { type: "group", title: "Equipo", participantIds: [bea.user.id, carla.user.id] },
    });
    assert.equal(group.type, "group");
    assert.equal(group.title, "Equipo");
    assert.deepEqual(
      new Set(group.participants.map(({ id }) => id)),
      new Set([ana.user.id, bea.user.id, carla.user.id]),
    );
    const carlaChats = await api<{ chats: Chat[] }>("/api/v1/chats", 200, { token: carla.session.token });
    assert.deepEqual(carlaChats.chats.map(({ id }) => id), [group.id]);
    assert.deepEqual(await api("/api/v1/chats", 200, { token: diana.session.token }), { chats: [] });

    for (const [target, outsider] of [[chat, carla], [group, diana]] as const) {
      for (const path of [`/api/v1/chats/${target.id}`, history(target.id)]) {
        const error = await api<ErrorBody>(path, 404, { token: outsider.session.token });
        assert.equal(error.error.code, "CHAT_NOT_FOUND");
      }
      const error = await api<ErrorBody>(history(target.id), 404, {
        method: "POST",
        token: outsider.session.token,
        json: { content: "Mensaje fuera de mis conversaciones" },
      });
      assert.equal(error.error.code, "CHAT_NOT_FOUND");
    }

    const response = await api<{ message: Message }>(history(group.id), 201, {
      method: "POST",
      token: carla.session.token,
      json: { content: "Hola, equipo 👋" },
    });
    assert.equal(response.message.senderId, carla.user.id);
    assert.equal(response.message.content, "Hola, equipo 👋");
    const page = await api<MessagePage>(history(group.id), 200, { token: bea.session.token });
    assert.deepEqual(page.messages, [response.message]);
    assert.deepEqual(await api(history(chat.id), 200, { token: bea.session.token }), {
      messages: [],
      hasMore: false,
    });
  });
});

test("envío idempotente, último mensaje y paginación en ambos sentidos", async () => {
  await withHttpServer(async (api) => {
    const ana = await register(api, "Ana");
    const bea = await register(api, "Bea");
    const chat = await direct(api, ana, bea);
    const path = history(chat.id);
    const clientMessageId = randomUUID();

    const { message: first } = await api<{ message: Message }>(path, 201, {
      method: "POST",
      token: ana.session.token,
      json: { content: "Uno", clientMessageId },
    });
    assert.equal(first.senderId, ana.user.id);
    assert.equal(first.chatId, chat.id);
    assert.equal(first.clientMessageId, clientMessageId);
    assert.ok(Number.isFinite(Date.parse(first.sentAt)));
    assert.deepEqual(
      await api(path, 200, {
        method: "POST",
        token: ana.session.token,
        json: { content: "Uno", clientMessageId },
      }),
      { message: first },
    );
    const conflict = await api<ErrorBody>(path, 409, {
      method: "POST",
      token: ana.session.token,
      json: { content: "Distinto", clientMessageId },
    });
    assert.equal(conflict.error.code, "MESSAGE_CONFLICT");

    const messages = [first];
    for (const [account, content] of [[bea, "Dos"], [ana, "Tres"], [bea, "Cuatro"]] as const) {
      const { message } = await api<{ message: Message }>(path, 201, {
        method: "POST",
        token: account.session.token,
        json: { content },
      });
      messages.push(message);
    }
    const [one, two, three, four] = messages;
    assert.ok(one.sequence < two.sequence && two.sequence < three.sequence && three.sequence < four.sequence);

    const token = bea.session.token;
    assert.deepEqual(await api(`${path}?limit=2`, 200, { token }), {
      messages: [three, four],
      hasMore: true,
    });
    assert.deepEqual(await api(`${path}?before=${three.sequence}&limit=2`, 200, { token }), {
      messages: [one, two],
      hasMore: false,
    });
    assert.deepEqual(await api(`${path}?after=${one.sequence}&limit=2`, 200, { token }), {
      messages: [two, three],
      hasMore: true,
    });
    assert.deepEqual(await api(`${path}?after=${four.sequence}`, 200, { token }), {
      messages: [],
      hasMore: false,
    });
    const list = await api<{ chats: Chat[] }>("/api/v1/chats", 200, { token });
    assert.deepEqual(list.chats.map(({ lastMessage }) => lastMessage), [four]);
  });
});

test("las cuentas, sesiones y mensajes persisten al reabrir SQLite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ichat-backend-integration-"));
  const path = join(directory, "integration.sqlite");
  let fixture: { account: Account; chatId: string; message: Message } | undefined;
  try {
    await withHttpServer(async (api) => {
      const ana = await register(api, "Ana");
      const bea = await register(api, "Bea");
      const chat = await direct(api, ana, bea);
      const { message } = await api<{ message: Message }>(history(chat.id), 201, {
        method: "POST",
        token: ana.session.token,
        json: { content: "Persiste al reiniciar" },
      });
      fixture = { account: bea, chatId: chat.id, message };
    }, { path });

    assert.ok(fixture);
    const { account, chatId, message } = fixture;
    await withHttpServer(async (api) => {
      const token = account.session.token;
      assert.deepEqual(await api("/api/v1/users/me", 200, { token }), { user: account.user });
      const list = await api<{ chats: Chat[] }>("/api/v1/chats", 200, { token });
      assert.deepEqual(list.chats.map(({ id }) => id), [chatId]);
      assert.deepEqual(await api(history(chatId), 200, { token }), { messages: [message], hasMore: false });
    }, { path });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
