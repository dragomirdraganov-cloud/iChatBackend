# Diseño y operación local

## Componentes

| Archivo | Responsabilidad |
| --- | --- |
| `src/server.ts` | Lee puerto y ruta, abre SQLite, inicia la escucha en IPv4 loopback y cierra la conexión al recibir SIGINT o SIGTERM. |
| `src/app.ts` | Compone Express, comprueba la cabecera Host, limita cuerpos y peticiones de autenticación, monta módulos y traduce errores a JSON. La función `createApp` acepta la base de datos. |
| `src/database.ts` | Abre o crea el archivo, activa claves foráneas, aplica migraciones y configura WAL en disco. |
| `src/auth.ts` | Valida credenciales, consulta perfiles, emite y revoca sesiones, y fija la identidad que usan las rutas protegidas. |
| `src/chats.ts` | Crea y lista chats, aplica membresía, pagina el historial y guarda mensajes con deduplicación opcional. |
| `src/http.ts` | Contiene validadores comunes y la representación de errores públicos. |
| `tests/integration.test.ts` | Prueba una aplicación real en loopback con SQLite en memoria y en disco temporal. |
| `scripts/smoke.mjs` | Arranca el proceso compilado, comprueba persistencia al reiniciar y gestiona su limpieza. |

## Modelo SQLite

| Tabla | Datos e invariantes |
| --- | --- |
| `users` | UUID, nombre mostrado, clave en minúsculas única, hash versionado y fecha de creación. |
| `sessions` | SHA-256 del token como clave, usuario y vencimiento en milisegundos UTC. Al emitir una sesión se eliminan las expiradas. |
| `chats` | UUID, tipo, creador y fecha. Los grupos tienen título. Los directos tienen una clave única derivada de los UUID ordenados de la pareja. |
| `chat_members` | Relación entre chat y usuario, única por pareja. El creador se incorpora automáticamente. Los miembros se fijan al crear el chat. |
| `messages` | UUID, secuencia entera creciente, contenido, autor y fecha. La clave foránea compuesta exige que el autor sea miembro. Una clave de cliente opcional es única por chat y remitente. |

Las tablas son `STRICT`. Se usan consultas preparadas y parámetros para datos. El alta de usuario y su primera sesión se guardan en una transacción. Igual ocurre con el chat y sus miembros. `PRAGMA user_version` registra la versión del esquema. El arranque aplica la versión 1 bajo transacción y rechaza bases con una versión superior a la conocida. Para añadir una migración futura, conserva las versiones anteriores, incrementa el número, aplica solo los pasos pendientes y prueba reapertura y actualización desde una base anterior.

Los mensajes se ordenan por secuencia, un ID interno global que puede tener huecos. El último mensaje de un chat se obtiene de la misma tabla de mensajes. El listado de chats ordena por fecha del último mensaje o de creación y desempata por ID. Su paginación por offset está pensada para el volumen local. Cuando llega actividad nueva, una consulta posterior con offset puede mover algunas filas.

## Sesiones y acceso

- Las contraseñas se derivan con scrypt asíncrono, sal aleatoria de 16 bytes y formato `scrypt-v1`. La configuración usa N=32768, r=8 y p=3. El coste de scrypt es distinto al del formato de contraseña que usaba la app local.
- Un login correcto genera un token opaco independiente de 32 bytes y con expiración de siete días. Se entrega por HTTP solo al registrar o iniciar sesión. SQLite guarda su SHA-256. Logout revoca únicamente el token presentado y los demás dispositivos o clientes mantienen sus sesiones.
- Cada lectura o escritura de un chat comprueba membresía. El autor del mensaje se extrae de la sesión. Una lectura o escritura por alguien ajeno devuelve el mismo estado 404 que un chat inexistente.
- La API no registra contraseñas, tokens ni cuerpos de peticiones. Las respuestas marcan `Cache-Control: no-store` y los errores internos devuelven un mensaje genérico. El límite global de registro y login es de 20 POST por minuto por proceso. Una respuesta 429 incluye `Retry-After`.
- El servidor escucha en `127.0.0.1`. Acepta Host `127.0.0.1` o `localhost` con puerto opcional. Es HTTP local y no incorpora TLS, CORS, correo, OAuth ni servicios gestionados. La base contiene texto de mensajes y perfiles. Guarda sus archivos en una carpeta privada y usa datos de desarrollo.

## Operación

- El archivo de producción local por defecto se crea al primer arranque. Las variables de entorno se leen al arrancar. Para varios experimentos, usa rutas distintas y puertos distintos.
- Se configura WAL en disco. Mientras el proceso está activo pueden existir archivos `-wal` y `-shm`. Para una copia manual, cierra el servidor antes de copiar la base. Conserva una copia antes de ensayar migraciones con tus datos.
- Resuelve `EADDRINUSE` cambiando `ICHAT_PORT`. Si no puedes abrir SQLite, comprueba ruta y permisos de la carpeta y avisa si la base procede de una versión más nueva. Con Node 25.6, el aviso ExperimentalWarning de SQLite es esperado.
- Las dependencias instaladas, la salida compilada y el almacén local se excluyen mediante `.gitignore`. El lockfile permite repetir la instalación.

Referencias: [Express 5 y errores asíncronos](https://expressjs.com/en/guide/error-handling/), [node:sqlite](https://nodejs.org/api/sqlite.html), [scrypt y parámetros recomendados](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt).
