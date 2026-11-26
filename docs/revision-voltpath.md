# Revisión de VoltPathBackend

Referencia local: `/Users/dragomir/Developer/apps/VoltPathWorkspace/VoltPathBackend`, commit `c042003`. Se hizo una lectura de código, configuración de ejemplo no sensible y documentación. No se usaron datos de entorno, secretos ni servicios externos de VoltPath.

| Área y archivos | Cómo funciona VoltPath | Decisión para iChat |
| --- | --- | --- |
| `package.json`, `tsconfig.json` | Express 4, TypeScript estricto y scripts dev, build, start y test. | Mantener la pila familiar con Express 5 y separar comprobación de tipos y compilación. |
| `src/app.ts`, `src/server.ts` | La composición HTTP y el arranque están en archivos separados. El servidor inicializa persistencia antes de escuchar. | Crear una factoría de aplicación inyectable. Así se prueban rutas reales en memoria o en un archivo temporal. |
| `src/routes/`, `src/services/`, `src/middleware/` | Separan rutas, operaciones, sesión y formato de error. | Usar módulos por dominio y un único contrato de errores JSON. Los errores internos devuelven un mensaje público genérico. |
| `src/persistence/`, `docs/adr/0001-managed-postgres-persistence.md` | Persistencia SQL con migraciones y PostgreSQL en producción. Los tests pueden usar memoria. | SQLite sirve a la instalación local y utiliza el mismo motor en pruebas. Mantener tablas relacionales y escrituras transaccionales. |
| `src/services/auth.service.ts`, `docs/auth_architecture.md` | La sesión determina la identidad y se puede revocar. Apple y Tesla tienen sus propias integraciones. | Conservar identidad derivada de la sesión, expiración y revocación. Usar cuentas locales con contraseña y sin proveedores externos. |
| `tests/helpers/httpTestServer.ts` | Abre un puerto efímero de loopback, ejecuta pruebas y lo cierra. | Aplicar el mismo patrón a la API de cuentas y conversaciones. Añadir prueba en disco tras reinicio. |
| `render.yaml`, `Dockerfile`, CORS, gateway Go | Resuelven infraestructura web, proxy y comandos externos del proyecto de referencia. | Fuera del alcance local. El servidor escucha en loopback, sin alojar archivos ni usar claves compartidas en el cliente. |

No se ha copiado código de negocio. El contrato iChat mantiene sus propios modelos de cuenta, sesión, chat, miembro y mensaje.
