# Resultado del caché de lectura de airfare

Status: complete

## Enfoque

`FareHistory.read` mantiene un LRU por ruta con los snapshots decodificados. Una
entrada solo se reutiliza cuando coinciden la identidad del archivo (`st_dev` y
`st_ino`), su tamaño y `mtime_ns`; no hay TTL. El caché admite como máximo ocho
rutas y 128 MiB de archivos fuente, de modo que tanto el número de objetos
retenidos como el crecimiento asociado al tamaño de los archivos quedan
acotados.

Cada lectura toma un lock estriado por ruta. Un miss comprueba la firma antes y
después de decodificar y reintenta hasta tres veces si el archivo cambia. Esto
evita reconstrucciones duplicadas dentro del proceso y evita publicar una
lectura parcial de una escritura concurrente. Un append propio usa el mismo
lock e invalida la entrada inmediatamente después de cerrar una escritura
exitosa.

El caché conserva la ruta completa y aplica `since`/`until` al devolver cada
respuesta. Cada respuesta recibe listas nuevas de ofertas, por lo que un caller
no puede modificar el contenido retenido. Las líneas corruptas aisladas se
omiten y las filas válidas se conservan; un archivo completamente ilegible
mantiene el resultado histórico vacío y el log de error, pero ese resultado no
se almacena en caché.

Los errores `PermissionError`/`OSError` de un archivo existente se propagan; el
endpoint `/api/fares/history` los convierte en HTTP 503 sin exponer detalles
del filesystem. Un archivo ausente sigue siendo un resultado vacío legítimo y
se vuelve a consultar por firma en la siguiente lectura, por lo que puede
aparecer después.

No se cambió el frontend, el formato de archivos, la separación por ruta/mes,
ni la API o semántica de snapshots, filtros, orden, baseline y checks.

## Invariantes verificadas

- Hit sin una segunda decodificación y filtros aplicados después del hit.
- Append propio y externo, creación tras ausencia, reemplazo y truncado.
- Estabilidad antes/después de leer, reintento y error ante cambio sostenido.
- Error transitorio propagado y recuperación posterior; HTTP 503 en el borde.
- Una sola reconstrucción concurrente por ruta.
- Evicción LRU por número de rutas y por presupuesto de bytes.
- Aislamiento frente a mutación de las listas retornadas.
- Corrupción parcial sin pérdida de filas válidas y corrupción total no cacheada.

## Comandos y resultados

Las dependencias fijadas en `services/api/requirements.txt` se instalaron en
una venv temporal dentro del worktree; la venv y todos los directorios de
pytest se eliminaron después de verificar.

- `python -m pytest -q --basetemp .pytest-airfare-cache-full-local`: **622
  passed**, 2 warnings de deprecación de FastAPI/Starlette, 69,91 s.
- `python -m ruff format --check . ../../scripts`: **106 files already
  formatted**.
- `python -m ruff check . ../../scripts`: **All checks passed**.
- `python -m mypy app/services/fare_history.py app/routers/fares.py`:
  **Success: no issues found in 2 source files**.
- `python -m mypy`: encontró un error preexistente y fuera del ownership en
  `scripts/measure_airfare_browser.py:29` (override de variable de
  `SimpleHTTPRequestHandler`). Los archivos modificados pasan el typecheck
  dirigido y este worker no editó el script de medición.

Una comprobación de solo lectura contra
`D:/Work/research/edicius-hq/services/api/.local-data/fares/AQP-LIM.jsonl`
encontró 4.524 snapshots y 91.011 ofertas en el archivo presente al medir. En
una instancia nueva, la primera lectura tomó 3.837,02 ms y el hit inmediato
31,68 ms, con conteos idénticos. Esta comprobación no ejecutó colectores ni
escribió datos reales.
