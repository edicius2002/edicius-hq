# Fuentes oficiales para un histórico USD/PEN

> Validación posterior: [matriz completa y pruebas desde Raspberry Pi](usd-pen-validation.md). Las observaciones de esta nota corresponden a la investigación inicial.

Investigación: 29 de septiembre de 2026. Alcance: fuentes y comprobaciones HTTP desde el entorno de desarrollo; no se ejecutaron pruebas en la Raspberry Pi ni se implementó un recolector. El encaje con los recolectores del repositorio se documenta en [la recomendación de arquitectura](usd-pen-recommendation.md).

## Recomendación

Usar la API pública de BCRPData como primera fuente para un histórico diario. Permite consultar series oficiales mediante HTTP y JSON, por lo que un proceso pequeño en la Raspberry Pi resulta técnicamente suficiente sin navegador. Esta última conclusión es una inferencia de arquitectura, no una medición de recursos en la Pi. [API oficial](https://estadisticas.bcrp.gob.pe/estadisticas/series/ayuda/api).

La elección depende de qué representa la tasa: guardar compra y venta SBS como referencia bancaria; añadir compra y venta interbancaria si se quiere comparar el mercado. Ninguna equivale a una oferta ejecutable de una casa de cambio. Para decidir dónde cambiar dinero haría falta un historial separado de cotizaciones comerciales, con proveedor y hora de captura.

## Series y cobertura

El catálogo diario del BCRP publica las cuatro series siguientes, todas con inicio el 2 de enero de 1997. Sus valores están expresados en soles por dólar. [Catálogo oficial](https://estadisticas.bcrp.gob.pe/estadisticas/series/diarias).

| Código      | Significado                  |
| ----------- | ---------------------------- |
| `PD04637PD` | Interbancario, compra        |
| `PD04638PD` | Interbancario, venta         |
| `PD04639PD` | Sistema bancario SBS, compra |
| `PD04640PD` | Sistema bancario SBS, venta  |

El catálogo también ofrece cortes de 11:00 y cierre de 13:30, como series diarias diferenciadas; eso no constituye un flujo de cotizaciones intradía. [Catálogo oficial](https://estadisticas.bcrp.gob.pe/estadisticas/series/diarias).

La SBS calcula sus tasas de compra y venta como promedios ponderados de operaciones reportadas por entidades financieras; publica en días útiles. Su metodología toma operaciones entre las 13:30 del día anterior y las 13:30 del día del reporte. No debe interpretarse ese corte como una hora garantizada de publicación del API. [Metodología SBS](https://www.sbs.gob.pe/app/stats/metodologia/metodologia_07_2018.pdf).

## Contrato de BCRPData

La documentación permite GET y POST, ofrece JSON y otros formatos y no exige iniciar sesión. Admite hasta diez series de la misma frecuencia por consulta. Se pueden indicar períodos inicial y final; omitirlos devuelve datos recientes, por lo que una carga histórica debe usar rangos explícitos. [Documentación API](https://estadisticas.bcrp.gob.pe/estadisticas/series/ayuda/api).

Endpoint comprobado con las cuatro series:

```text
https://estadisticas.bcrp.gob.pe/estadisticas/series/api/PD04637PD-PD04638PD-PD04639PD-PD04640PD/json/2026-09-01/2026-09-29
```

Endpoint histórico comprobado:

```text
https://estadisticas.bcrp.gob.pe/estadisticas/series/api/PD04637PD-PD04638PD-PD04639PD-PD04640PD/json/1997-01-01/1997-01-10
```

Para producción, propongo dividir la carga inicial en años y consultar una ventana móvil de 14–30 días en cada ejecución. Es una decisión de implementación para reintentos y revisiones, no un límite publicado por el BCRP.

## Resultados de las pruebas HTTP

Se hicieron GET sin credenciales mediante PowerShell desde el entorno de desarrollo. No hubo scraping de HTML ni descarga de todo el histórico.

| Consulta             | HTTP | Tamaño reportado por cliente | Tiempo de petición | Períodos devueltos |
| -------------------- | ---- | ---------------------------- | ------------------ | ------------------ |
| 1–29 septiembre 2026 | 200  | 2.192 bytes                  | 1.739 ms           | 21                 |
| 1–10 enero 1997      | 200  | 943 bytes                    | 479 ms             | 8                  |

La respuesta incluye `config.series` y `periods`, con nombres de fecha como `01.Set.26` y valores numéricos representados como cadenas. El 2 de enero de 1997 retornó, en el orden solicitado, `2.613`, `2.618`, `2.599` y `2.614`. El 1 de enero contiene `n.d.`. Las comprobaciones prueban acceso al comienzo del histórico y al rango reciente; no prueban continuidad completa de tres décadas.

Una comprobación adicional del 24–29 de septiembre confirmó que el último dato numérico del API era del 25/09; el 28/09 y 29/09 contenían `n.d.` en las cuatro series. La [página directa SBS](https://www.sbs.gob.pe/app/pp/SISTIP_PORTAL/Paginas/Publicacion/TipoCambioPromedio.aspx), consultada en la misma investigación, mostraba compra `3.432` y venta `3.440` para el 28/09. Esto evidencia que BCRPData puede estar retrasado respecto de la publicación directa SBS; no establece un retraso fijo.

Consecuencias para el parser y almacenamiento:

- Parsear fechas españolas explícitamente y resolver el siglo con el rango solicitado; no depender del idioma del sistema.
- Interpretar `n.d.` como ausencia, nunca como cero. La última fila solicitada no necesariamente es el último dato disponible.
- Validar cantidades y orden de series y conservar precisión decimal; `config.series[].dec` no indica que los valores ya estén redondeados.
- Guardar fecha económica separada de la hora de captura y mostrar al usuario la fecha del último dato válido.
- Repetir consultas sin duplicar registros: clave por serie y fecha. Las revisiones pueden actualizar esa fila; conservar versiones solo si el producto necesita auditoría de revisiones.

Estas son recomendaciones basadas en las respuestas observadas, no garantías de permanencia del formato.

## Alternativas: SBS y SUNAT

SBS ofrece [consulta por fecha](https://www.sbs.gob.pe/app/pp/SISTIP_PORTAL/Paginas/Publicacion/TipoCambioPromedio.aspx) y [consulta histórica](https://www.sbs.gob.pe/app/stats/seriesH_TC-CV-Historico.asp). Su [guía de series](https://www.sbs.gob.pe/app/pp/serieshistoricas2/guias/Tipo%20de%20Cambio.pdf) documenta consultas por rango, moneda y exportación Excel. No identifiqué en las fuentes revisadas una API JSON pública documentada equivalente a BCRPData. Automatizar el formulario es una alternativa si la frescura de BCRP resulta insuficiente; requeriría comprobar el flujo de formulario y mantenerlo.

SUNAT ofrece una [consulta mensual oficial](https://e-consulta.sunat.gob.pe/cl-at-ittipcam/tcS01Alias). La propia página aclara que publica el cierre SBS del día anterior y que, cuando falta una publicación, se utiliza el dato del día inmediato anterior. Por ello, no deben unirse datos SUNAT y SBS usando únicamente la misma fecha de calendario. La fecha de vigencia y la fecha del cierre son conceptos diferentes. Si el objetivo es tributario, conservar esa semántica explícitamente y verificar la regla del uso concreto.

## Frecuencia, condiciones e incertidumbres

La actualización de las series es diaria; conviene permitir consultas adicionales para recuperar publicaciones tardías. La recomendación consolidada del repo propone tres consultas al día, cuyos horarios deben ajustarse al observar la disponibilidad real. Consultar cada pocos minutos no produce nuevas observaciones de una serie diaria. La frecuencia propuesta es operativa, no una obligación del proveedor.

Las [condiciones de BCRPData](https://estadisticas.bcrp.gob.pe/estadisticas/series/ayuda/condiciones-de-uso) permiten reproducir el contenido citando la fuente y advierten que el portal puede cambiar. Mostrar atribución BCRPData y SBS cuando corresponda. No se identificaron en la documentación consultada cuotas de peticiones por minuto, un SLA o una hora garantizada de publicación; no debe inferirse acceso ilimitado.

La selección recomendada es, por tanto, BCRPData para histórico oficial con tolerancia a demora, y una evaluación adicional de SBS directo solo si el producto exige el cierre más reciente. Un recolector de casas de cambio atendería un objetivo distinto: comparar precios comerciales disponibles en momentos concretos.
