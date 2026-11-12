# Migración de Edicius HQ a Neon: datos, lecturas y corte

**Estado:** análisis y propuesta; no ejecuta una migración ni autoriza borrar el archivo Airfare.

**Fecha de referencia:** 2026-11-11.

**Nota de estado (2026-11-12):** La migración ya se completó. La producción
actual almacena los datos en Neon y en la Pi; Supabase no contiene datos de
producción activos. El resto de este documento conserva el análisis previo al
corte. Para el estado actual y el siguiente mantenimiento, consulta
[`airfare-retention.md`](airfare-retention.md) y
[`pi-collectors-runbook.md`](pi-collectors-runbook.md).

**Objetivo:** restablecer la aplicación sin pagar y mantener el crecimiento de Postgres dentro del plan gratuito.

## Situación actual

Supabase restringe todos los servicios de la organización con HTTP 402 por tamaño de base. El panel mostró `edicius-hq` en 666,62 MB frente al límite de 0,5 GB. La migración `20261110000000_operational_retention.sql` ya está aplicada, pero el despliegue de la Pi se revirtió al fallar su verificación contra Supabase; el temporizador de retención no quedó activo y no se han eliminado filas de producción. La rama `feat/operational-data-retention` contiene esa migración y la compactación de manifiestos para sincronizaciones rutinarias, aún no activa en la Pi.

Neon Free ofrece [1 GB de Postgres por proyecto](https://neon.com/blog/neon-free-plan-1-gb-per-project). Copiar la base actual sin cambiar el flujo dejaría poco margen. **Objetivo inicial propuesto:** menos de 400 MB en Neon, con medición de crecimiento diario y retención automática. Es una meta de diseño, no un tamaño ya comprobado.

Los tamaños siguientes proceden de `supabase inspect db table-sizes --linked` el 11 de noviembre. Incluyen índices; las filas son estimaciones del catálogo y el tamaño recuperable tras borrar datos debe medirse de nuevo. No equivalen a bytes escritos por cada consulta del proveedor.

| Grupo                   | Tabla                     | Tamaño aproximado | Filas estimadas | Papel actual                                |
| ----------------------- | ------------------------- | ----------------: | --------------: | ------------------------------------------- |
| Airfare                 | `fare_snapshots`          |            170 MB |         106.159 | Observaciones con JSON completo             |
| Airfare                 | `fare_baseline_points`    |             98 MB |         158.564 | Historial diario del proveedor              |
| Airfare                 | `airfare_import_runs`     |             91 MB |           4.925 | Manifiestos y estado de sincronización      |
| Airfare                 | `fare_checks`             |             85 MB |         153.690 | Resultado de cada comprobación              |
| Airfare                 | `fare_flight_projections` |             58 MB |          40.299 | Filas listas para la tabla de vuelos        |
| Investing y solicitudes | `collector_requests`      |             54 MB |           1.821 | Cola, progreso y resultados JSON            |
| FX                      | `fx_observations`         |             27 MB |          76.270 | Cotizaciones e historial                    |
| SEACE                   | `seace_records`           |             21 MB |           9.948 | Registros mostrados en la página            |
| Investing               | `market_bars`             |             11 MB |             229 | Última serie por símbolo, período y horario |
| Sentiment               | `sentiment_snapshots`     |            9,8 MB |             167 | Snapshots históricos completos              |

Las seis primeras tablas suman aproximadamente 556 MB. El mayor efecto inmediato vendría de controlar `airfare_import_runs`, `collector_requests` y `fare_checks`; comprimir únicamente respuestas de las páginas no soluciona la cuota.

## Qué escribe cada fetch y qué lee cada página

### Airfare

El programador intenta una pasada cada 15 minutos y sincroniza a los minutos `:07` y `:37`. La simulación anterior calculó hasta 6.294 solicitudes diarias al proveedor; **no es el número de filas nuevas**. Cada consulta de fecha registra un `check`; solo un cambio deja un `fare_snapshot`. El baseline se incorpora al primer encuentro de una fecha de vuelo y luego se fusiona por clave natural. El archivo JSONL de la Pi sigue siendo la autoridad y la base es su réplica indexada, según [ADR 0004](ADRs/0004-pi-collectors-supabase-data-plane.md).

La sincronización incremental sube las filas nuevas en lotes de hasta 250 y crea/actualiza una fila en `airfare_import_runs`. Hoy replica el JSON original además de columnas indexadas. Las proyecciones mensuales y de vuelos se reconstruyen en Postgres desde snapshots, baseline y checks; por eso no es seguro eliminar esas tablas y conservar intacto el SQL de reconstrucción.

La pantalla habitual consulta una proyección del mes seleccionado, otra por cada mes observado, calendario y páginas de **10 vuelos**. Cuando falta una proyección, recurre a la lectura completa del historial del mes, paginada hasta 250 registros por respuesta. Las consultas visibles se refrescan aproximadamente cada 60 segundos. El historial completo es un respaldo real y requiere sustituto antes de retirar datos de la réplica.

Referencias: [colector](../services/api/app/services/fare_collector.py), [sincronizador](../services/api/app/services/airfare_sync.py), [proyecciones SQL](../supabase/migrations/20261106000000_airfare_projection_io.sql), [lectura de la página](../apps/web/src/features/airfare/hooks/useFareProjections.ts), [paginación de historial](../apps/web/src/features/airfare/data/airfareHistoryPages.ts).

### Investing

La página lee cotizaciones por conjunto de símbolos y una serie guardada para el gráfico. También precarga variantes guardadas para otros símbolos en lotes de tres. Si la serie está vencida, crea una solicitud `market-bars`: el worker escribe la serie en `market_bars` y vuelve a guardar el mismo conjunto de barras dentro de `collector_requests.result`. El navegador espera la respuesta mediante sondeo y eventos Realtime. `market_bars` se sobrescribe por clave y permanece acotada por símbolos y períodos; las solicitudes terminadas son la parte que crece.

Propuesta: devolver en la solicitud un identificador o versión de la serie guardada y leer el resultado una sola vez desde `market_bars`; conservar la solicitud solo el tiempo necesario para que el cliente reciba su estado. La búsqueda de símbolos puede seguir guardando un resultado pequeño y temporal. Hay que verificar las carreras entre escritura de barras, finalización y lectura del navegador.

Referencias: [worker](../services/api/app/services/market_worker.py), [cliente](../apps/web/src/features/investing/data/supabaseMarket.ts), [precarga](../apps/web/src/features/investing/chart/useAssetPreload.ts).

### FX, SEACE, Sentiment y páginas pequeñas

| Página o colector              | Escritura / lectura                                                                                                                                                        | Reducción propuesta                                                                                                                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FX                             | Los tipos comerciales se buscan cada cinco minutos; `1D` y `7D` muestran observaciones, mientras `1M`, `1Y` y `ALL` ya entregan un punto diario.                           | Guardar detalle reciente y resumir el antiguo por día. Preservar revisiones de fuentes de referencia BCRP/SBS.                                                                                            |
| SEACE                          | Sube solo registros nuevos o modificados, pero cada fila incluye el payload de la vista. La página trae 50 filas por defecto y precarga varias vistas/páginas adicionales. | Reducir precargas para bajar transferencia; medir campos realmente usados antes de recortar el payload. La precarga no aumenta almacenamiento.                                                            |
| Sentiment                      | Guarda un snapshot completo cada cuatro horas; la página solo consulta el más reciente.                                                                                    | Conservar una ventana corta en Postgres y archivar históricos fuera de Neon si se requieren. Esto modifica la retención de un conjunto descrito como durable en ADR 0004 y exige actualizar esa decisión. |
| Dashboard, Finance, Greenlight | Tweets visibles de las últimas 48 horas, documentos del usuario y documentos financieros.                                                                                  | Mantenerlos: ocupan poco y contienen estado del usuario. No son el primer objetivo de reducción.                                                                                                          |

Referencias: [FX SQL](../supabase/migrations/20260929000000_fx_observations.sql), [SEACE](../services/seace/publish.py), [página SEACE](../apps/web/src/features/seace/SeacePage.tsx), [Sentiment](../apps/web/src/features/sentiment/data/supabaseSentiment.ts).

## Modelo de datos propuesto en Neon

1. **Conservar sin pérdida:** documentos de usuario, configuración, exclusiones, dueños, datos financieros, registros SEACE necesarios y el archivo Airfare autoritativo en la Pi. La migración debe mantener la identidad del dueño o aplicar un mapa de identidades comprobado.
2. **Conservar como lecturas rápidas:** proyecciones de Airfare, últimas cotizaciones y barras de Investing, puntos FX recientes y diarios antiguos, y último snapshot de Sentiment. Mantener tablas e índices que sostengan los filtros y la paginación existentes.
3. **Acotar operacionalmente:** `airfare_import_runs`, `collector_requests`, `collector_runs` y checks antiguos. La migración ya aplicada define siete días para ejecuciones y solicitudes terminales; no toca archivos ni proyecciones Airfare. Revisar la ventana exacta con las necesidades de diagnóstico antes de ampliarla a otras tablas.
4. **Resolver la reconstrucción de Airfare:** como las proyecciones se calculan actualmente a partir de la réplica, elegir y probar una de estas rutas antes de omitir históricos: generar y publicar proyecciones desde el archivo de la Pi, o mantener en Neon las observaciones necesarias para reconstruir todos los meses servidos. La primera ahorra más espacio, pero implica cambiar sincronizador, RPC, respaldo de lectura y verificación. No se debe tratar una proyección sin su fuente como equivalente al archivo autoritativo.

OneDrive puede guardar copias verificadas del archivo de la Pi y exportaciones de recuperación. No es el almacén transaccional de la web ni sustituye Postgres para filtros, concurrencia y RLS.

## Adaptaciones necesarias para salir de Supabase

Neon tiene una [Data API compatible con PostgREST](https://neon.com/blog/a-postgrest-compatible-data-api-now-on-neon) y [Auth administrado](https://neon.com/blog/neon-auth-branchable-identity-in-your-database), pero el proyecto está acoplado a `supabase-js`, Supabase Auth, `auth.uid()`, roles/grants, RPC, Realtime y credenciales de servicio de la Pi. La compatibilidad de protocolo no convierte el cambio en una sustitución de URL.

- **Identidad y permisos:** migrar el acceso del dueño, reautenticar la sesión, conservar o mapear `owner_id`, adaptar las políticas RLS y probar cada RPC con un usuario autorizado y otro no autorizado. No exponer una conexión Postgres privilegiada al navegador.
- **API web y Pi:** sustituir el cliente de datos y las llamadas de autenticación; adaptar `collector_cloud.py`, `airfare_supabase.py`, scripts y variables de entorno a la nueva API/credencial de servidor. Inventariar funciones SQL y extensiones antes de importar esquema.
- **Tiempo real:** los canales actuales de Supabase incluyen cambios de filas y broadcasts de mercado. [Neon Realtime está en beta y todavía no aplica RLS](https://neon.com/blog/neon-now-has-realtime); no usarlo directamente para datos privados del dueño sin una capa de autorización. Mantener temporalmente sondeo limitado o una conexión autenticada por el backend hasta verificar una alternativa. Los broadcasts de cotizaciones requieren un diseño específico.
- **Cuota de cómputo:** además del GB de almacenamiento, el plan gratis tiene límites de cómputo. Los timers de FX, SEACE, Airfare y el worker de mercado despiertan la base repetidamente; medir uso real en una rama de prueba antes del corte.

## Secuencia de migración y comprobaciones

1. **Inventariar y respaldar.** Confirmar acceso de lectura/exportación directa a la base restringida; el 402 de la Data API impide asumir que `pg_dump` funcionará. Hacer copia verificable de los datos de usuario y del archivo Airfare de la Pi. Registrar conteos y sumas de comprobación por conjunto. No incluir credenciales en Git, comandos mostrados ni informes.
2. **Crear un esquema Neon de prueba.** Importar funciones, tablas e índices que se decidan conservar; adaptar permisos y autenticación. Cargar una muestra representativa, comprobar lecturas y escrituras del navegador y de la Pi, y medir bytes por tabla y por día.
3. **Aplicar reducciones con pruebas de equivalencia.** Primero la retención operacional y la eliminación de la copia de barras en solicitudes. Después checks, FX, Sentiment y la estrategia de proyecciones Airfare. Comparar salidas de Airfare por ruta/mes, filtros de vuelos, referencias de pareja y resultados SEACE antes de omitir filas históricas.
4. **Migrar datos seleccionados.** Ejecutar importación repetible con cursores o corte de escritura, validar conteos/digests y tamaño total **por debajo de 400 MB** si la estrategia lo permite. El tamaño final y la tasa de crecimiento son condiciones de avance, no estimaciones asumidas.
5. **Cortar producción.** Desplegar cliente y Pi configurados para Neon, iniciar timers gradualmente, comprobar autenticación, páginas, solicitudes manuales y sincronización. Conservar Supabase y el archivo de la Pi sin alteraciones para rollback hasta verificar el nuevo flujo. El 402 actual significa que un rollback a Supabase no restablece servicio por sí solo.

Este plan propone cambiar el destino de la réplica y la retención de algunos conjuntos de datos. Antes de implementarlo deben actualizarse [ADR 0003](ADRs/0003-airfare-supabase-read-store.md) y [ADR 0004](ADRs/0004-pi-collectors-supabase-data-plane.md) donde hoy fijan Supabase como almacén y describen la durabilidad de cada conjunto.
