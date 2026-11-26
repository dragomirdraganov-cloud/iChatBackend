# Validación de iChatBackend

Validación final: 26 de noviembre de 2026. macOS, Node.js 25.6.0 y npm 11.8.0. El lockfile instaló Express 5.3.0, TypeScript 5.9.3 y tsx 4.23.15.

## Resultados

| Comando o comprobación | Resultado |
| --- | --- |
| `npm ci --no-fund` | Instalación desde el lockfile correcta. npm informó de 81 paquetes instalados y 0 vulnerabilidades conocidas en su auditoría. |
| `npm run check` | Código y pruebas pasaron la comprobación de tipos. |
| `npm test` | 7 pruebas por HTTP real, 7 correctas, 0 fallos y 0 omitidas. |
| `npm run build` | Compilación a `dist/` correcta. |
| `npm run test:smoke` | El binario compilado arrancó dos veces. Se registraron dos cuentas, se guardó un mensaje y el destinatario lo recuperó antes y después del reinicio. Se revocó una sesión y la petición posterior devolvió 401. Ambos procesos cerraron limpiamente. |
| Revisión independiente | Se revisaron autorización, consultas, validación, persistencia y limpieza del proceso. Se corrigió un caso de NUL o Unicode inválido que podía fallar al guardar y otro de rutas mal codificadas que producían un error interno. Ambos quedaron cubiertos. |
| Concurrencia puntual | Una comprobación adicional hizo dos creaciones simultáneas del mismo directo y cuatro envíos con la misma clave. Se obtuvo un UUID de chat y un UUID de mensaje. |

Node 25.6.0 muestra `ExperimentalWarning` para `node:sqlite`. El aviso no impidió ejecutar la suite ni el servidor compilado.

## Cobertura de la suite HTTP

1. Salud, registro, búsqueda, perfil, login y revocación de un solo token.
2. Frontera exacta de vencimiento de una sesión usando un reloj inyectado.
3. JSON e inputs inválidos, incluidos rechazo de texto no representable y persistencia de emoji válido.
4. Límite global de registro y login, cabecera `Retry-After` y salud aún accesible.
5. Un directo por pareja, grupos, miembros y rechazo de acceso por usuarios ajenos.
6. Idempotencia de envío, último mensaje, orden y paginación hacia atrás y hacia delante.
7. Reapertura de SQLite para comprobar cuentas, sesiones y mensajes persistidos.

Las pruebas abren puertos aleatorios en `127.0.0.1`, se cierran al final y usan SQLite en memoria o un directorio temporal. El smoke prueba además el proceso de producción compilado. Ninguna de las pruebas usa `data/ichat.sqlite`.

## Prueba manual

Los ejemplos usan `curl` y `jq`. Ejecuta `npm ci` y `npm run build` antes de comenzar. En una terminal de esta carpeta, arranca una base de prueba separada:

```sh
TEST_DIR=$(mktemp -d)
ICHAT_PORT=3100 ICHAT_DB_PATH="$TEST_DIR/ichat.sqlite" npm start
```

En otra terminal, crea dos cuentas de ejemplo. Las variables guardan sus token de sesión hasta que cierres la terminal.

```sh
BASE=http://127.0.0.1:3100
API="$BASE/api/v1"

curl -fsS "$BASE/health"

ANA=$(curl -fsS "$API/auth/register" \
  -H 'Content-Type: application/json' \
  --data '{"username":"ana","password":"prueba-local-ana-2026"}')
PACO=$(curl -fsS "$API/auth/register" \
  -H 'Content-Type: application/json' \
  --data '{"username":"paco","password":"prueba-local-paco-2026"}')

ANA_TOKEN=$(printf '%s' "$ANA" | jq -er '.session.token')
PACO_TOKEN=$(printf '%s' "$PACO" | jq -er '.session.token')
PACO_ID=$(printf '%s' "$PACO" | jq -er '.user.id')

curl -fsS "$API/users?q=pa" -H "Authorization: Bearer $ANA_TOKEN" | jq

CHAT=$(curl -fsS "$API/chats" \
  -H "Authorization: Bearer $ANA_TOKEN" \
  -H 'Content-Type: application/json' \
  --data "$(jq -nc --arg id "$PACO_ID" '{type:"direct",participantIds:[$id]}')")
CHAT_ID=$(printf '%s' "$CHAT" | jq -er '.chat.id')

curl -fsS "$API/chats/$CHAT_ID/messages" \
  -H "Authorization: Bearer $ANA_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"content":"Hola Paco","clientMessageId":"7c1a97fe-e148-4104-80de-28ea192ea7d0"}' | jq

curl -fsS "$API/chats/$CHAT_ID/messages" \
  -H "Authorization: Bearer $PACO_TOKEN" | jq
```

El historial debe contener un mensaje con contenido `Hola Paco`. En la primera terminal pulsa **Ctrl+C** y repite el comando de arranque usando la misma variable `TEST_DIR`. Vuelve a ejecutar la última lectura. El mismo token debe seguir funcionando mientras no haya caducado. Para verificar logout:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$API/auth/logout" \
  -H "Authorization: Bearer $PACO_TOKEN"

curl -sS -i "$API/chats/$CHAT_ID/messages" \
  -H "Authorization: Bearer $PACO_TOKEN"
```

La primera respuesta es 204 y la segunda devuelve 401 con código `UNAUTHORIZED`. Detén el proceso de prueba al terminar.
