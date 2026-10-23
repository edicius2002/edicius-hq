# SEACE prod6: límites y acceso automatizado en fuentes oficiales

Fecha de consulta: **23 de octubre de 2026**, zona America/Lima. Alcance: investigación documental en fuentes primarias de OECE/OSCE y SEACE. No se hicieron pruebas de carga, barridos de endpoints, cambios en producción ni intentos de eludir respuestas de acceso restringido.

## Resultado

**No se encontró una cuota HTTP publicada para el buscador público de contratos menores de prod6 en las fuentes oficiales revisadas.** Tampoco se encontró una explicación oficial específica de cuándo ese servicio devuelve 403 o 429, cuánto dura un bloqueo o qué frecuencia admite. Esto describe una ausencia de documentación localizada; **no demuestra que el servicio carezca de límites o controles**, ni permite deducir una cadencia segura.

OECE publica un buscador ciudadano sin credenciales y una API de otro portal, el de contrataciones abiertas OCDS. La existencia de esa API no acredita una API pública documentada de prod6 ni una cobertura equivalente de contratos menores. Los términos generales vigentes contienen una obligación de no sobrecargar SEACE, pero su alcance expreso se refiere a operadores y debe distinguirse del acceso ciudadano al buscador.

## 1. Términos vigentes y distinción entre operadores y ciudadanos

Fuente: [Resolución N.° 002-2025-OSCE/DSEACE, 7 de febrero de 2025](https://www.gob.pe/institucion/oece/normas-legales/6477304-002-2025-osce-dseace), identificada como vigente por la ficha oficial. Se leyó el [PDF completo de la resolución y su Anexo I](https://cdn.www.gob.pe/uploads/document/file/7640735/6477304-resolucion-000002-2025-dseace.pdf?v=1739802364), siete páginas, obtenido con respuesta 200. Consulta: 2026-10-23.

- Artículo 2 de la resolución, página 2: deroga los términos aprobados mediante Resolución N.° 000002-2022-OSCE-DSEACE. Los documentos antiguos todavía indexados no deben presentarse como los términos vigentes.
- Anexo I, numeral 1.2, página 3: declara cumplimiento obligatorio para los operadores y regula la interacción de entidades y proveedores.
- Numerales 2.1(a) y 2.1(b), página 3: tratan el certificado personal e intransferible y el acceso con una sesión, un navegador y una pestaña. **Son condiciones de acceso del operador con certificado**, no una cuota de consultas anónimas de prod6 ni evidencia de un límite global por IP.
- Numeral 2.1(h), página 4: exige abstenerse de actos que dañen, inutilicen, sobrecarguen, deterioren o impidan o limiten funcionalidades del SEACE.
- Numeral 5.2, páginas 5–6: contempla desactivación temporal o indefinida del certificado por uso inadecuado. No describe una política de bloqueo HTTP del buscador ciudadano.
- Numeral 5.3, página 6: reserva la posibilidad de modificar presentación, configuración y mecanismos de seguridad sin previo aviso. No identifica controles concretos implantados en prod6.

La lectura completa no encontró una cuota de solicitudes por segundo/minuto/día, concurrencia permitida para el buscador público, referencias a 403/429, `Retry-After`, duración de bloqueos, ni una autorización o prohibición específica denominada scraping, bots o acceso automatizado. La obligación general de evitar sobrecarga no proporciona cifras técnicas. Tampoco corresponde inferir permiso ilimitado a partir del silencio documental.

## 2. Buscador público de contratos menores

Fuente: [Gestionar Contratos Menores — OECE](https://www.gob.pe/70088), ficha oficial con último cambio indicado el 25 de mayo de 2026. Consulta: 2026-10-23; contenido recuperado mediante el índice del buscador y enlaces recuperados directamente de la página oficial.

La ficha distingue accesos de entidades, proveedores y ciudadanos. Explica que el buscador permite consultar procesos publicados libre y gratuitamente y que el ciudadano no necesita credenciales. Enlaza al [buscador público de prod6](https://prod6.seace.gob.pe/buscador-publico/). También enlaza manuales de uso.

Esa ficha no aporta un contrato de API para integraciones, cuotas HTTP, claves de desarrollador, política de reintentos o disponibilidad garantizada. **Libre acceso ciudadano no equivale a una declaración oficial de ausencia de límites de solicitudes.** La documentación revisada no permite trasladar automáticamente las condiciones de sesión del operador certificado al ciudadano anónimo.

No se localizó documentación oficial de desarrolladores, OpenAPI/Swagger, SLA o política de consumo que declare la interfaz de contratos menores de prod6 como API pública soportada para terceros. Esto no afirma que no existan endpoints utilizados por el propio navegador ni que no pueda existir documentación no indexada o disponible por otro canal.

## 3. API oficial OCDS: existencia y alcance diferente

Fuente: [Acceder al Portal de Contrataciones Abiertas de la Compra Pública — OCDS](https://www.gob.pe/52005-acceder-al-portal-de-contrataciones-abiertas-de-la-compra-publica), último cambio indicado el 25 de agosto de 2025. Consulta: 2026-10-23; descripción recuperada en el índice y enlaces verificados en el HTML oficial.

La ficha sí anuncia una sección API para usuarios avanzados, con recursos Release, Record y Files, además de descargas masivas. Enlaza al [portal OECE](https://contratacionesabiertas.oece.gob.pe/), a la [sección API bajo el dominio OSCE](https://contratacionesabiertas.osce.gob.pe/api) y a [descargas](https://contratacionesabiertas.osce.gob.pe/descargas). Se verificó la publicación de estos enlaces; no se verificó el funcionamiento actual de cada endpoint de esa API.

La [política de publicación oficial del portal](https://contratacionesabiertas.osce.gob.pe/downloads/politica_publicacion.pdf), en su contenido indexado correspondiente a la página 9, excluye contrataciones sin procedimiento de selección, entre ellas menores a 3 UIT, 8 UIT o 9 UIT. Este documento describe el alcance de esa publicación y su marco anterior; no acredita por sí solo la cobertura actual del nuevo módulo de contratos menores bajo la Ley N.° 32069. La descarga directa del PDF no pudo completarse desde este entorno: la herramienta web informó 502 y la lectura local falló por resolución DNS. La exclusión se respalda en el contenido indexado de la fuente oficial, no en una descarga íntegra actual del archivo.

Por ello, **no hay evidencia suficiente para sustituir el buscador de prod6 por esa API y asumir que conserva la cobertura de contratos menores**.

Como canal adicional de datos publicados, la ficha [Acceder al Portal de Datos Abiertos del OECE](https://www.gob.pe/14272-acceder-al-portal-de-datos-abiertos-del-osce) anuncia conjuntos descargables, incluidas órdenes de compra y servicio, con actualización mensual y exclusiones para procedimientos en marcha o con adjudicación incompleta. Consulta: 2026-10-23, mediante contenido oficial indexado. Esto tampoco documenta una API de oportunidades vigentes de prod6 ni una cuota para ella.

## 4. Respuestas 403/429: evidencia y límites

Durante esta investigación se hizo una consulta documental puntual con la herramienta web a `https://prod6.seace.gob.pe/buscador-publico/`. La herramienta informó **403 Forbidden**. No se repitieron consultas al buscador para provocar, medir o superar ese resultado. La observación es del acceso efectuado desde esta herramienta; no demuestra que todos los usuarios o transportes reciban la misma respuesta.

El resultado no proporciona una causa oficial ni un umbral: no permite atribuirlo a frecuencia, IP, geografía, reputación, sesión, CDN/WAF o una regla concreta. No se obtuvo un 429 durante esta investigación ni se midió una ventana de recuperación. Las fuentes documentales anteriores no especifican el tratamiento de ninguno de esos códigos para prod6.

También hubo respuestas 418 de acceso restringido al consultar algunas páginas de gob.pe. Se usaron sus contenidos oficiales indexados y las lecturas directas que sí habían funcionado. Estas restricciones de recuperación de documentos no se contabilizan como prueba de una política de límites de prod6.

## 5. Registro de búsqueda y cuestiones sin resolver

Se revisaron la ficha del servicio de contratos menores, la resolución y el anexo vigente, la ficha del portal OCDS, su política indexada y la ficha de datos abiertos. Se buscaron en dominios oficiales combinaciones de SEACE/prod6 con `429`, `403`, `Too Many Requests`, `rate limit`, `límite de solicitudes`, `automatizado`, `scraping`, `robot`, `API`, `Swagger`, `OpenAPI` y `s8uit-services`. No se usaron fuentes secundarias como evidencia. La búsqueda en índices no garantiza exhaustividad.

| Pregunta                                                               | Estado de la evidencia oficial revisada                                                               |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| ¿Hay cuota HTTP publicada para prod6?                                  | No localizada en estas fuentes; existencia y valor de límites operativos desconocidos.                |
| ¿Qué concurrencia o cadencia es segura?                                | No determinada; no se deduce una cifra de las observaciones.                                          |
| ¿403 significa exceso de solicitudes?                                  | No hay explicación oficial localizada que lo establezca para prod6.                                   |
| ¿Cuándo devuelve 429 y cómo reintentar?                                | No hay política específica localizada ni observación de 429 en esta revisión.                         |
| ¿Los términos impiden sobrecargar SEACE?                               | Sí, numeral 2.1(h), dentro del documento cuyo alcance expreso son operadores.                         |
| ¿Hay API oficial de datos de contratación?                             | Sí, anunciada para el portal OCDS; no demuestra una API pública soportada de contratos menores prod6. |
| ¿La API OCDS cubre todo lo que busca el colector de contratos menores? | No acreditado; la política indexada contiene exclusiones relevantes.                                  |

Para resolver esos puntos faltaría una especificación oficial del servicio de prod6 o una respuesta expresa de OECE sobre integraciones de terceros, cuotas, concurrencia, cobertura y manejo de rechazos. Esta investigación no contactó a terceros ni modifica la configuración del colector.
