# iChatBackend

API REST local de iChat para cuentas, sesiones y mensajería. Un proceso Node.js sirve JSON en `127.0.0.1` y guarda los datos en un archivo SQLite del Mac. Node.js, TypeScript y Express siguen la estructura general de VoltPathBackend.

## Arranque

Abre una terminal en esta carpeta. Necesitas Node.js 24.15 o posterior y npm. El entorno verificado utilizó Node.js 25.6.0 y npm 11.8.0.

```sh
npm ci
npm run build
npm start
```

Desde otra terminal:

```sh
curl --fail --silent --show-error http://127.0.0.1:3000/health
```

Debe responder `{"status":"ok"}`. `Ctrl+C` cierra el proceso y su conexión a SQLite. Para desarrollo, `npm run dev` arranca desde TypeScript y reinicia cuando cambian los archivos fuente.

| Variable | Valor por defecto | Uso |
| --- | --- | --- |
| `ICHAT_PORT` | `3000` | Puerto TCP. Usa otro valor si ya está ocupado. El valor `0` selecciona un puerto libre que se imprime al arrancar. |
| `ICHAT_DB_PATH` | `data/ichat.sqlite` | Ruta absoluta o relativa al directorio desde donde arrancas. `:memory:` permite una sesión de prueba sin persistencia entre procesos. |

Por ejemplo, `ICHAT_PORT=3100 ICHAT_DB_PATH=:memory: npm run dev` abre un entorno temporal. No se necesita un archivo `.env`. El proceso usa las variables exportadas por la terminal.

## Comprobar la instalación

```sh
npm run check
npm test
npm run build
npm run test:smoke
```

`test:smoke` ejecuta el servidor compilado dos veces, en puertos libres y con la misma base temporal. Comprueba el flujo completo y limpia sus datos al terminar. El [guion manual por HTTP](docs/pruebas.md#prueba-manual) muestra cómo repetirlo con `curl`.

## Documentación y seguimiento

- [PLAN.md](PLAN.md) registra el alcance y las casillas de seguimiento.
- [Revisión de VoltPathBackend](docs/revision-voltpath.md) explica las decisiones reutilizadas.
- [Diseño, persistencia y operación](docs/diseno.md) explica módulos, integridad, sesiones y mantenimiento.
- [Contrato HTTP](docs/api.md) describe rutas, campos, errores y paginación.
- [Pruebas y resultados](docs/pruebas.md) documenta qué se ejecutó y cómo repetirlo.
- [Siguiente fase iOS](docs/integracion-ios.md) identifica el trabajo necesario para conectar la app.
