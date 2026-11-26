import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const schemaVersion = 1;

const initialSchema = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY NOT NULL,
    username TEXT NOT NULL,
    username_key TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX sessions_by_expiration ON sessions(expires_at);
  CREATE INDEX sessions_by_user ON sessions(user_id);

  CREATE TABLE chats (
    id TEXT PRIMARY KEY NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('direct', 'group')),
    title TEXT,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    direct_key TEXT UNIQUE,
    CHECK ((type = 'direct' AND direct_key IS NOT NULL AND title IS NULL) OR
           (type = 'group' AND direct_key IS NULL AND title IS NOT NULL))
  ) STRICT;

  CREATE TABLE chat_members (
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    PRIMARY KEY (chat_id, user_id)
  ) STRICT;
  CREATE INDEX chat_members_by_user ON chat_members(user_id, chat_id);

  CREATE TABLE messages (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    chat_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 4000),
    sent_at TEXT NOT NULL,
    client_message_id TEXT,
    FOREIGN KEY (chat_id, sender_id) REFERENCES chat_members(chat_id, user_id) ON DELETE CASCADE,
    UNIQUE (chat_id, sender_id, client_message_id)
  ) STRICT;
  CREATE INDEX messages_by_chat_and_sequence ON messages(chat_id, sequence);
`;

function migrate(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const state = db.prepare("PRAGMA user_version").get();
    const version = Number(state?.user_version);
    if (!Number.isInteger(version) || version < 0 || version > schemaVersion) {
      throw new Error(`Versión de SQLite no compatible: ${version}.`);
    }
    if (version === 0) {
      db.exec(initialSchema);
      db.exec("PRAGMA user_version = 1");
    }
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

export function openDatabase(path: string): DatabaseSync {
  const location = path === ":memory:" ? path : resolve(path);
  if (location !== ":memory:") mkdirSync(dirname(location), { recursive: true, mode: 0o700 });

  const db = new DatabaseSync(location, { enableForeignKeyConstraints: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    if (location !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
