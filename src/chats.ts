import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Router } from "express";
import { getAuthenticatedUser, type PublicUser } from "./auth.js";
import { HttpError, integerQuery, objectBody, uuid } from "./http.js";

type ChatType = "direct" | "group";

type ChatRow = {
  id: string;
  type: ChatType;
  title: string | null;
  createdBy: string;
  createdAt: string;
  lastSequence: number | null;
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

type Chat = Omit<ChatRow, "lastSequence"> & {
  participants: PublicUser[];
  lastMessage: Message | null;
};

type NewChat = {
  type: ChatType;
  title: string | null;
  participantIds: string[];
};

const CHAT_SELECT = `
  SELECT
    c.id,
    c.type,
    c.title,
    c.created_by AS createdBy,
    c.created_at AS createdAt,
    latest.sequence AS lastSequence
  FROM chat_members AS member
  JOIN chats AS c ON c.id = member.chat_id
  LEFT JOIN messages AS latest ON latest.sequence = (
    SELECT m.sequence
    FROM messages AS m
    WHERE m.chat_id = c.id
    ORDER BY m.sequence DESC
    LIMIT 1
  )
`;

const MESSAGE_COLUMNS = `
  id,
  sequence,
  chat_id AS chatId,
  sender_id AS senderId,
  content,
  sent_at AS sentAt,
  client_message_id AS clientMessageId
`;

function missingChat(): HttpError {
  return new HttpError(404, "CHAT_NOT_FOUND", "No se encontró el chat.");
}

function missingParticipants(): HttpError {
  return new HttpError(
    400,
    "INVALID_PARTICIPANTS",
    "Indica participantes existentes, distintos entre sí y distintos de la cuenta actual.",
  );
}

function hasValidTextLength(value: string, maximum: number): boolean {
  // SQLite treats NUL as a terminator and UTF-8 replaces unpaired surrogates.
  return value.length > 0 && [...value].length <= maximum && !/[\u0000\uD800-\uDFFF]/u.test(value);
}

function parseNewChat(body: unknown, creatorId: string): NewChat {
  const { type, title, participantIds } = objectBody(body);
  if (type !== "direct" && type !== "group") {
    throw new HttpError(400, "INVALID_CHAT_TYPE", "El tipo debe ser direct o group.");
  }

  const minParticipants = type === "direct" ? 1 : 2;
  const maxParticipants = type === "direct" ? 1 : 49;
  if (
    !Array.isArray(participantIds) ||
    participantIds.length < minParticipants ||
    participantIds.length > maxParticipants
  ) {
    throw new HttpError(
      400,
      "INVALID_PARTICIPANTS",
      type === "direct"
        ? "Un chat directo requiere exactamente un participante adicional."
        : "Un grupo requiere entre 2 y 49 participantes adicionales.",
    );
  }

  const participants = participantIds.map((id: unknown) =>
    uuid(id, "participantIds"),
  );
  if (new Set(participants).size !== participants.length || participants.includes(creatorId)) {
    throw missingParticipants();
  }

  if (type === "direct") {
    if (title !== undefined && title !== null) {
      throw new HttpError(400, "INVALID_TITLE", "Un chat directo no admite título.");
    }
    return { type, title: null, participantIds: participants };
  }

  const trimmedTitle = typeof title === "string" ? title.trim() : "";
  if (!hasValidTextLength(trimmedTitle, 80)) {
    throw new HttpError(400, "INVALID_TITLE", "El título debe tener entre 1 y 80 caracteres Unicode válidos.");
  }
  return { type, title: trimmedTitle, participantIds: participants };
}

function readChatDetails(db: DatabaseSync, rows: ChatRow[]): Chat[] {
  if (rows.length === 0) return [];

  const chatIds = rows.map((row) => row.id);
  const members = db.prepare(`
    SELECT
      cm.chat_id AS chatId,
      u.id,
      u.username,
      u.created_at AS createdAt
    FROM chat_members AS cm
    JOIN users AS u ON u.id = cm.user_id
    WHERE cm.chat_id IN (${chatIds.map(() => "?").join(", ")})
    ORDER BY u.username_key, u.id
  `).all(...chatIds) as Array<PublicUser & { chatId: string }>;

  const participantsByChat = new Map<string, PublicUser[]>();
  for (const { chatId, ...user } of members) {
    const participants = participantsByChat.get(chatId);
    if (participants) {
      participants.push(user);
    } else {
      participantsByChat.set(chatId, [user]);
    }
  }

  const sequences = rows.flatMap(({ lastSequence }) => lastSequence === null ? [] : [lastSequence]);
  const lastMessages = sequences.length === 0
    ? []
    : db.prepare(`
        SELECT ${MESSAGE_COLUMNS}
        FROM messages
        WHERE sequence IN (${sequences.map(() => "?").join(", ")})
      `).all(...sequences) as Message[];
  const lastMessagesByChat = new Map(lastMessages.map((message) => [message.chatId, message]));

  return rows.map(({ lastSequence: _lastSequence, ...chat }) => ({
    ...chat,
    participants: participantsByChat.get(chat.id) ?? [],
    lastMessage: lastMessagesByChat.get(chat.id) ?? null,
  }));
}

function getChat(db: DatabaseSync, userId: string, chatId: string): Chat {
  const row = db.prepare(`
    ${CHAT_SELECT}
    WHERE member.user_id = ? AND c.id = ?
  `).get(userId, chatId) as ChatRow | undefined;
  if (!row) throw missingChat();
  return readChatDetails(db, [row])[0]!;
}

function requireMembership(db: DatabaseSync, userId: string, chatId: string): void {
  const member = db.prepare(
    "SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?",
  ).get(chatId, userId);
  if (!member) throw missingChat();
}

function createChat(
  db: DatabaseSync,
  creatorId: string,
  chat: NewChat,
): { id: string; created: boolean } {
  const memberIds = [creatorId, ...chat.participantIds];
  const directKey = chat.type === "direct" ? [...memberIds].sort().join(":") : null;

  db.exec("BEGIN IMMEDIATE");
  try {
    const users = db.prepare(`
      SELECT id FROM users
      WHERE id IN (${chat.participantIds.map(() => "?").join(", ")})
    `).all(...chat.participantIds);
    if (users.length !== chat.participantIds.length) throw missingParticipants();

    if (directKey !== null) {
      const existing = db.prepare("SELECT id FROM chats WHERE direct_key = ?")
        .get(directKey) as { id: string } | undefined;
      if (existing) {
        db.exec("COMMIT");
        return { id: existing.id, created: false };
      }
    }

    const id = randomUUID();
    db.prepare(`
      INSERT INTO chats (id, type, title, created_by, created_at, direct_key)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, chat.type, chat.title, creatorId, new Date().toISOString(), directKey);

    const insertMember = db.prepare("INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)");
    for (const memberId of memberIds) {
      insertMember.run(id, memberId);
    }

    db.exec("COMMIT");
    return { id, created: true };
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

export function createChatsRouter(db: DatabaseSync): Router {
  const router = Router();

  router.get("/", (req, res) => {
    const { id: userId } = getAuthenticatedUser(req);
    const limit = integerQuery(req.query.limit, "limit", 1, 100, 50);
    const offset = integerQuery(req.query.offset, "offset", 0, Number.MAX_SAFE_INTEGER, 0);
    const rows = db.prepare(`
      ${CHAT_SELECT}
      WHERE member.user_id = ?
      ORDER BY COALESCE(latest.sent_at, c.created_at) DESC, c.id DESC
      LIMIT ? OFFSET ?
    `).all(userId, limit, offset) as ChatRow[];
    res.json({ chats: readChatDetails(db, rows) });
  });

  router.post("/", (req, res) => {
    const { id: userId } = getAuthenticatedUser(req);
    const input = parseNewChat(req.body, userId);
    const { id, created } = createChat(db, userId, input);
    res.status(created ? 201 : 200).json({ chat: getChat(db, userId, id) });
  });

  router.get("/:chatId", (req, res) => {
    const { id: userId } = getAuthenticatedUser(req);
    const chatId = uuid(req.params.chatId, "chatId");
    res.json({ chat: getChat(db, userId, chatId) });
  });

  router.get("/:chatId/messages", (req, res) => {
    const { id: userId } = getAuthenticatedUser(req);
    const chatId = uuid(req.params.chatId, "chatId");
    requireMembership(db, userId, chatId);

    const { before, after } = req.query;
    if (before !== undefined && after !== undefined) {
      throw new HttpError(400, "INVALID_PAGINATION", "Usa solo uno de los parámetros before y after.");
    }

    const limit = integerQuery(req.query.limit, "limit", 1, 100, 50);
    const parameters: Array<string | number> = [chatId];
    let comparison = "";
    if (after !== undefined) {
      comparison = "AND sequence > ?";
      parameters.push(integerQuery(after, "after", 0, Number.MAX_SAFE_INTEGER, 0));
    } else if (before !== undefined) {
      comparison = "AND sequence < ?";
      parameters.push(integerQuery(before, "before", 1, Number.MAX_SAFE_INTEGER, 1));
    }
    parameters.push(limit + 1);

    const rows = db.prepare(`
      SELECT ${MESSAGE_COLUMNS}
      FROM messages
      WHERE chat_id = ? ${comparison}
      ORDER BY sequence ${after === undefined ? "DESC" : "ASC"}
      LIMIT ?
    `).all(...parameters) as Message[];
    const messages = rows.slice(0, limit);
    if (after === undefined) messages.reverse();
    res.json({ messages, hasMore: rows.length > limit });
  });

  router.post("/:chatId/messages", (req, res) => {
    const { id: userId } = getAuthenticatedUser(req);
    const chatId = uuid(req.params.chatId, "chatId");
    requireMembership(db, userId, chatId);

    const input = objectBody(req.body);
    const content = typeof input.content === "string" ? input.content.trim() : "";
    if (!hasValidTextLength(content, 4000)) {
      throw new HttpError(400, "INVALID_CONTENT", "El mensaje debe tener entre 1 y 4000 caracteres Unicode válidos.");
    }
    const clientMessageId = input.clientMessageId === undefined || input.clientMessageId === null
      ? null
      : uuid(input.clientMessageId, "clientMessageId");

    const message = db.prepare(`
      INSERT INTO messages (id, chat_id, sender_id, content, sent_at, client_message_id)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id, sender_id, client_message_id) DO NOTHING
      RETURNING ${MESSAGE_COLUMNS}
    `).get(randomUUID(), chatId, userId, content, new Date().toISOString(), clientMessageId) as
      Message | undefined;

    if (message) {
      res.status(201).json({ message });
      return;
    }

    const existing = db.prepare(`
      SELECT ${MESSAGE_COLUMNS}
      FROM messages
      WHERE chat_id = ? AND sender_id = ? AND client_message_id = ?
    `).get(chatId, userId, clientMessageId) as Message | undefined;
    if (!existing) throw new Error("Idempotent message lookup failed.");
    if (existing.content !== content) {
      throw new HttpError(409, "MESSAGE_CONFLICT", "La clave de envío ya corresponde a otro contenido.");
    }
    res.json({ message: existing });
  });

  return router;
}
