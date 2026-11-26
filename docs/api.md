# Contrato HTTP v1

Base local `http://127.0.0.1:3000`. Las rutas de producto se montan bajo `/api/v1`. Las escrituras con datos requieren un objeto JSON y `Content-Type: application/json`. El límite de cuerpo es 32 KiB. Los UUID se devuelven en minúsculas y las fechas son ISO 8601 UTC, por ejemplo `2026-11-26T09:00:00.000Z`.

Envía `Authorization: Bearer <token>` en todas las rutas salvo salud, registro y login. El token es opaco. Un 204 tiene cuerpo vacío. Los demás resultados son JSON.

## Rutas

| Método y ruta | Datos | Respuesta |
| --- | --- | --- |
| `GET /health` | Sin sesión | 200 `{"status":"ok"}` si responde SQLite. |
| `POST /api/v1/auth/register` | `{username,password}` | 201 `{user,session}`. |
| `POST /api/v1/auth/login` | `{username,password}` | 200 `{user,session}`. |
| `POST /api/v1/auth/logout` | Bearer, sin cuerpo necesario | 204. |
| `GET /api/v1/users/me` | Bearer | 200 `{user}`. |
| `GET /api/v1/users` | `q` opcional, `limit` 1–50 | 200 `{users:[User]}`. |
| `GET /api/v1/chats` | `limit` 1–100, `offset` ≥ 0 | 200 `{chats:[Chat]}`. |
| `POST /api/v1/chats` | `{type,participantIds,title?}` | 201 `{chat}`; 200 si ya existe un directo para la pareja. |
| `GET /api/v1/chats/:chatId` | UUID de chat | 200 `{chat}`. |
| `GET /api/v1/chats/:chatId/messages` | `limit` 1–100 y `before` o `after` opcional | 200 `{messages:[Message],hasMore:Bool}`. |
| `POST /api/v1/chats/:chatId/messages` | `{content,clientMessageId?}` | 201 `{message}`; 200 si recupera un envío idéntico. |

## DTO

| Tipo | Campos |
| --- | --- |
| `User` | `id: UUID`, `username: string`, `createdAt: DateString`. |
| `Session` | `token: string`, `expiresAt: DateString`. |
| `Chat` | `id: UUID`, `type: "direct" o "group"`, `title: string o null`, `createdBy: UUID`, `createdAt: DateString`, `participants: [User]`, `lastMessage: Message o null`. |
| `Message` | `id: UUID`, `sequence: integer`, `chatId: UUID`, `senderId: UUID`, `content: string`, `sentAt: DateString`, `clientMessageId: UUID o null`. |

## Reglas de entrada

- El nombre de usuario se recorta. Admite 3–32 letras ASCII, números, puntos, guiones y guiones bajos. La unicidad y el login ignoran mayúsculas. La contraseña admite 8–128 caracteres Unicode válidos y conserva espacios.
- El buscador de usuarios recorta `q` y aplica una coincidencia literal parcial sin distinguir mayúsculas. Admite hasta 32 caracteres del mismo alfabeto. Si `q` falta o queda vacía, muestra usuarios ordenados por nombre. Excluye la cuenta activa. `limit` por defecto es 20.
- El chat directo requiere un único UUID ajeno. `title` debe omitirse o ser `null`. Los grupos requieren de 2 a 49 UUID ajenos y un título de 1–80 caracteres tras recortar. El creador se añade como miembro. Todos los UUID deben existir y los miembros no pueden repetirse. El listado de chats tiene `limit` 50 y `offset` 0 por defecto.
- Los mensajes se recortan a ambos lados y deben quedar entre 1 y 4000 caracteres. Se admiten saltos interiores. Los títulos y mensajes excluyen NUL y codificaciones Unicode inválidas. La clave `clientMessageId` puede omitirse o ser `null`. Si se envía, debe ser un UUID. Repetir la clave con el mismo contenido normalizado devuelve el mensaje original. Con diferente contenido devuelve 409. La clave es independiente por chat y autor.

## Cómo leer mensajes

1. **Abrir conversación:** `GET /api/v1/chats/<id>/messages?limit=50` devuelve la página más reciente. Los mensajes de la respuesta siempre aparecen en orden ascendente de `sequence`.
2. **Cargar historial:** si `hasMore` es `true`, usa la secuencia del primer mensaje como `before` en la petición siguiente. El límite es exclusivo. `before` empieza en 1.
3. **Consultar novedades:** usa como `after` la mayor secuencia ya vista y aplica las páginas sucesivas hasta que `hasMore` sea `false`. Si no tienes secuencia, `after=0` lee desde el principio. Las secuencias pueden tener huecos. Una página vacía es `{"messages":[],"hasMore":false}`.

El límite por defecto es 50. `before` y `after` son excluyentes entre sí. El sentido del cursor determina si `hasMore` se refiere a mensajes más antiguos o más nuevos.

## Errores

```json
{"error":{"code":"CHAT_NOT_FOUND","message":"No se encontró el chat."}}
```

| HTTP | Códigos |
| --- | --- |
| 400 | `INVALID_BODY`, `INVALID_JSON`, `INVALID_PATH`, `INVALID_INPUT`, `INVALID_CHAT_TYPE`, `INVALID_PARTICIPANTS`, `INVALID_TITLE`, `INVALID_CONTENT`, `INVALID_PAGINATION`. |
| 401 | `UNAUTHORIZED` para sesión ausente, caducada o revocada. `INVALID_CREDENTIALS` para credenciales incorrectas. |
| 403 | `LOCAL_HOST_REQUIRED` si la cabecera Host queda fuera de los nombres locales admitidos. |
| 404 | `CHAT_NOT_FOUND` para chat inexistente o inaccesible. `NOT_FOUND` para ruta desconocida. |
| 409 | `USERNAME_TAKEN`, `MESSAGE_CONFLICT`. |
| 413 | `BODY_TOO_LARGE`. |
| 415 | `UNSUPPORTED_ENCODING`. |
| 429 | `TOO_MANY_ATTEMPTS`, con `Retry-After` en segundos. |
| 500 | `INTERNAL_ERROR`. |

El código es el campo que el cliente debe usar para decidir su comportamiento. El texto está pensado para lectura humana.
