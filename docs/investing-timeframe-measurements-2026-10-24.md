# Investing: mediciones de cambio de temporalidad

Fecha: 2026-10-24. Producción web, Supabase y Raspberry Pi `bodas`.
La optimización local de precarga todavía no está desplegada. Las pruebas de
ráfaga insertaron dos lotes acotados de seis solicitudes normales de velas
para BNO; actualizaron únicamente la caché reemplazable de `market_bars`.

## Dónde se va el tiempo

| Prueba fría en navegador | Acción → solicitud creada |    Cola |  Worker | Completada → velas | Acción → velas |
| ------------------------ | ------------------------: | ------: | ------: | -----------------: | -------------: |
| USO `15m`                |                   2,353 s | 2,443 s | 1,669 s |           ≈0,098 s |        6,563 s |
| USO `1M`                 |                   3,011 s | 1,421 s | 0,986 s |           ≈0,055 s |        5,473 s |
| BNO `1w`                 |                   8,329 s | 1,065 s | 1,175 s |           ≈0,008 s |       10,577 s |

Fuente y método: [línea de base del navegador](investing-preload-browser-baseline-2026-10-24.md).
La acción incluye el coste de automatización. El reloj del navegador y los
timestamps de Supabase no están sincronizados para medir milisegundos. La
espera antes de crear la solicitud **no está atribuida aún**: en el código
hay `getSession`, lectura de IndexedDB y SELECT de `market_bars` en serie,
pero faltan marcas internas para distinguirlos. El registro anterior de
1,79 s entre finalización y dibujo no se reprodujo en estas tres pruebas.
Al volver a USO `1h` y `1w` ya visitados, las velas aparecieron en 0,447 y
0,551 s, respectivamente.

En una lectura posterior de 111 solicitudes completadas de barras durante
24 horas, la cola tuvo p50 1,083 s y p95 5,176 s; el servicio tuvo p50
1,222 s y p95 2,544 s. Son tramos de servidor: excluyen la espera previa
a crear la solicitud y el dibujo. El probe reproducible está en
[`work/investing_pi_queue_probe.py`](../work/investing_pi_queue_probe.py).

## Caché existente frente a descarga nueva

Antes de las ráfagas, USO tenía seis de siete series `extended=true`
guardadas pero vencidas y una vigente. BNO tenía cinco ausentes, una
vencida y una vigente. Las vencidas contienen velas dibujables y pueden
refrescarse después.

Desde el Pi a Supabase, leer las siete filas de USO en una petición tomó
0,449–0,590 s para 931 400 bytes. Tras las ráfagas, leer las siete de BNO
tomó 0,421–0,575 s para 933 121 bytes. Una fila de USO `15m` de 183 922
bytes tardó 0,232–0,562 s en las rondas. Medido con
[`work/investing_pi_bar_read_probe.py`](../work/investing_pi_bar_read_probe.py).
Una comparación directa adicional desde el mismo Pi alternó siete SELECT
individuales y uno agrupado, con las siete filas ya presentes:

| Símbolo | Siete lecturas individuales | Una lectura agrupada |
| ------- | --------------------------- | -------------------- |
| USO     | 1,882 s; 1,600 s            | 0,549 s; 0,454 s     |
| BNO     | 1,486 s; 1,435 s            | 0,484 s; 0,806 s     |

Las medianas de las cuatro muestras fueron 1,543 s y 0,517 s,
respectivamente (≈3,0 veces menos tiempo). El volumen transferido fue
prácticamente igual, unos 930 kB. El ensayo es reproducible con
[`work/investing_pi_batch_vs_single_probe.py`](../work/investing_pi_batch_vs_single_probe.py).
Son tiempos Pi→Supabase; la ruta del navegador, su decodificación y el
dibujo de siete series no se midieron. La consulta agrupada ya está
implementada en la web local, pero su ganancia en el navegador requiere
una prueba tras desplegarla o abrirla localmente con una sesión autenticada.

## Ráfagas reales en el worker actual

[`work/investing_pi_burst_probe.py`](../work/investing_pi_burst_probe.py)
insertó en cada ronda seis solicitudes BNO (`1m`, `5m`, `15m`, `1h`, `1d`,
`1M`) en una sola operación. Todas completaron correctamente.

| Ronda | Primera creada → última completa | Espera máxima en cola | Suma de servicios | Solapamiento |
| ----- | -------------------------------: | --------------------: | ----------------: | ------------ |
| 1     |                          8,568 s |               8,000 s |           6,482 s | Ninguno      |
| 2     |                          8,418 s |               7,135 s |           5,780 s | Ninguno      |

En la segunda ronda las pausas entre la finalización de una tarea y la
reclamación de la siguiente fueron 0,184–0,543 s (suma 1,569 s). Las seis
filas del mismo INSERT tuvieron el mismo `created_at`; la RPC ordena por
`created_at, request_id`, así que el orden entre ellas dependió del UUID.
Por ejemplo, `1m` fue primera en la primera ronda y última en la segunda.
Una temporalidad visible encolada después de esta ráfaga quedaría detrás
de las especulativas con el orden FIFO actual.

El Pi tiene cuatro núcleos, aproximadamente 6,2 GiB de memoria disponible
al comprobarlo, y `edicius-market.service` estaba activo. Eso permite
ensayar dos tareas de E/S, pero no prueba capacidad del proveedor ni del
plano de datos durante horas de mercado.

## ¿Sirve paralelizar Yahoo?

El adaptador real del Pi consultó seis temporalidades AAPL con el mismo
cliente HTTP, alternando serie/paralelo/paralelo/serie, sin escrituras:

|   Serie | Máximo dos simultáneas |
| ------: | ---------------------: |
| 2,563 s |                1,050 s |
| 1,664 s |                0,917 s |

Las 24 lecturas devolvieron velas sin error. En una prueba previa de solo
cuatro temporalidades, la mejora no fue consistente (serie 1,164/0,847 s;
paralelo 1,115/0,893 s). Por tanto, **hay posibilidad real de solapar
descargas**, pero no se ha medido una aceleración de extremo a extremo del
worker concurrente. Cada solicitud además reclama, escribe la fila y
finaliza en Supabase. Una muestra histórica emparejada de 27 solicitudes
dio p50 0,641 s desde la reclamación hasta `fetched_at` y 0,493 s desde
`fetched_at` hasta completar; esos tramos son indicativos, no cronometraje
interno del worker. Véase [factibilidad previa](investing-parallel-feasibility-2026-10-24.md).

## Recomendación en orden

1. **Hidratar las siete temporalidades guardadas al seleccionar el símbolo.**
   Hacer un SELECT agrupado por símbolo y variante `extended`, poblar las
   claves de React Query y dibujar de inmediato incluso la serie vencida.
   Refrescarla en segundo plano. Conservar las series en memoria durante la
   sesión y con límite de memoria/tiempo para símbolos abandonados. La
   precarga local actual espera a que termine la visible y consulta las otras
   seis una por una; por eso no proporciona este arranque rápido para las
   series ya guardadas.
2. **Instrumentar la espera antes de `created_at`.** Registrar marcas para
   acción, sesión, IndexedDB, SELECT, INSERT, resultado y primer dibujo.
   Evitar bloquear la solicitud de red por una lectura local lenta; leer
   local y remoto concurrentemente o poner un límite a IndexedDB. Las tres
   trazas muestran que este tramo puede dominar, pero aún no identifican
   su causa específica.
3. **Dar prioridad a la temporalidad visible antes de ampliar la ráfaga.**
   La RPC `claim_collector_request` de Supabase solo ordena por antigüedad.
   Añadir prioridad comprobable para visible frente a precarga y
   deduplicación por símbolo/temporalidad/variante. Mientras siga el worker
   serial, limitar la precarga de series ausentes a una solicitud en curso
   para que no bloquee una selección posterior.
4. **Probar dos tareas concurrentes en `MarketWorker.claim_until_empty`.**
   Limitar simultaneidad total y por Yahoo a dos, preservar una vía rápida
   para visible, compartir un único trabajo por clave y medir p50/p95 de
   cola, servicio, errores del proveedor y tiempo de dibujo. Los ensayos
   directos de Yahoo justifican un piloto; los datos presentes no justifican
   afirmar que el tiempo completo de 8,4–8,6 s se reducirá a la mitad.

La versión local de la web no pudo abrirse autenticada: falta la configuración
de autenticación de desarrollo. Por ello no se presenta una cifra antes/después
de la precarga local. El siguiente ensayo de navegador debe hacerse con esa
configuración o un despliegue aislado y con las marcas internas anteriores.
