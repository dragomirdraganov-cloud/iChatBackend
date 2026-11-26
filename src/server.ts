import type { AddressInfo } from "node:net";
import { createApp } from "./app.js";
import { openDatabase } from "./database.js";

const host = "127.0.0.1";
const defaultPath = "data/ichat.sqlite";

function configuredPort(value: string | undefined): number {
  if (value === undefined) return 3000;
  if (!/^\d{1,5}$/.test(value) || Number(value) > 65535) {
    throw new Error("ICHAT_PORT debe ser un entero entre 0 y 65535.");
  }
  return Number(value);
}

function start(): void {
  const port = configuredPort(process.env.ICHAT_PORT);
  const databasePath = process.env.ICHAT_DB_PATH ?? defaultPath;
  if (!databasePath.trim()) throw new Error("ICHAT_DB_PATH no puede estar vacío.");
  process.umask(0o077);
  const db = openDatabase(databasePath);

  try {
    const server = createApp(db).listen(port, host);
    let stopping = false;

    server.once("listening", () => {
      const address = server.address() as AddressInfo;
      console.info(`iChatBackend escuchando en http://${host}:${address.port}`);
    });
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (!stopping) db.close();
      const code = error.code ?? error.name;
      console.error(`No se pudo abrir el servidor HTTP (${code}).`);
      process.exitCode = 1;
    });

    function shutdown() {
      if (stopping) return;
      stopping = true;
      server.close((error) => {
        db.close();
        if (error) process.exitCode = 1;
      });
    }

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (error) {
    db.close();
    throw error;
  }
}

try {
  start();
} catch (error) {
  console.error("No se pudo iniciar iChatBackend:", error instanceof Error ? error.message : "error desconocido");
  process.exitCode = 1;
}
