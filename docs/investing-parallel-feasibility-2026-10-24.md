# Investing: mediciones previas a paralelizar el worker

Fecha: 2026-10-24. No se cambió el comportamiento de producción.

## Datos observados en Supabase

Consultas de solo lectura sobre `collector_requests`; ventana móvil de 24 horas
en el momento de la medición. `cola = claimed_at - created_at`,
`servicio = completed_at - claimed_at`. Estas marcas incluyen reclamación,
descarga y escrituras del worker, pero no miden el dibujo del navegador.

| Operación                |   n | Cola p50 | Cola p95 | Servicio p50 | Servicio p95 | Total p50 | Total p95 |
| ------------------------ | --: | -------: | -------: | -----------: | -----------: | --------: | --------: |
| market-bars, completadas |  97 |  1,106 s |  5,254 s |      1,227 s |      2,560 s |   2,391 s |   6,860 s |

Las 97 solicitudes fueron de Yahoo y terminaron correctamente. Ninguna de las
97 se solapó con otra entre `claimed_at` y `completed_at`. Veinte llegaron
mientras ya había una ejecutándose: su cola media fue 3,732 s y p95 6,812 s.
En las otras 77, la cola media fue 1,297 s y p95 3,183 s. En siete días hubo
171 solicitudes de barras completas y cinco búsquedas completas; no hubo
fallos registrados en esos grupos.

Una repetición de las 97 llegadas y duraciones históricas con un planificador
ideal subestimó incluso la cola p95 del worker actual (2,372 s simulados frente
a 5,254 s observados). Por ello **no se usa esa repetición como predicción de
la mejora**: faltan en el modelo la latencia de activación, las demás tareas
del ciclo y la variación de Supabase.

## Prueba controlada local

[`work/investing_parallel_spike.py`](../work/investing_parallel_spike.py)
ejercita `MarketWorker.serve_request` y su bucle serial real. Para la variante
paralela usa un planificador acotado de prueba. Supabase y el proveedor están
sustituidos por dobles: cada temporalidad espera su tiempo medio de servicio
observado en las últimas 24 horas. Se precargan las seis temporalidades
distintas de `1d`; no hay llamadas de red ni despliegue.

|        Tareas simultáneas | Seis series terminadas | Espera de reclamación de `1d` añadido 0,2 s después, FIFO |
| ------------------------: | ---------------------: | --------------------------------------------------------: |
|          1, worker actual |                8,201 s |                                                   7,996 s |
| 2, planificador de prueba |                4,246 s |                                                   3,746 s |
| 3, planificador de prueba |                2,798 s |                                                   2,491 s |

Con la **prioridad simulada** para `1d`, la espera de reclamación bajó a
0,946 s con dos tareas y 0,949 s con tres. Esta prioridad aún no existe en
la función SQL de producción; la prueba muestra el efecto de cambiar el orden
de reclamación, no el coste real de una migración.

La prueba de dos solicitudes simultáneas con la misma clave hizo dos llamadas
al proveedor. Con el bucle serial hubo una sola, gracias a `_bar_results`.
Esto confirma que un planificador paralelo necesita deduplicación de trabajo
en curso. También confirma que aumentar el ancho sin prioridad deja al gráfico
visible detrás de la precarga.
La ráfaga de seis entradas representa una futura precarga paralela: el hook
actual todavía envía una temporalidad especulativa cada vez.

Los 41 tests existentes de `test_market_worker.py` pasaron con un directorio
temporal dentro del workspace. La primera ejecución no llegó a correr tests
porque pytest intentó crear su directorio temporal fuera del workspace.

## Pruebas reales desde `bodas`

El Pi respondió por SSH y `edicius-market.service` estaba activo. El ensayo
[`work/investing_pi_provider_probe.py`](../work/investing_pi_provider_probe.py)
ejecutó el adaptador Yahoo desplegado en el Pi con un cliente HTTP compartido,
comparando serie con un máximo de dos solicitudes simultáneas. Consultó AAPL
y no escribió en Supabase. Alternó serie, paralelo, paralelo, serie para
reducir el sesgo de conexiones y caché calientes.

| Temporalidades          | Serie, dos rondas | Paralelo limitado a dos, dos rondas |
| ----------------------- | ----------------- | ----------------------------------- |
| `1m`, `5m`              | 0,686 s; 0,379 s  | 0,634 s; 0,300 s                    |
| `15m`, `1h`, `1w`, `1M` | 1,164 s; 0,847 s  | 1,115 s; 0,893 s                    |

Todas las respuestas tuvieron velas y ninguna devolvió un error. Hubo una
llamada paralela de `1h` que tardó 1,114 s por sí sola; las demás oscilaron
principalmente entre 0,16 y 0,48 s. **No se observó una mejora consistente**
en el tiempo total del adaptador con dos llamadas. Esta muestra pequeña no
establece el comportamiento durante horas de mercado o con muchos símbolos.

Una lectura de 128 metadatos de `market_bars` desde el Pi a Supabase tardó
0,321 s al abrir la conexión y 0,138–0,161 s en cuatro lecturas calientes,
medido con [`work/investing_pi_cloud_probe.py`](../work/investing_pi_cloud_probe.py).
Es una lectura, no el tiempo de las dos escrituras de una solicitud real.

Para separar etapas sin modificar el worker, se cruzó el `fetched_at` de la
serie actualmente guardada con las solicitudes completadas de esa misma
clave. Solo 27 de 171 solicitudes de siete días tenían el `fetched_at` actual
dentro de su intervalo reclamación-finalización. En ese subconjunto:

| Tramo                                     |     p50 |     p95 |
| ----------------------------------------- | ------: | ------: |
| `claimed_at` → `market_bars.fetched_at`   | 0,641 s | 0,926 s |
| `market_bars.fetched_at` → `completed_at` | 0,493 s | 1,012 s |

El primer tramo incluye descarga y creación de la fila; el segundo, escritura
de barras y finalización de la solicitud. La muestra excluye claves que luego
se actualizaron y puede incluir pequeñas diferencias entre el reloj del Pi y
el de Supabase, así que estas cifras son indicativas.

## Conclusión y límites

El worker puede solapar esperas de descarga; dos tareas redujeron casi a la
mitad el tiempo de la ráfaga **simulada**, pero la prueba real del proveedor
no mostró una mejora consistente. Parte apreciable del servicio ocurre tras
la descarga y no se elimina paralelizando solo el adaptador. No está probado
que Yahoo mantenga su latencia o tasa de éxito con precargas continuas.
La ventana real observada fue poco cargada: como máximo dos solicitudes de
barras creadas en un mismo segundo. Tampoco se midió el efecto en las velas en
vivo ni en `completed_at` hasta el dibujo.

Antes de usar concurrencia en producción: priorizar la temporalidad visible
en la cola, deduplicar claves en curso y limitar las solicitudes por proveedor.
La prioridad deja esperar a que se libere una de las dos tareas; si ese máximo
resulta excesivo, se puede reservar capacidad para el gráfico. Empezar con dos
descargas totales, medir p50/p95, errores 429 y latencia del gráfico, y
aumentar a tres solo si esos indicadores mejoran. Después, permitir dos
precargas simultáneas en el hook. El journal del servicio accesible desde SSH
no contiene líneas `market request claimed/served`; la prueba directa del
adaptador y los tiempos de Supabase son las mediciones reales disponibles.
