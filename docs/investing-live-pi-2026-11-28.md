# Investing en vivo desde la Raspberry Pi

## Mediciones del 28 de noviembre de 2026

BTCUSDT, velas de un minuto, Binance real desde la Pi y un proyecto temporal de Neon en `aws-us-east-1`. Chrome ejecutó la página Investing de la rama. La función que recibe las notificaciones de Neon y sirve los eventos al navegador se ejecutó en el PC. El historial inicial de 1.500 velas, la sesión y la posición de una unidad eran datos de prueba.

| Medición                                                                      |     Escritorio | Móvil emulado en Chrome |
| ----------------------------------------------------------------------------- | -------------: | ----------------------: |
| Ventana                                                                       |          300 s |                    90 s |
| Cambios visibles de precio                                                    |            380 |                     162 |
| Cambios con el mismo precio en cabecera, watchlist, posición y cierre de vela |            380 |                     162 |
| Cambios vinculados a una operación recibida de la Pi                          |            376 |                     157 |
| Pi → precio visible, mediana / p95                                            |   167 / 253 ms |            168 / 262 ms |
| Hora de ejecución en Binance → precio visible, mediana / p95                  |   369 / 461 ms |            380 / 479 ms |
| Intervalo entre cambios visibles, mediana / p95                               | 323 / 2.996 ms |          204 / 2.218 ms |

El intervalo entre precios incluye los momentos en los que el mercado conserva el mismo precio. La Pi agrupa ráfagas por símbolo y envía el último valor disponible. La vela oficial corrige máximos, mínimos y volumen. Cuando el cierre de una vela cripto es más reciente que la última operación recibida, la página lo usa también para valorar la posición y actualizar la watchlist.

El observador leyó los cuatro valores dentro de `requestAnimationFrame` con la tabla del gráfico abierta. Para la latencia contó los cambios que coincidían con el último mensaje de operaciones. La marca de origen se tomó al recibir la operación normalizada en la Pi. Se estimó la diferencia de relojes con consultas de ida y vuelta al reloj de la Pi. La mejor ida y vuelta fue de unos 30 ms y la diferencia de relojes varió unos 20 ms durante las pruebas finales. Los percentiles son aproximados. La prueba móvil usó una ventana de 390 × 844 con emulación táctil sobre la misma red. Falta medir una conexión celular y la función desplegada en Vercel.

## Comparación del proveedor

En 60 segundos sobre el mismo socket de BTCUSDT, el ticker de 24 horas entregó 61 mensajes y 52 cambios de precio. El flujo de operaciones agregadas entregó 560 mensajes y 431 cambios. El flujo de velas entregó 30 mensajes y 19 cambios de cierre. La rama usa operaciones agregadas para precios visibles y velas nativas para el gráfico. En otra muestra de 60 segundos, Yahoo entregó 11 cambios de BTC-USD con una mediana de 4,99 s entre cambios y cero mensajes de AAPL. El sábado dejó pendiente la medición de acciones estadounidenses con sesión abierta.

## Transporte y activación

La pestaña visible abre `/api/market/live`. La función verifica la sesión de Better Auth y la fila de `edicius_owners`, y renueva un permiso temporal para los símbolos solicitados. La Pi escucha estas solicitudes y comparte las suscripciones del proveedor entre las pestañas. Precios y velas viajan como notificaciones Postgres cifradas y autenticadas para su canal. La Pi abre las conexiones hacia Neon. Una pestaña sin confirmación de la Pi sigue consultando las cotizaciones guardadas. Los pares de Binance conservan la cadencia de mercado abierto durante el fin de semana.

Para activar un entorno, configurar el mismo secreto `MARKET_LIVE_KEY` de 32 bytes codificado en base64 en el servicio de mercado de la Pi y en la función de Vercel. Se puede generar con `openssl rand -base64 32`. Compilar la web con `VITE_MARKET_LIVE_ENABLED=true`. La conexión directa necesaria para `LISTEN` se deriva de la URL de Postgres ya configurada. El canal usa notificaciones transitorias y conserva la cadencia de las escrituras durables.

## Repetir la prueba

1. En un Postgres de prueba, crear la tabla `public.edicius_owners(owner_id uuid primary key)` si hace falta e insertar un UUID de prueba. Usar la misma base, UUID y clave temporal en ambos extremos.
2. En la Pi, ejecutar `run_market_live(DATABASE_URL, UUID(EDICIUS_OWNER_ID), MARKET_LIVE_KEY)` con `asyncio.run` desde `app.services.neon_market_live`, usando `services/api` en `PYTHONPATH`. También se inicia automáticamente al ejecutar el worker de la rama con el backend Neon y la clave configurada.
3. Desde la raíz del repo, ejecutar `node work/investing_live_browser_probe.mjs` con `MARKET_PROBE_URL`, `MARKET_PROBE_OWNER` y `MARKET_LIVE_KEY` del entorno de prueba. Este servidor escucha en loopback y entrega la ruta de streaming bajo la identidad de prueba.
4. Ejecutar `python work/investing_live_workspace_probe.py --url http://127.0.0.1:35173 --duration 300 --pi-minus-browser-ms OFFSET`. Sustituir `OFFSET` por el reloj de la Pi menos el del navegador en milisegundos. Se puede especificar el ejecutable con `--chrome` y probar el tamaño móvil con `--mobile`.
