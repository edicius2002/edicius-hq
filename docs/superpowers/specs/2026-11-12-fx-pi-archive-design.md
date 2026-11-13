# Histórico de divisas en la Pi

## Intención

La Raspberry Pi debe conservar el histórico normalizado de observaciones USD/PEN como fuente duradera. Neon debe conservar una réplica completa para las consultas de la web. Hoy `fx/outbox.sqlite` solo guarda observaciones pendientes y las elimina al recibir el acuse de Neon; por eso Neon es la única copia histórica. El cambio no debe interrumpir la captura durante una caída de Neon.

## Objetivos y límites

- Cada observación aceptada se confirma primero en el SQLite de la Pi y después se intenta replicar a Neon. El acuse elimina la entrada de la cola, nunca la entrada histórica.
- El histórico actual de Neon, desde el 1 de octubre de 2026, se importa a la Pi antes de declararla fuente principal. No se borran filas de Neon durante esta migración.
- Un comando de reproducción puede reconstruir `fx_observations` desde la Pi con upserts idempotentes. La web continúa leyendo las mismas RPC de Neon.
- La política previamente elegida para evitar registros repetidos conserva los cambios de precio y un latido periódico de una fuente sana. La salud de una fuente averiada no se simula con observaciones nuevas.
- No se archivan HTML, respuestas HTTP, cookies ni secretos. Los datos persistidos son las observaciones normalizadas y el estado operativo existente.

## Enfoques

- **Elegido: ampliar `fx/outbox.sqlite`.** Una tabla `observations` permanente usa la misma identidad `(owner, source, effective, observed)` que `fx_observations`; `Store.save()` escribe histórico, cola y estado de fuente en una sola transacción. Aprovecha el SQLite existente con WAL y `synchronous=FULL`.
- Crear un JSONL permanente como el de tarifas. Requeriría coordinar dos almacenes locales y recuperar líneas parciales además de la transacción que ya mantiene la cola y el estado. No aporta una ventaja necesaria aquí.
- Conservar Neon como única copia duradera. No cumple la decisión del propietario.

## Comportamiento

El módulo `Store` posee la escritura local, el listado paginado de observaciones y la cola de réplica. Una captura con clave repetida no añade otro registro. Un fallo de Neon deja la observación en `observations` y `outbox`; el siguiente pase la reintenta. El acuse confirma exactamente las claves aceptadas y solo borra `outbox`. Una falla de escritura local impide enviar esa observación a Neon y se informa como fallo de adquisición.

Para las fuentes comerciales, una lectura exitosa con precio o contexto distinto se guarda inmediatamente. Si todo sigue igual, se guarda una observación de latido al cumplirse diez minutos desde la última observación persistida, comparando con ella. Diez minutos deja margen bajo el umbral actual de quince minutos con el que la web marca una cotización comercial como obsoleta. Una fuente que no respondió no genera latido. Las referencias BCRP/SBS siguen conservando cada revisión de fecha efectiva o contexto; su política de frescura existente permanece. Los registros históricos ya almacenados en Neon se importan íntegros, incluidos los repetidos; la reducción afecta solo a capturas futuras. Por ello los gráficos 1D/7D tendrán menos puntos horizontales nuevos, aunque mantendrán cada cambio de precio y la indicación de frescura; no se promete igualdad punto por punto con la cadencia anterior.

## Migración y recuperación

Primero se despliega la tabla permanente y se copian en ella las filas que aún estén en la cola. Desde ese momento toda captura nueva queda en ambas tablas locales de forma atómica. Después, una importación paginada desde Neon introduce las filas históricas con `INSERT OR IGNORE`, validando el esquema y propietario. Un breve corte final del temporizador permite vaciar la cola, importar cualquier fila restante y comparar por fuente el número de claves y un digest de claves más contenido normalizado. Solo tras esa comparación se declara la Pi fuente principal y se reanuda el temporizador.

La reproducción desde la Pi recorre `observations` por clave estable y hace upsert a Neon en lotes con cursor reanudable; jamás trunca la tabla remota. Un comando de exportación de respaldo del SQLite activo usa la API de backup de SQLite, no copia solo el archivo mientras WAL está abierto. Este proyecto no configura una tercera copia automática porque no se ha designado un destino fuera de la Pi. Neon sigue siendo una segunda copia consultable si falla la tarjeta de la Pi, con la salvedad de cualquier observación aún pendiente de replicar.

## Verificación

- Una caída de Neon conserva el histórico y la cola; un reintento vacía únicamente la cola.
- Un reinicio o una importación repetida no duplica observaciones ni cambia contenidos existentes.
- La comparación Pi–Neon incluye todas las fuentes, claves y valores antes y después de reanudar el colector.
- Las RPC y la web mantienen el histórico anterior y muestran los cambios futuros y latidos previstos; una fuente fallida aparece obsoleta. La menor cantidad de puntos planos futuros es el cambio visible aceptado por la política de reducción de registros.
- La documentación de autoridad se actualiza para declarar la Pi fuente histórica de FX y Neon réplica.

## Decisiones del implementador

Elegir nombres de comandos y organización interna de los lotes sin cambiar la identidad de observaciones ni exponer credenciales. Preparar la migración para el despliegue fijado de la Pi; no ejecutar el backfill o cambiar producción sin comprobar los conteos y la integridad en ese entorno.
