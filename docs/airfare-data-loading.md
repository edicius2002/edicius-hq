# Carga de los datos de airfare

Revisión del 11 de septiembre de 2026, limitada a «How the price moved» y «Flights seen».

## Hallazgos comprobados

- `useFareHistory` y `useFareCalendar` consultan en paralelo. El historial incluye los snapshots de toda la ruta; el mes limita el baseline y las estadísticas de recolección. El calendario devuelve el horizonte combinado.
- Las consultas heredaban 30 segundos de frescura, un reintento y ninguna actualización al recuperar el foco. No tenían actualización periódica. Una respuesta vacía o un error después del reintento podían persistir mientras la página seguía abierta.
- Las invalidaciones y el stream de recolección local no cubrían las escrituras de otra sesión ni del recolector programado.
- `AnalysisPanel` recibía los estados de carga y error del calendario, pero no los del historial. `FlightTable` recibía un array vacío tanto cuando no había datos como cuando todavía no se habían recibido o había fallado la consulta. Esto permitía mostrar ausencia de vuelos sin haber confirmado la lectura.

Las pruebas de regresión reprodujeron consultas que no incorporaban una respuesta posterior con datos y no se recuperaban de un error sin recargar. También reprodujeron el mensaje de tabla vacía durante la carga.

## Cambios

- Las consultas montadas y visibles vuelven a leer el archivo cada 60 segundos. Los fallos transitorios se vuelven a consultar a los 15 segundos tras quedar en estado de error. Se conserva el reintento inmediato existente. Los errores HTTP 408 y 429 admiten recuperación; otros 4xx detienen la consulta periódica.
- Al recuperar el foco o la conexión se revalidan las consultas que están desactualizadas. Las invalidaciones de las recolecciones locales siguen actualizando inmediatamente.
- Una respuesta permanece fresca 60 segundos y se conserva hasta 30 minutos después de quedar sin observadores. Reabrir una ruta reciente muestra la caché sin otra petición; si ya está desactualizada, se muestra mientras se actualiza.
- Los gráficos y la tabla distinguen carga, error y ausencia de datos. Permiten reintentar el historial sin recargar la página y conservan los datos disponibles si falla una actualización.
- El historial espera a disponer de ruta y mes antes de consultar. Se mantiene la cancelación al cambiar de ruta.

Estas consultas leen datos guardados: no inician búsquedas en Google Flights ni recolecciones nuevas. La actualización periódica aumenta las lecturas del servidor mientras la página está visible: normalmente dos solicitudes por minuto, además de invalidaciones y recuperaciones.

## Rendimiento y límites de la medición

La prueba de reapertura a los 35 segundos pasó de dos solicitudes a una, con los datos disponibles en el primer render de la segunda apertura. Esto verifica una mejora de navegación repetida; no mide una reducción de la latencia de la primera carga.

La búsqueda inicial de archivos quedó incompleta: se revisó `.local-data/fares`, pero los datos reales están en `services/api/.local-data/fares`. La medición posterior sí usa esos archivos y se detalla abajo.

### Medición con datos reales

Se hicieron 15 lecturas por endpoint en las siete rutas guardadas: 105 historiales y 105 calendarios. No hubo respuestas vacías ni variaciones en el número de snapshots/precios dentro de cada ruta. Se usó el primer mes guardado de cada ruta. No se vació la caché de disco del sistema operativo.

| Ruta    | Historial: lectura y JSON, mediana | Calendario: lectura y JSON, mediana | Página con respuestas preparadas, mediana | Cambio a How the price moved, mediana |
| ------- | ---------------------------------: | ----------------------------------: | ----------------------------------------: | ------------------------------------: |
| ARI–SCL |                           94,80 ms |                            10,26 ms |                                  450,3 ms |                               79,8 ms |
| SCL–ARI |                          106,79 ms |                            10,35 ms |                                  423,5 ms |                               64,2 ms |
| SCL–AEP |                          200,94 ms |                            10,03 ms |                                  423,3 ms |                               62,6 ms |
| AEP–SCL |                          234,74 ms |                            10,48 ms |                                  442,6 ms |                               64,7 ms |
| LIM–MAD |                          269,98 ms |                             8,24 ms |                                  465,2 ms |                               76,5 ms |
| MAD–LIM |                          307,02 ms |                             9,67 ms |                                  463,3 ms |                               62,3 ms |
| AQP–LIM |                        1.968,55 ms |                            10,21 ms |                                  660,5 ms |                               64,4 ms |

**Las columnas miden etapas por separado, no una sesión de producción de extremo a extremo.** Lectura y JSON invocan las funciones reales de los endpoints y la serialización Pydantic, sin red, autenticación ni compresión. La API activa respondió 401 a la consulta sin sesión; ese rechazo no se contó como medición de datos.

Para el navegador se compiló la página `AirfarePage` real en modo producción y se sirvieron por HTTP local las respuestas reales guardadas, comprimidas con gzip. Se hicieron cinco aperturas por ruta, cada una con un contexto de navegador nuevo: 35 en total. Chromium se ejecutó sin aceleración GPU, a 1440 × 1000 y con movimiento reducido. Se comprobó la ruta y el número exacto de snapshots recibidos, la aparición de filas en la tabla y la ausencia de errores de JavaScript. Las 35 aperturas pasaron.

El tiempo de página va desde la navegación hasta la tabla disponible y dos frames de pintado. El cambio de gráfico incluye el clic automatizado y dos frames. No incluye autenticación, la estructura exterior de la aplicación, el tiempo de construcción del JSON en el servidor ni una conexión WAN. Es una medición local de transferencia, descompresión, JavaScript y renderizado con las respuestas preparadas. No deben sumarse medianas como si fuesen una medida observada de extremo a extremo.

### Coste dominante y siguiente optimización

**AQP–LIM concentra el mayor coste:** archivo de 21.022.534 bytes, 4.368 snapshots y 87.695 ofertas. La respuesta del historial ocupa 19.392.203 bytes sin comprimir y 885.720 bytes con gzip. De los 1.968,55 ms de mediana, la construcción de la respuesta consume aproximadamente 1.796,69 ms y la serialización 152,46 ms; las medianas de las etapas no tienen por qué sumar la mediana del total. El máximo observado del total fue 2.697,72 ms. El parseo JSON en Chromium fue de 55,9 ms de mediana.

En las otras rutas, el parseo del historial fue de 3–11,6 ms. Los calendarios pesaron aproximadamente 28–29 KB sin comprimir y tardaron 8–11 ms en construirse y serializarse. Estas observaciones sitúan la prioridad en la lectura y construcción del historial, antes que en el gráfico o el calendario.

La próxima optimización fundamentada en estas medidas sería reutilizar la lectura/decodificación del archivo mientras su identidad, tamaño y fecha de modificación no cambien, con invalidación tras las escrituras. Después conviene separar los snapshots de la ruta de los datos específicos del mes para evitar volver a transferir todo el historial al cambiar de mes. No se puede simplemente recortar snapshots al mes: «Flights seen» usa todos los meses vigilados y la referencia de precios usa la ruta completa.

No se reprodujo la pérdida intermitente con estos datos en las condiciones medidas. El máximo local deja menos margen dentro del timeout de 5 segundos, pero no demuestra que los incidentes hayan sido timeouts. Quedan sin medir la red usada por la sesión real, el coste completo del servidor HTTP bajo concurrencia y las escrituras simultáneas del recolector.

Resultados detallados: [airfare-measurements.json](airfare-measurements.json). El JSON contiene métricas y referencias a payloads temporales; no incorpora las ofertas completas.

Para repetir la medición, desde la raíz del repositorio:

```powershell
services/api/.venv/Scripts/python.exe scripts/measure_airfare.py --samples 15 --output docs/airfare-measurements.json
node scripts/airfare-measurement/build.mjs "$env:TEMP/airfare-measure-build"
services/api/.venv/Scripts/python.exe scripts/measure_airfare_browser.py --report docs/airfare-measurements.json --build "$env:TEMP/airfare-measure-build" --samples 5
```

Los scripts no arrancan recolectores ni escriben en el archivo original. El servidor temporal solo escucha en loopback y no implementa escrituras; se cierra al terminar. Los payloads temporales se guardan en la ruta indicada en el JSON.

La recuperación no garantiza datos si el servidor permanece inaccesible o el archivo está corrupto. Los lectores del servidor pueden convertir errores de lectura en arrays vacíos; las nuevas consultas periódicas permiten recuperarse si la lectura vuelve a funcionar, pero no distinguen esa respuesta de un archivo vacío legítimo. No se ha probado que este fuese el origen de los incidentes reportados.

## Validación reproducible

```powershell
npm run test -w web -- src/features/airfare
npm run typecheck
```

Las regresiones cubren actualizaciones externas, recuperación de fallos de red y HTTP transitorios, reutilización de caché, conservación de datos tras un fallo, estados visibles de carga/error y una respuesta lenta de una ruta anterior que no debe reemplazar la ruta actual.
