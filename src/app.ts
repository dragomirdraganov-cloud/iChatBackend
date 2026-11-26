import express from "express";
import type { ErrorRequestHandler, RequestHandler } from "express";
import type { DatabaseSync } from "node:sqlite";
import { createAuth } from "./auth.js";
import { createChatsRouter } from "./chats.js";
import { HttpError } from "./http.js";

type AppOptions = Parameters<typeof createAuth>[1];

const authWindowMs = 60_000;
const authLimit = 20;

function limitAuthAttempts(): RequestHandler {
  let windowEndsAt = 0;
  let attempts = 0;

  return (request, response, next) => {
    if (request.method !== "POST") return next();
    const now = Date.now();
    if (now >= windowEndsAt) {
      windowEndsAt = now + authWindowMs;
      attempts = 0;
    }

    if (attempts >= authLimit) {
      response.set("Retry-After", String(Math.ceil((windowEndsAt - now) / 1000)));
      return next(new HttpError(429, "TOO_MANY_ATTEMPTS", "Espera antes de volver a intentarlo."));
    }
    attempts += 1;
    next();
  };
}

const handleError: ErrorRequestHandler = (error: unknown, request, response, next) => {
  if (response.headersSent) return next(error);

  if (error instanceof HttpError) {
    if (error.status === 401) response.set("WWW-Authenticate", 'Bearer realm="iChat"');
    response.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }

  if (error instanceof URIError && (error as { status?: number }).status === 400) {
    response.status(400).json({ error: { code: "INVALID_PATH", message: "La ruta no está codificada correctamente." } });
    return;
  }

  const type = (error as { type?: unknown } | null)?.type;
  if (type === "entity.parse.failed") {
    response.status(400).json({ error: { code: "INVALID_JSON", message: "El JSON no es válido." } });
    return;
  }
  if (type === "entity.too.large") {
    response.status(413).json({ error: { code: "BODY_TOO_LARGE", message: "El cuerpo supera 32 KiB." } });
    return;
  }
  if (type === "encoding.unsupported" || type === "charset.unsupported") {
    response.status(415).json({ error: { code: "UNSUPPORTED_ENCODING", message: "Se admite JSON UTF-8 sin compresión." } });
    return;
  }

  console.error("request_failed", { method: request.method, type: error instanceof Error ? error.name : "Unknown" });
  response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "No se pudo completar la operación." } });
};

export function createApp(db: DatabaseSync, options?: AppOptions) {
  const app = express();
  const auth = createAuth(db, options);
  const authLimiter = limitAuthAttempts();

  app.disable("x-powered-by");
  app.set("query parser", "simple");
  app.use((request, response, next) => {
    response.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    if (!/^(?:localhost|127\.0\.0\.1)(?::[0-9]{1,5})?$/i.test(request.get("Host") ?? "")) {
      return next(new HttpError(403, "LOCAL_HOST_REQUIRED", "Usa 127.0.0.1 o localhost."));
    }
    next();
  });
  app.use(express.json({ limit: "32kb", inflate: false }));

  app.get("/health", (_request, response) => {
    db.prepare("SELECT 1").get();
    response.json({ status: "ok" });
  });
  app.use(["/api/v1/auth/register", "/api/v1/auth/login"], authLimiter);
  app.use("/api/v1/auth", auth.router);
  app.use("/api/v1/users", auth.requireSession, auth.usersRouter);
  app.use("/api/v1/chats", auth.requireSession, createChatsRouter(db));
  app.use((_request, _response, next) => {
    next(new HttpError(404, "NOT_FOUND", "Ruta no encontrada."));
  });
  app.use(handleError);
  return app;
}
