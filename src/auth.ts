import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Router, type Request, type RequestHandler } from "express";
import { HttpError, integerQuery, objectBody } from "./http.js";

export type PublicUser = {
  id: string;
  username: string;
  createdAt: string;
};

type UserRow = {
  id: string;
  username: string;
  created_at: string;
};

type CredentialRow = UserRow & { password_hash: string };

type SessionIdentity = {
  user: PublicUser;
  tokenHash: string;
};

type AuthOptions = {
  sessionTtlMs?: number;
  now?: () => number;
};

const authenticatedRequests = new WeakMap<Request, SessionIdentity>();
const defaultSessionTtlMs = 7 * 24 * 60 * 60 * 1000;
const usernamePattern = /^[a-zA-Z0-9_.-]{3,32}$/;
const searchPattern = /^[a-zA-Z0-9_.-]{0,32}$/;
const passwordHashPattern = /^scrypt-v1\$([a-f0-9]{32})\$([a-f0-9]{64})$/;
const scryptParameters = { N: 2 ** 15, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const missingCredentialSalt = Buffer.alloc(16);
const missingCredentialDigest = Buffer.alloc(32);

function unauthenticated(): HttpError {
  return new HttpError(401, "UNAUTHORIZED", "Se requiere una sesión válida.");
}

export function getAuthenticatedUser(req: Request): PublicUser {
  const identity = authenticatedRequests.get(req);
  if (!identity) throw unauthenticated();
  return identity.user;
}

function publicUser(row: UserRow): PublicUser {
  return { id: row.id, username: row.username, createdAt: row.created_at };
}

function credentials(input: unknown) {
  const body = objectBody(input);
  const username = typeof body.username === "string" ? body.username.trim() : "";
  if (!usernamePattern.test(username)) {
    throw new HttpError(400, "INVALID_INPUT", "El usuario debe tener entre 3 y 32 caracteres: letras ASCII, números, puntos, guiones o guiones bajos.");
  }

  const password = body.password;
  if (typeof password !== "string" || password.length < 8 || password.length > 256) {
    throw new HttpError(400, "INVALID_INPUT", "La contraseña debe tener entre 8 y 128 caracteres.");
  }
  const passwordLength = Array.from(password).length;
  if (passwordLength < 8 || passwordLength > 128 || Buffer.from(password).toString("utf8") !== password) {
    throw new HttpError(400, "INVALID_INPUT", "La contraseña debe tener entre 8 y 128 caracteres Unicode válidos.");
  }
  return { username, usernameKey: username.toLowerCase(), password };
}

function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, scryptParameters, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const digest = await derivePassword(password, salt);
  return `scrypt-v1$${salt.toString("hex")}$${digest.toString("hex")}`;
}

async function checkPassword(password: string, hash: string | undefined): Promise<boolean> {
  const parts = hash?.match(passwordHashPattern);
  const salt = parts ? Buffer.from(parts[1], "hex") : missingCredentialSalt;
  const expected = parts ? Buffer.from(parts[2], "hex") : missingCredentialDigest;
  const actual = await derivePassword(password, salt);
  return timingSafeEqual(actual, expected) && Boolean(parts);
}

function hashSession(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function searchInput(req: Request) {
  const { q, limit } = req.query;
  const query = q === undefined ? "" : typeof q === "string" ? q.trim() : null;
  if (query === null || !searchPattern.test(query)) {
    throw new HttpError(400, "INVALID_INPUT", "La búsqueda admite hasta 32 caracteres de nombre de usuario.");
  }
  return { query: query.toLowerCase(), limit: integerQuery(limit, "limit", 1, 50, 20) };
}

export function createAuth(db: DatabaseSync, options: AuthOptions = {}) {
  const { sessionTtlMs = defaultSessionTtlMs, now = Date.now } = options;
  if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 1) {
    throw new RangeError("Session TTL must be a positive integer in milliseconds.");
  }

  const insertUser = db.prepare(`
    INSERT INTO users (id, username, username_key, password_hash, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(username_key) DO NOTHING
  `);
  const findCredentials = db.prepare(`
    SELECT id, username, created_at, password_hash FROM users WHERE username_key = ?
  `);
  const findSession = db.prepare(`
    SELECT users.id, users.username, users.created_at
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `);
  const addSession = db.prepare(`
    INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)
  `);
  const removeSession = db.prepare("DELETE FROM sessions WHERE token_hash = ?");
  const removeExpiredSessions = db.prepare("DELETE FROM sessions WHERE expires_at <= ?");
  const searchUsers = db.prepare(`
    SELECT id, username, created_at FROM users
    WHERE id != ? AND instr(username_key, ?) > 0
    ORDER BY username_key
    LIMIT ?
  `);

  function issueSession(userId: string, issuedAt: number) {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = issuedAt + sessionTtlMs;
    const expiration = new Date(expiresAt).toISOString();
    removeExpiredSessions.run(issuedAt);
    addSession.run(hashSession(token), userId, expiresAt);
    return { token, expiresAt: expiration };
  }

  const requireSession: RequestHandler = (req, _res, next) => {
    const token = req.get("authorization")?.match(/^Bearer ([a-zA-Z0-9_-]{43})$/i)?.[1];
    if (token) {
      const tokenHash = hashSession(token);
      const user = findSession.get(tokenHash, now()) as UserRow | undefined;
      if (user) {
        authenticatedRequests.set(req, { user: publicUser(user), tokenHash });
        next();
        return;
      }
    }
    next(unauthenticated());
  };

  const router = Router();

  router.post("/register", async (req, res) => {
    const input = credentials(req.body);
    const passwordHash = await hashPassword(input.password);
    const createdAt = now();
    const user = { id: randomUUID(), username: input.username, createdAt: new Date(createdAt).toISOString() };

    db.exec("BEGIN IMMEDIATE");
    let session: ReturnType<typeof issueSession>;
    try {
      const result = insertUser.run(user.id, user.username, input.usernameKey, passwordHash, user.createdAt);
      if (!result.changes) {
        throw new HttpError(409, "USERNAME_TAKEN", "Ese nombre de usuario ya está registrado.");
      }
      session = issueSession(user.id, createdAt);
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }

    res.status(201).json({ user, session });
  });

  router.post("/login", async (req, res) => {
    const input = credentials(req.body);
    const row = findCredentials.get(input.usernameKey) as CredentialRow | undefined;
    const isValid = await checkPassword(input.password, row?.password_hash);
    if (!row || !isValid) {
      throw new HttpError(401, "INVALID_CREDENTIALS", "El usuario o la contraseña no son correctos.");
    }
    res.json({ user: publicUser(row), session: issueSession(row.id, now()) });
  });

  router.post("/logout", requireSession, (req, res) => {
    const identity = authenticatedRequests.get(req);
    if (!identity) throw unauthenticated();
    removeSession.run(identity.tokenHash);
    res.status(204).end();
  });

  const usersRouter = Router();
  usersRouter.get("/me", (req, res) => {
    res.json({ user: getAuthenticatedUser(req) });
  });
  usersRouter.get("/", (req, res) => {
    const user = getAuthenticatedUser(req);
    const { limit, query } = searchInput(req);
    const rows = searchUsers.all(user.id, query, limit) as UserRow[];
    res.json({ users: rows.map(publicUser) });
  });

  return { router, usersRouter, requireSession };
}
