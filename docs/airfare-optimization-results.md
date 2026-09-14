# Validación de la caché de historial de airfare

Resultados del 14 de septiembre de 2026, limitados a la carga de datos de
«How the price moved» y «Flights seen».

## Resultado

La caché conserva el contrato público completo y elimina la lectura y
decodificación repetida del archivo cuando no cambia. En AQP–LIM, sobre la
misma copia congelada y 15 repeticiones sin cambios, la mediana de la función
del endpoint más serialización Pydantic bajó de **1.920,24 ms** a
**1.068,16 ms**: 852,08 ms menos, o **44,37 %**. Las lecturas del JSONL en esas
15 repeticiones bajaron de **15 a 0**.

No se cambió el frontend, el formato de la API, la semántica de filtros, la
separación por ruta/mes ni el calendario. No se ejecutaron recolectores ni
endpoints reales de escritura.

## Versiones y datos comparados

- Base de código backend: `a4c479a900ab7a2eb45e33a94d72419caea2e4fd`.
- Reporte base: `ea118ce12c795616ea4532b6cd2b02db9477622b`. Este commit sólo añade las
  pruebas independientes sobre la base anterior; el backend medido sigue
  siendo el de `a4c479a`.
- Implementación original de Worker 1: `ca39f0c87b337e4842501549373c88684499f8e0`.
- Implementación integrada y medida en esta rama:
  `c1f150a13bf66f54434d12be965f5e9c60f7de33`.
- SHA-256 del manifiesto de la copia congelada:
  `ec6f786fbc30419920f2062406411e35855cf28a8b96a4d62edcae3dd3e78317`.
- Archivo AQP–LIM de la copia: 23.785.150 bytes, 4.909 snapshots y 99.203
  ofertas. La respuesta ocupa 21.912.762 bytes sin comprimir y 1.002.036 bytes
  con gzip.

La copia seleccionada completa —historial, baseline, checks, aeropuertos,
calendario y watchlist— ocupa 25.587.862 bytes. El arnés comprobó que el origen
real no cambió durante ninguna de las dos ejecuciones. La corrida optimizada
reutilizó la copia congelada de la base; append, reemplazo y truncado se
hicieron en copias de trabajo distintas y temporales.

Los datos son posteriores a los preservados en
[`airfare-measurements.json`](airfare-measurements.json), que registraban 4.368
snapshots y 87.695 ofertas. Por eso no se compara directamente el tiempo nuevo
con aquella captura; la comparación válida es base contra optimización sobre
el hash congelado común. El archivo original de resultados no se modificó.

## Rendimiento medido

| Fase | Base | Optimizada | Lecturas JSONL base → optimizada | Interpretación |
| --- | ---: | ---: | ---: | --- |
| Primer acceso en proceso nuevo | 1.745,63 ms | 1.597,24 ms | 1 → 1 | Una muestra por versión; no demuestra una mejora general. |
| 15 repeticiones sin cambios | 1.920,24 ms mediana | 1.068,16 ms mediana | 15 → 0 | Comparación principal: −44,37 %. |
| Después de append | 1.819,85 ms | 1.626,87 ms | 1 → 1 | Una muestra; demuestra invalidación y lectura, no una tendencia temporal. |
| Después de reemplazo | 2.175,86 ms | 2.341,01 ms | 1 → 1 | Una muestra; demuestra invalidación y contenido restaurado. |
| Después de truncado | 53,28 ms | 75,32 ms | 1 → 1 | Una muestra de un archivo reducido a un snapshot. |

El p95 de las 15 repeticiones fue 2.441,18 ms en la base y 1.455,49 ms con la
caché. No hay umbrales de milisegundos en los tests: los tiempos quedan en
reportes separados y los tests prueban lecturas, invalidación y contenido.

La sonda de memoria se ejecuta como un acceso adicional después de cada fase,
fuera del cronómetro porque `tracemalloc` distorsionaba materialmente esta
decodificación. En la repetición sin cambios, el pico incremental trazado bajó
de 174.403.242 a 129.976.841 bytes (44.426.401 bytes, 25,47 %). En la base esa
sonda vuelve a leer el archivo; con la caché es un hit. Esta cifra no es RSS,
no incluye la memoria ya retenida por la caché antes de iniciar el trazado y no
debe interpretarse como consumo total del proceso.

## Integridad e invalidación

Los cinco estados comparados —primer acceso, repetición, append, reemplazo y
truncado— tienen el mismo SHA-256 de respuesta entre base y optimización. Para
el estado sin cambios, ambos reportan exactamente:

- 4.909 snapshots;
- 99.203 ofertas;
- 1.846 puntos de baseline;
- dos aeropuertos;
- health con 3.112 checks, 2.520 cambios, 21 errores y el mismo
  `lastCheckedAt`.

Después del append aparecen 4.910 snapshots y 99.224 ofertas; después del
reemplazo vuelven exactamente el digest y los conteos originales; después del
truncado queda un snapshot con 16 ofertas. Cada cambio causa una lectura y la
repetición estable no causa ninguna.

Las pruebas independientes llaman `GET /api/fares/history` con `TestClient` y
no importan símbolos internos de caché. Cubren:

- snapshots y todas sus ofertas/campos en orden;
- baseline, health y aeropuertos exactos;
- normalización de ruta y filtros `departure`, `since` y `until`;
- hit repetido y miss tras append externo;
- creación del archivo después de una respuesta vacía legítima;
- reemplazo y truncado sin filas obsoletas;
- error temporal de lectura como respuesta no exitosa, nunca como historial
  vacío exitoso, y recuperación en la petición siguiente.

Tras integrar Worker 1 pasaron **53 pruebas** en 6,16 s:

```powershell
& 'D:/Work/research/edicius-hq/services/api/.venv/Scripts/python.exe' -m pytest -q -p no:cacheprovider `
  services/api/tests/fares/test_fare_history_cache_integration.py `
  services/api/tests/fares/test_fare_history_cache.py `
  services/api/tests/fares/test_fare_history_store.py `
  services/api/tests/fares/test_fares_endpoint.py
```

La verificación final con las versiones fijadas volvió a pasar las 53 en
8,51 s. Una corrida adicional de toda la API pasó 630 pruebas en 73,71 s. Al
repetirla después de cambios sólo en los arneses, pasó 629 y falló una prueba
ajena a airfare: `BarCache.read(..., ttl=0)` aceptó una entrada recién escrita
cuando su `st_mtime` quedó momentáneamente por delante de `time.time()`. Esa
prueba de mercado pasó 10 de 10 repeticiones aisladas. No se modificaron sus
archivos porque están fuera del ownership de esta etapa.

## Reproducción

Los dos checkouts deben ejecutar el arnés con el mismo `--frozen-copy`. La
primera ejecución crea esa copia; la segunda la detecta y la reutiliza sin
modificarla. Cada `--work-dir` debe ser nuevo.

```powershell
$python = 'D:/Work/research/edicius-hq/services/api/.venv/Scripts/python.exe'
$source = 'D:/Work/research/edicius-hq/services/api/.local-data'
$frozen = "$env:TEMP/edicius-airfare-cache-aqp-lim-frozen"

# En el checkout de la base backend a4c479a, con el arnés de d8e6b25:
& $python scripts/measure_airfare.py --data-dir $source --frozen-copy $frozen `
  --work-dir "$env:TEMP/airfare-base-work" --pair AQP-LIM --samples 15 `
  --output docs/airfare-cache-baseline.json

# En el checkout integrado c1f150a:
& $python scripts/measure_airfare.py --data-dir $source --frozen-copy $frozen `
  --work-dir "$env:TEMP/airfare-optimized-work" --pair AQP-LIM --samples 15 `
  --output docs/airfare-cache-optimized.json

& $python scripts/measure_airfare.py --compare `
  docs/airfare-cache-baseline.json docs/airfare-cache-optimized.json `
  --output docs/airfare-cache-comparison.json
```

Resultados completos:

- [`airfare-cache-baseline.json`](airfare-cache-baseline.json)
- [`airfare-cache-optimized.json`](airfare-cache-optimized.json)
- [`airfare-cache-comparison.json`](airfare-cache-comparison.json)

## Metodología y límites

- “Primer acceso” significa primer acceso en un proceso nuevo. No se vació la
  caché de disco del sistema operativo y no se afirma que sea disco frío.
- La medición llama la función real del endpoint y serializa con Pydantic, sin
  HTTP, autenticación, compresión de transporte, red ni concurrencia de
  servidor. Los tamaños gzip se calculan fuera del cronómetro.
- La comparación temporal principal usa 15 repeticiones de una ruta grande;
  primer acceso y mutaciones tienen una sola muestra y sirven para validar
  contenido/invalidación.
- No se probó una escritura concurrente del recolector real. Las pruebas
  internas integradas sí cubren cambios concurrentes controlados; todos usan
  archivos temporales.
- El replay de navegador no se repitió en este worktree porque no contiene
  `node_modules`. La herramienta ahora registra hashes, configuración y ambos
  flags de GPU (`--disable-gpu`, `--disable-software-rasterizer`) y etiqueta el
  resultado como replay local de respuestas preparadas. Nunca representa
  latencia WAN ni extremo a extremo.

## Pendientes reales

- Un hit todavía tarda alrededor de un segundo en este archivo porque el
  endpoint crea modelos de respuesta y copias defensivas de 99.203 ofertas.
  La separación por ruta/mes podría reducir ese trabajo y la transferencia,
  pero está expresamente fuera de esta etapa.
- Medir el servidor HTTP completo bajo concurrencia, autenticación y red real.
- Medir RSS y memoria retenida del proceso además del pico incremental de
  `tracemalloc`.
- Ejecutar un replay nuevo de navegador cuando haya dependencias web
  preparadas; interpretarlo sólo como coste local de transferencia,
  descompresión, JavaScript y renderizado.

No quedaron defectos reproducibles de integridad o recuperación dentro del
alcance de esta validación.
