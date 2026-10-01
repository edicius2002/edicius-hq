# Histórico USD/PEN en Raspberry Pi

> Ver la [validación posterior de 30 fuentes y canales](usd-pen-validation.md), con pruebas desde la Pi y distinción entre referencias diarias y cotizaciones comerciales.

Análisis del 29 de septiembre de 2026. Recomendación técnica; no implementa ni activa un colector. Se revisaron el código y los runbooks del checkout, sin inspeccionar la Pi en producción.

## Recomendación

Es viable. Usaría la API oficial del BCRP desde Python/httpx en la Pi, con carga inicial del histórico y actualización mediante systemd. La API documenta JSON, consultas por rango y hasta diez series de una misma frecuencia sin iniciar sesión. [Contrato oficial](https://estadisticas.bcrp.gob.pe/estadisticas/series/ayuda/api).

Recolectaría cuatro series diarias, conservando sus identidades:

| Serie       | Significado                  | Uso propuesto              |
| ----------- | ---------------------------- | -------------------------- |
| `PD04637PD` | Interbancario, compra        | Referencia de mercado      |
| `PD04638PD` | Interbancario, venta         | Referencia de mercado      |
| `PD04639PD` | Sistema bancario SBS, compra | Referencia bancaria diaria |
| `PD04640PD` | Sistema bancario SBS, venta  | Referencia bancaria diaria |

Las cuatro figuran desde el 2 de enero de 1997 y expresan soles por dólar. La selección del gráfico debe identificar la serie; un promedio compra/venta sería un cálculo propio etiquetado como tal. [Catálogo BCRP](https://estadisticas.bcrp.gob.pe/estadisticas/series/diarias/tipo-de-cambio).

Para decidir cuánto recibir al cambiar dólares, haría después una captura separada de cotizaciones de la casa de cambio que realmente se utilice. Las series oficiales diarias no acreditan una oferta ejecutable ni reconstruyen precios intradía. La viabilidad de ese segundo colector depende de la fuente concreta y todavía no se ha comprobado.

## Cómo encaja con lo existente

| Referencia del repo                                                                                              | Hallazgo                                                                                                  | Aplicación a USD/PEN                                                                                         |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [ADR 0004](ADRs/0004-pi-collectors-supabase-data-plane.md)                                                       | La Pi realiza la adquisición; el navegador consulta Supabase con identidad de propietario                 | Mantener ese recorrido; no exponer una API pública en la Pi                                                  |
| [Sentiment](../scripts/sentiment-collect.py)                                                                     | HTTP con `httpx`, ejecución acotada, bloqueo de proceso y registro de resultado en `collector_runs`       | Es la plantilla principal para un colector diario                                                            |
| [Timer Sentiment](../ops/pi/systemd/edicius-sentiment.timer)                                                     | Cada cuatro horas, recuperación tras apagados y variación de 30 segundos                                  | Reutilizar el mecanismo con horarios explícitos de Lima                                                      |
| [X](../services/api/app/services/tweet_replica.py)                                                               | JSONL local y cursor confirmado después de escribir en Supabase                                           | Reutilizar el patrón de pendientes para tolerar cortes                                                       |
| [Airfare](ADRs/0003-airfare-supabase-read-store.md) y [ADR 0004](ADRs/0004-pi-collectors-supabase-data-plane.md) | Archivo histórico conservado, réplica indexada y reenvíos seguros                                         | Conservar evidencia y hacer escrituras idempotentes; su arquitectura completa es mayor que la necesaria aquí |
| [CollectorCloud](../services/api/app/services/collector_cloud.py)                                                | `market_quotes` reemplaza por propietario/símbolo; `market_bars` es una caché reemplazable según ADR 0004 | Crear una tabla histórica específica para FX                                                                 |

El proceso propuesto no necesita Chromium, sesión de X, GPU ni Node. Python y httpx ya forman parte del entorno del repo. La carga adicional prevista es pequeña por el volumen y la cadencia, pero no se midieron CPU, memoria ni carga actual de la Pi. El [runbook](pi-collectors-runbook.md) contempla Debian ARM64 y Python 3.12/3.13.

## Cadencia e histórico

1. **Carga inicial:** desde 1997 o desde la fecha que interese, por bloques anuales, en secuencia y con checkpoint por bloque confirmado. Validar la cobertura de cada respuesta antes de avanzar. Unos treinta bloques cubrirían el período completo, sujeto a la respuesta real del proveedor.
2. **Actualización:** inicialmente a las 09:00, 18:00 y 23:00 de `America/Lima`, todos los días. Son horarios operativos propuestos, no horarios oficiales de publicación. Permiten recoger publicaciones tardías con tres consultas diarias agrupando las cuatro series.
3. **Reconciliación:** consultar nuevamente los últimos treinta días para detectar correcciones. Si hubo una interrupción larga, partir del checkpoint pendiente aunque sea anterior a esa ventana. Reconciliar períodos antiguos periódicamente si interesa detectar revisiones de largo plazo.
4. **Recuperación:** timer con `Persistent=true`, arranque diferido y un bloqueo que también cubra ejecuciones manuales. El timer recupera una ejecución; el colector debe recuperar todos los períodos pendientes.
5. **Fallos:** timeout, pocos reintentos con espera creciente y respeto de `Retry-After`. Conservar pendientes locales hasta confirmación de Supabase; diferenciar captura terminada de sincronización terminada.

Sentiment actualmente llama a `begin_run` antes de consultar la fuente y termina si Supabase no está disponible. Para que FX siga capturando durante una caída de Supabase, el registro local de ejecución y pendientes debe poder funcionar antes de ese paso. Copiar el script literalmente no lograría esa continuidad.

## Datos que conservar

Una tabla propuesta `fx_daily_rates` tendría `owner_id`, `provider`, `series_code`, `base_currency=USD`, `quote_currency=PEN`, `rate_date`, `rate`, `first_observed_at`, `last_observed_at` y una referencia o hash de la respuesta original.

- Identidad: `(owner_id, provider, series_code, rate_date)`; repetir una descarga no debe duplicar puntos.
- Precisión: `Decimal` en Python y `numeric` en Postgres, manteniendo precisión de origen.
- Fechas: `rate_date` es la fecha publicada para el dato; los tiempos de captura se guardan en UTC. No inferir una hora de publicación a partir de la descarga.
- Revisiones: actualizar el valor vigente conservando el anterior en un registro de revisiones cuando cambie. Una descarga del pasado muestra la versión actualmente publicada; no recupera versiones antiguas que nunca se capturaron.
- Ausencias: `n.d.` significa dato no disponible. No guardarlo como cero, no sobrescribir un valor válido con ese marcador y no fabricar observaciones para fines de semana o feriados. Cualquier arrastre visual del último valor debe quedar identificado.
- Frescura: mostrar por separado último intento, última captura válida y fecha del dato. Una ejecución exitosa puede encontrar exactamente el mismo dato publicado.
- Retención: conservar el histórico; no aplicarle el vencimiento de la caché de Investing. Supabase sería el archivo normalizado y la Pi conservaría pendientes de envío y evidencia local según una política explícita de respaldo.

Con aproximadamente 250 días con datos al año y cuatro series, el orden de magnitud es 1.000 valores/año y 30.000 en treinta años. Es una estimación de filas, no una medición ni una cuota de almacenamiento; versiones, índices y respuestas originales suman espacio.

## Fuentes y prueba de acceso

La [investigación de fuentes](usd-pen-sources.md) contiene enlaces oficiales y las pruebas HTTP. Un GET público de las cuatro series para septiembre de 2026 respondió HTTP 200 y JSON de 2.192 bytes; otro para enero de 1997 también respondió HTTP 200. Se probaron desde el entorno de trabajo, no desde la Raspberry Pi.

La respuesta contiene fechas como `01.Set.26`, valores numéricos como cadenas y valores `n.d.`. La última fecha solicitada puede estar presente sin datos, por lo que seleccionar simplemente el último elemento produciría un resultado incorrecto.

En la consulta del 29 de septiembre, las cuatro series tenían como último dato válido el 25 de septiembre; los períodos del 28 y 29 estaban sin datos. La [página SBS](https://www.sbs.gob.pe/app/pp/SISTIP_PORTAL/Paginas/Publicacion/TipoCambioPromedio.aspx) sí mostraba el 28 de septiembre. Esto evidencia una posible demora de BCRPData respecto de SBS, sin establecer un retraso fijo. Si se exige el cierre del mismo día, conviene evaluar captura directa SBS además del histórico BCRP y conservar la procedencia de cada observación.

SUNAT merece una serie separada si se necesita su convención de fechas: su página señala que publica el cierre SBS del día anterior. No usarla para completar huecos del BCRP sin alinear significado y fecha. [Consulta SUNAT](https://e-consulta.sunat.gob.pe/cl-at-ittipcam/tcS01Alias).

La disponibilidad puntual no demuestra disponibilidad continua. Antes de activar el servicio se debe comprobar el mismo GET desde la Pi. No se encontró una cuota numérica de peticiones ni una garantía de disponibilidad en el contrato consultado; los horarios propuestos son una decisión conservadora de operación.

## Alcance de una implementación posterior

- Adaptador BCRP y modelos de FX; comando `scripts/fx-collect.py` para carga inicial y actualización.
- Persistencia de pendientes, carga idempotente y migración de tablas, permisos y lectura por propietario.
- Ampliar listas permitidas de `CollectorCloud` y la restricción SQL de `collector_runs` para reconocer `fx`.
- Añadir servicio/timer e incluirlos en instalación, despliegue, verificación, salud y rollback de `ops/pi`; sus listas de unidades actuales son explícitas.
- Lectura desde Supabase y gráfico por fecha/serie, con fecha de referencia visible.
- Verificar parser con fechas españolas y `n.d.`, reenvío sin duplicados, correcciones, reinicio a mitad de carga y caída temporal de Supabase. Son los riesgos concretos del colector propuesto.

No hace falta modificar los colectores existentes para demostrar acceso al BCRP. La activación posterior requeriría probar la nueva unidad en la Pi y observar capturas reales. Este análisis no verifica el estado de despliegue de los colectores actuales.
