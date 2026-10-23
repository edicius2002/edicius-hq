# Transporte prod6: control y observabilidad

## Plan y alcance

Partir de `origin/main` y modificar solamente el transporte vendorizado, sus
pruebas y este documento. Mantener el paralelismo de cinco detalles por defecto,
sin cuota por minuto, adaptación automática, despliegue ni cambios del colector.
La alternativa de reducir concurrencia o imponer una tasa requiere mediciones;
un semáforo local por lote no limita llamadas simultáneas de distintos tools.

- [x] Probar con HTTP simulado dos lotes y búsqueda concurrentes, errores por
  fase, Retry-After, cancelación y ausencia de secretos.
- [x] Añadir un semáforo prod6 compartido, configurable mediante
  `SEACE_PROD6_MAX_CONCURRENCY` (entero positivo, predeterminado 5).
- [x] Emitir eventos JSON por intento con endpoint normalizado, fase, estado,
  duración, espera, concurrencia y referencia opaca del ID; sanear errores.
- [x] Conservar tres intentos para 429, 5xx y errores de red/timeout, sin
  reintentar 403; conservar `faltas` con ID y añadir clasificación por fase.
- [x] Ejecutar pruebas y revisión de diff, documentar observación pasiva y
  entregar commit en la rama existente, sin push, merge ni acceso a la Pi.

## Configuración y compatibilidad

`SEACE_PROD6_MAX_CONCURRENCY` se lee al iniciar el MCP y debe ser un entero
positivo; valor predeterminado **5**. Es independiente de
`SEACE_MAX_CONCURRENCY`, que sigue regulando otras rutas. Cada intento HTTP de
`api6_json`, incluidos búsqueda, detalle, archivos y reintentos, adquiere el mismo
semáforo del proceso. La capacidad se libera al terminar o cancelar la solicitud,
y antes de esperar un reintento. El límite no aumenta tras éxitos.

El lote mantiene además su ocupación local de cinco IDs por defecto: conserva
las dos consultas secuenciales por ID y la ocupación durante backoff. Un lote
aislado saludable conserva su paralelismo anterior; llamadas solapadas comparten
ahora el techo de cinco peticiones. No se introduce una cuota por minuto, pausa
entre éxitos, breaker, ajuste adaptativo ni coordinación entre procesos. El MCP
usa un único event loop; el semáforo dura toda su vida, incluso al crear clientes
HTTP y lotes nuevos. Reiniciar el MCP reinicia su estado.

`detalles_convocatorias_menores(ids, fase="all")` sigue aceptando 1–20 IDs.
`fase="detail"` pide solo cabecera/etapas/ítems y `fase="files"` solo documentos.
Cada entrada en `detalles` añade `fases_completadas`: `detail`, `files` o ambas.
Si falla archivos después de detalle, conserva el detalle válido, omite
`documentos` y devuelve también la falta de archivos. Una respuesta válida de
archivos sin documentos sí devuelve `documentos: []`. Los ítems son una lista,
incluso cuando no hay ítems; una forma JSON incompatible no completa la fase.
El detalle requiere `uitContratoCompletoProjection` como objeto no vacío:
`{}`, una cabecera ausente/nula/vacía o listas sin cabecera van a `faltas`
como `invalid_payload`, sin marcar `detail` completada ni consultar archivos.
Las listas de etapas e ítems pueden faltar, ser nulas o vacías; cuando contienen
elementos, estos deben ser objetos. No se exige un campo específico de cabecera
que el contrato vendorizado no garantice.
El transporte no guarda pendientes ni confirma la publicación: eso corresponde
al colector. El contrato por fases se coordinó con el trabajador de la cola.

Las faltas mantienen `id` y `error`, y añaden `fase` (`detail`/`files`), `tipo`,
`status`, `intentos` y `retry_after_seconds`. Los IDs completos se conservan en
la respuesta funcional para reconciliar trabajo, nunca en los eventos.

| Respuesta | Clasificación y política |
| --- | --- |
| 403 | `forbidden`; un intento, sin reintento inmediato |
| 429 | `rate_limited`; máximo tres intentos, Retry-After largo se devuelve para reprogramación |
| 5xx | `server_error`; máximo tres intentos, respeta también Retry-After |
| Timeout | `timeout`; máximo tres intentos, status nulo si no hubo respuesta |
| Otro error de red | `network_error`; máximo tres intentos |
| Otros estados HTTP | `http_error`; un intento |
| JSON inválido/forma incompatible | `invalid_json`/`invalid_payload`; un intento |

Las esperas breves existentes son 0,5 y 1 s. Para 429 y 5xx se usa el máximo
entre esa espera y `Retry-After`, que acepta segundos enteros o fecha HTTP; un
header inválido usa la espera existente. Se espera dentro del tool únicamente
si el plazo es **menor o igual a 2 s**. Si supera 2 s, se devuelve inmediatamente
el error del intento actual, sin dormir ni enviar otro intento antes del plazo.
No se recorta el plazo a 2 s para reintentar: se conserva completo en
`retry_after_seconds`, un número de segundos desde la respuesta (o nulo sin
header válido), tanto en el evento como en la falta por ID/fase. El colector
debe reprogramar esa fase para una fecha no anterior a su recepción más ese
intervalo; puede aplicar un backoff mayor. La espera breve corresponde a la
petición fallida y no congela otras solicitudes. Tras agotar los tres intentos
también se devuelve el Retry-After del último intento.

## Eventos y métricas derivadas

Logger `seace.prod6`, nivel INFO, un objeto JSON por intento terminado o cancelado:

```json
{"event":"prod6_request","timestamp":1792759013.9,"endpoint":"/archivo/archivos-publico/listar-archivos-contrato/{id}/1","phase":"files","id_ref":"41d94d5e246c9f4b","status":403,"outcome":"forbidden","attempt":1,"latency_ms":120.5,"wait_ms":0.2,"in_flight":5,"limit":5,"retry_after_seconds":null}
```

`latency_ms` incluye lectura y validación JSON, excluye espera del semáforo y
backoff; `wait_ms` mide espera del semáforo de ese intento. `in_flight` es el
número de solicitudes activas al comenzar ese intento. `timestamp` es la hora
Unix de finalización; las duraciones usan reloj monotónico. Los endpoints están
en una lista permitida, con etiquetas `search`, `detail`, `files`; rutas nuevas
usan `other` sin registrar la ruta cruda. `id_ref` usa HMAC-SHA256 truncado con
clave aleatoria en memoria: permite correlación entre fases durante un proceso,
sin permitir un diccionario de IDs pequeños a partir del hash público.

Estos eventos permiten contar intentos, estados y solicitudes por minuto y
calcular latencia p50/p95 por endpoint/fase/resultado. No son un servidor de
métricas ni un histograma acumulado en memoria. No incluyen cuerpos, parámetros,
URLs completas, cabeceras crudas, cookies, credenciales ni texto de excepciones
HTTP. Tampoco se incluyen esos textos en `error`. Evitar registrar respuestas
funcionales completas del tool, pues contienen IDs y datos públicos originales.

## Observación pasiva en bodas (no ejecutada)

Este cambio no accedió a `bodas`, no lanzó solicitudes reales a prod6 ni pruebas
de carga, y no modifica unidades, timers, secretos ni despliegues. Si el
coordinador dispone de acceso SSH y permisos de lectura del journal, puede
consultar el estado actual con este comando read-only desde PowerShell:

```powershell
ssh bodas "systemctl show edicius-seace-scheduled.service edicius-seace-requests.service --property=ActiveState,SubState,Result,ExecMainStatus --no-pager"
```

Después de una futura versión que incluya estos eventos, observar una pasada
normal sin iniciarla ni cambiar su cadencia. El siguiente comando selecciona
exclusivamente campos permitidos de los eventos nuevos, sin imprimir otros
mensajes del journal ni variables de entorno:

```powershell
$prod6Events = ssh bodas "journalctl -u edicius-seace-scheduled.service -u edicius-seace-requests.service --since '2 hours ago' --output=cat --no-pager" | ForEach-Object {
    $eventStart = $_.IndexOf('{"event": "prod6_request"')
    if ($eventStart -ge 0) {
        $_.Substring($eventStart) | ConvertFrom-Json | Select-Object timestamp, endpoint, phase, status, outcome, attempt, latency_ms, wait_ms, in_flight, limit, retry_after_seconds
    }
}
$prod6Events | Group-Object endpoint, phase, status | Select-Object Count, Name
$prod6Events | Group-Object { [math]::Floor($_.timestamp / 60) } | Select-Object Count, Name
$prod6Events | Group-Object endpoint, phase | ForEach-Object {
    $latencies = @($_.Group.latency_ms | Sort-Object)
    [pscustomobject]@{
        EndpointPhase = $_.Name
        Requests = $latencies.Count
        P50ms = $latencies[[math]::Ceiling(0.50 * $latencies.Count) - 1]
        P95ms = $latencies[[math]::Ceiling(0.95 * $latencies.Count) - 1]
        MaxConcurrency = ($_.Group.in_flight | Measure-Object -Maximum).Maximum
    }
}
```

Si falla la lectura del journal por permisos, pedir acceso de lectura al
coordinador; no leer `collectors.env`, no cambiar permisos y no usar sudo para
iniciar servicios. La ausencia de eventos en una versión anterior es esperable.
Comparar estados/latencias por fase y ventana antes de decidir cualquier ajuste;
una pasada exitosa no demuestra una cuota segura ni la causa de los 403.

## Verificación local

Base: `origin/main` en `71426f5c0dd9f92bb9a5c7243ebe91b033f91fa4`, confirmada
con fetch antes de editar. Las pruebas nuevas se observaron fallar contra el
transporte previo (dos lotes y búsqueda alcanzaban 11 solicitudes simultáneas)
y pasar tras implementar el control compartido.

Desde `services/api`:

- `python -m pytest -q`: 1351 pasadas, 28 omitidas; siete advertencias de
  deprecación existentes de Starlette. Esta ejecución recogió la versión inicial
  de las pruebas nuevas; las comprobaciones adicionales se ejecutaron después.
- `python -m pytest tests/test_seace_transport.py -q`: 26 pasadas; una advertencia
  de Starlette del fixture global. HTTP simulado, sin solicitudes a prod6.
- `python -m ruff check . ../../scripts`: sin problemas.
- `python -m ruff format --check . ../../scripts`: 173 archivos conformes.
- `python -m compileall -q ../seace/vendor/seace_mcp/server.py`: correcto.
- `git diff --check`: correcto.

Pendiente operativo: revisar/integrar el commit y decidir por separado cualquier
despliegue o medición desde `bodas`. No se midió ni se afirma una cuota segura.

### Revisión correctiva de `d2843cc`

Ambos defectos quedaron reproducidos mediante HTTP simulado. La validación
anterior aceptaba `{}` y completaba `detail` con cabecera e ítems vacíos;
el backoff anterior pedía dos `asyncio.sleep(3600)` ante un Retry-After de una
hora, manteniendo ocupada la llamada y la pasada. Además, un 5xx ignoraba el
plazo indicado y reintentaba a los 0,5 y 1 s.

Las regresiones fallaron antes de modificar el transporte (17 fallidas,
27 pasadas) y pasaron después. Cubren proyecciones ausentes/nulas/vacías,
listas mal formadas, cabecera válida con listas vacías, Retry-After en segundos
y fecha HTTP (3 s y 1 h), 429/503, ambas fases y conservación del detalle si falla archivos.
Las pruebas de esperas breves y liberación de capacidad siguen cubriendo el
reintento dentro del tool. No se hicieron solicitudes reales a SEACE.

Validación desde `services/api`:

- `python -m pytest tests/test_seace_transport.py tests/test_seace_incremental.py tests/test_seace_publish.py -q`:
  57 pasadas; una advertencia existente de Starlette.
- `python -m ruff check . ../../scripts`: sin problemas.
- `python -m ruff format --check . ../../scripts`: 173 archivos conformes.
