# Plan de trabajo de iChatBackend

Fecha de inicio: 26 de noviembre de 2026. Este archivo es el punto de seguimiento de la primera fase. Una casilla se marca al terminar su verificación; los resultados de las pruebas se guardan en [docs/pruebas.md](docs/pruebas.md).

## Objetivo y criterio de aceptación

Arrancar una API REST en el Mac, registrar dos cuentas y enviar mensajes entre ellas mediante peticiones HTTP. Los usuarios, sesiones y mensajes deben sobrevivir al reinicio. La API comprobará pertenencia al chat para cada lectura y escritura. Un cliente iOS se integrará en una fase posterior.

## Seguimiento

- [x] Localizar el proyecto de referencia y revisar su estructura, persistencia, sesiones y pruebas.
- [x] Decidir arquitectura, alcance, contrato inicial y criterios de validación.
- [x] Preparar Node, Express, TypeScript, configuración y migraciones SQLite.
- [x] Implementar alta, login, logout, perfil y búsqueda de usuarios.
- [x] Implementar chats directos y de grupo, comprobación de membresía, envío e historial paginado.
- [x] Probar respuestas correctas y errores por HTTP con datos aislados.
- [x] Arrancar el binario compilado, guardar datos, reiniciar y comprobar persistencia por HTTP.
- [x] Revisar integración con subagentes y actualizar README, contrato y resultados.
- [ ] Integrar el backend en la aplicación iOS, en la siguiente fase.

## Decisiones iniciales

1. **Node.js 24.15+ o posterior, TypeScript y Express 5.** Mantener la separación de arranque, aplicación y rutas que usa VoltPath. Ejecutar con scripts npm y registrar versiones en el lockfile.
2. **SQLite local.** Usar `node:sqlite`, claves foráneas y una migración inicial. Por defecto, la base se guarda en `data/ichat.sqlite`. Las pruebas eligen una base en memoria o un archivo temporal.
3. **Identidad de servidor.** Registrar cuentas nuevas y emitir sesiones Bearer opacas y revocables con vencimiento. La app local existente sigue siendo independiente; no se importan hashes de SwiftData.
4. **Conversaciones con miembros.** Admitir una conversación directa por pareja y grupos con lista de miembros fijada al crear. Cada mensaje recibe UUID, fecha del servidor y una secuencia para paginar en ambos sentidos. La clave opcional de idempotencia facilita reintentar un envío.
5. **Solo loopback.** Escuchar en `127.0.0.1`, sin despliegue, servicios externos en ejecución ni configuración de CORS. Los mensajes se consultan por REST. WebSocket, adjuntos, notificaciones, edición y recuperación de cuenta son fases futuras.

## Orden y reparto

- Integración, migraciones, configuración y documentación a cargo del agente principal.
- Cuentas y sesiones, y conversaciones y mensajes, implementados por dos subagentes con archivos separados.
- La tercera línea de trabajo revisa el ejemplo y después prueba de forma independiente la integración.

## Cómo ejecutar el plan

1. Desde esta carpeta, instalar con `npm ci` una vez disponible el lockfile.
2. Ejecutar `npm run check`, `npm test` y `npm run build`.
3. Arrancar con `npm start` y comprobar `GET /health`. Para pruebas manuales con datos desechables, configurar `ICHAT_DB_PATH` con un archivo temporal.
4. Registrar dos usuarios, localizar al segundo, crear el chat, enviar y leer desde las dos sesiones. Registrar una tercera cuenta y comprobar que no puede acceder a la conversación.
5. Reiniciar con el mismo archivo temporal y verificar que se mantienen el chat y los mensajes. Ejecutar logout y comprobar que la sesión deja de ser válida.
6. Anotar versiones, comandos, resultados y limitaciones en la documentación final.
