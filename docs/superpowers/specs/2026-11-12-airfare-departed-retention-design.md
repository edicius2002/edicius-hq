# Retención de tarifas por fecha de salida

## Intención

La Pi conserva el detalle completo de tarifas mientras el vuelo aún no sale; Neon mantiene una copia para consultas rápidas. Una vez vencida la fecha de salida, se retiran de **ambos** almacenes las ofertas, capturas y comprobaciones detalladas de ese vuelo. Permanecen resúmenes numéricos compactos que conservan los mínimos, máximos y medianas de `How the price moved`. `Flights seen` muestra todos los vuelos vigentes y deja de mostrar los ya salidos. Esta regla usa la **fecha de salida**, nunca la fecha en que se observó un precio: una observación antigua de un vuelo futuro sigue siendo necesaria.

El archivo actual de la Pi es append-only y el sincronizador hace upsert sin borrar filas remotas. Por ello esta política cambia expresamente el contrato del archivo y requiere una poda coordinada, no solo un `DELETE` periódico en Neon.

## Objetivos y límites

- Preservar todas las observaciones y ofertas de vuelos vigentes, aunque se hayan capturado hace semanas. Mantener intactos sus valores y la lista completa de vuelos en `Flights seen`.
- Preservar exactamente los valores diarios ya mostrados de mínimo, máximo, mediana, número de observaciones, días sin oferta y referencia del proveedor. Conservar también la referencia `Usually` mediante un resumen por fecha de salida vencida.
- Eliminar el detalle de vuelos vencidos tanto del archivo operativo de la Pi como de las tablas de Neon; una sincronización posterior no debe recrearlo. Los resúmenes autorizados son la única retención de precios de esos vuelos.
- Mantener las preferencias de vigilancia del propietario como documento propio. Un mes vencido puede conservar su gráfico resumido y debe indicar que su lista detallada de vuelos expiró; no se modifica silenciosamente la configuración del usuario.
- Una poda incompleta o una desconexión no puede dejar una réplica presentada como verificada. No se ejecuta un borrado masivo sin una vía de reanudación y comparación de manifiestos.

## Enfoques

- **Elegido: resumen exacto más poda por salida.** Antes de retirar un vuelo se acumulan frecuencias de sus precios por ruta, mes de salida y día de observación; la mediana exacta se calcula sobre las frecuencias archivadas y las observaciones vigentes. Se conservan las comprobaciones sin oferta y la serie diaria del proveedor, y una mínima por fecha de salida para `Usually`. Los detalles vencidos desaparecen de Pi y Neon.
- Guardar solo un mínimo, máximo y mediana fijos por día. Ocupa menos, pero no permite recalcular exactamente la mediana cuando aún entran observaciones de otros vuelos del mismo mes. No satisface la elección del propietario.
- Podar solo Neon o conservar todo el detalle en ambos almacenes. La primera opción incumple el borrado en ambas fuentes; la segunda no libera el espacio buscado.

## Regla de vencimiento

El vuelo con `flightDate = D` es elegible cuando el día UTC llega al menos a `D + 2 días`. Este margen conserva el vuelo durante todo su día local de salida incluso en los husos extremos, evita borrarlo antes de despegar y permite una ejecución diaria determinista en la Pi y Neon. La poda y las consultas comparten un único corte monotónico registrado; una ejecución tardía puede ponerse al día sin saltarse fechas. La interfaz puede señalar antes que la fecha ya pasó, pero el detalle no se retira antes de cumplir el margen.

## Resúmenes y lectura

La Pi guarda una partición resumida e inmutable por fecha de salida vencida; Neon recibe la misma partición con clave idempotente. Cada partición contiene, por ruta y mes de salida, las frecuencias de `cheapest_price` por día de observación, la cantidad de capturas sin oferta y las frecuencias de precios de referencia por `price_date`. Un valor y su frecuencia ocupan una entrada; no se guardan ofertas, aerolínea ni respuesta original. La mínima por fecha de salida permite reconstruir la mediana de las mínimas que alimenta `Usually`. Los contadores de salud y la última captura que se muestran para el mes se conservan como agregados si provienen de vuelos vencidos.

Las proyecciones mensuales combinan las particiones vencidas con las filas vigentes para calcular el mismo mínimo, máximo, mediana y conteo diarios que antes de la poda. La prueba de equivalencia compara el JSON de la proyección antes y después de compactar una mezcla de vuelos vencidos y futuros. `fare_flight_projections`, `latestBoards`, `currentBoards`, el gráfico de salidas y `Flights seen` se reconstruyen solo con vuelos vigentes. Un mes íntegramente vencido muestra su gráfico histórico resumido y una indicación explícita de que no quedan vuelos consultables. El horizonte de calendario nunca anuncia precios de fechas ya vencidas.

## Poda coordinada

1. Desplegar primero un filtro de ingreso y sincronización que rechace fechas de salida anteriores al corte confirmado. Así un reinicio o una relectura desde el byte cero no resucita datos caducados.
2. Con una ejecución exclusiva de los procesos Airfare, calcular y verificar las particiones resumidas de las fechas que vencen. Publicarlas en Neon antes de borrar detalle; las claves hacen reintentable la operación. Un registro de fase y corte distingue `summarized`, `compacted`, `pruned` y `verified`.
3. Compactar los JSONL de la Pi por ruta mediante archivo temporal, `fsync` y sustitución atómica, manteniendo las filas futuras. Tratar por separado snapshots, baseline y checks de tablero. Las curvas de calendario contienen precios de varias fechas dentro de una sola captura: retirar solo las fechas vencidas, conservar las futuras y actualizar identidad y ventana. Regenerar metadatos derivados, posiciones, cursores y manifiestos.
4. Usar una función SQL privilegiada y acotada al corte para borrar en Neon los detalles vencidos y refrescar proyecciones; no otorgar `DELETE` general al rol de servicio. Podar las proyecciones de vuelos vencidos, conservando el resumen de precio. La operación es idempotente y registra progreso por fecha.
5. Comparar manifiestos y claves de todos los datasets restantes con el verificador Airfare. Reanudar los procesos solo después de una réplica coherente. En caso de fallo, reanudar desde el registro de fase sin duplicar resúmenes ni permitir nuevas filas vencidas.

Las carpetas antiguas de reconciliación y los ejemplos de deriva pueden contener detalles vencidos fuera de `/fares`. Antes de declarar terminada la retención, clasificarlos y retirar las copias vencidas tras validar la fuente operativa; no dejarlos como excepción oculta. Los checks de calendario, que no tienen una fecha de vuelo individual, conservan su función de salud y requieren una política de edad separada, fuera de esta poda.

## Capacidad y verificación

Hoy los vuelos con fecha pasada representan aproximadamente 17.700 snapshots, 15.600 puntos de referencia y 29.700 checks de tablero: unos **52 MB** estimados en Neon antes de descontar el resumen, más proyecciones vencidas por medir. El borrado puede reutilizar páginas sin reducir inmediatamente el tamaño lógico; esta entrega incluye medirlo después de podar y ejecutar una reescritura segura de tablas o índices si hace falta para recuperar capacidad efectiva, con ventana operativa y verificación posterior. Esta entrega también incluye quitar el índice no único de baseline cubierto por otro único y sustituir el índice de checks de calendario por uno parcial, tras verificar los planes de consulta; el ahorro conjunto estimado es de 14 MB sin cambiar datos. Este ahorro no garantiza permanecer bajo el límite Free de 1 GB: se conservan todas las observaciones de vuelos futuros, que son la mayoría. La verificación de despliegue mide el tamaño lógico y deja umbrales operativos de revisión al 80 % y acción al 90 % de 1 GB en el runbook. Una notificación automática externa o en la web queda fuera de esta entrega porque no se ha elegido un canal; no se presenta el control manual como una alerta automática.

Las pruebas cubren medianas exactas con precios repetidos y número par de observaciones, mezcla de vuelos vencidos y futuros en el mismo mes, calendarios con fechas mezcladas, caída entre cada fase, reimportación incremental desde cero, idempotencia, manifiestos Pi–Neon y ausencia de vuelos vencidos en `Flights seen`. Actualizar el ADR de Airfare: el detalle deja de ser append-only indefinido y pasa a una retención por fecha de salida con resúmenes duraderos.

## Decisiones del implementador

Elegir el formato físico compacto de las particiones y los nombres de las funciones, siempre que permita medianas exactas, claves estables y recuperación tras fallo. Mantener el despliegue y la verificación separados del cambio de esquema; nunca borrar producción antes de ejecutar la comparación de equivalencia en una rama de Neon y en una copia de los archivos de la Pi.
