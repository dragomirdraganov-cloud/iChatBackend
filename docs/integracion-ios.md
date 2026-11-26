# Siguiente fase: conectar iChat

Esta fase está pendiente. El backend se puede verificar de forma independiente mediante HTTP y ChatStore de SwiftData continúa funcionando como antes.

## Secuencia propuesta

- [ ] Definir la URL por configuración de Debug. Probar primero la ruta local desde Simulator hacia el Mac con `GET /health`. Un iPhone físico tiene su propio loopback y necesita un transporte de desarrollo separado. La configuración actual del servidor permanece en loopback.
- [ ] Crear DTO y un cliente `URLSession` con decodificación ISO 8601 que acepte milisegundos, errores de API por código y manejo explícito de 204. Probar el contrato antes de sustituir las vistas.
- [ ] Conectar registro/login/logout y `GET /users/me` con `SessionManager`. Guardar el token en Keychain. Eliminarlo en logout y ante una respuesta de sesión revocada o caducada. Los usuarios de la app local necesitan una cuenta nueva en el backend.
- [ ] Convertir la creación de chat en selección de destinatarios mediante `GET /users`. Mostrar el nombre del otro miembro para un directo y el título para un grupo.
- [ ] Conectar listado, detalle e historial conservando el UUID de servidor. Crear un UUID `clientMessageId` por cada borrador enviado y reutilizarlo al reintentar. Diferenciar fallo de red de una respuesta 409.
- [ ] Sincronizar con `after` mientras una conversación esté abierta. Usar `before` al cargar más historial. Probar llegada de mensajes desde dos sesiones, reintentos, cambio de cuenta y reingreso.
- [ ] Decidir qué datos de SwiftData quedan como caché y cómo se separan por cuenta. Preparar una migración explícita si se importan mensajes o conversaciones antiguas, incluyendo cómo asignar sus miembros.

## Fuera de la primera integración

Mensajería en tiempo real con WebSocket o similar, estados de entrega/lectura, notificaciones push, adjuntos, cambios de miembros, recuperación de cuenta y despliegue. El contrato v1 ofrece suficientes operaciones para validar el flujo local por sondeo HTTP.
