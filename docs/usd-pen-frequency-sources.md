# Frecuencia USD/PEN: evidencia de los proveedores

Revisión: 23 de noviembre de 2026. Investigación de fuentes públicas oficiales;
sin ejecutar una prueba de carga ni modificar recolectores.

| Fuente      | Evidencia pública                                                                                                                     | Lo que no permite concluir                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Kambista    | Su portada describe una comparación del dólar minuto a minuto y una tendencia en vivo.                                                | No establece una cuota para terceros ni garantiza un precio distinto cada minuto.               |
| Rextie      | Su página de precio del dólar anuncia consulta actualizada en tiempo real desde web y app.                                            | No publica allí un intervalo técnico de actualización ni un SLA de su endpoint.                 |
| Tu Cambista | Su portada muestra compra/venta y una sección de tipo de cambio en vivo con hora de última actualización.                             | La hora de esa sección no demuestra el intervalo del endpoint o del HTML que consume este repo. |
| BCRP        | El catálogo clasifica PD04637PD y las series de tipo de cambio usadas como series diarias. La API entrega series por rango de fechas. | Reducir el polling a segundos no convierte una serie diaria en un flujo intradía.               |

Fuentes: [Kambista](https://kambista.com/),
[Rextie](https://www.rextie.com/precio-del-dolar/),
[Tu Cambista](https://tucambista.pe/),
[catálogo diario BCRP](https://estadisticas.bcrp.gob.pe/estadisticas/series/diarias/)
y [API BCRP](https://estadisticas.bcrp.gob.pe/estadisticas/series/ayuda/api).

No identifiqué límites documentados de consultas por segundo/minuto para los
endpoints comerciales del repo en las páginas oficiales revisadas ni en las
búsquedas específicas de API/rate limits. Es ausencia de evidencia pública en
esta revisión, no evidencia de acceso ilimitado. La documentación BCRP sí
establece hasta diez series de la misma frecuencia por consulta; no encontré
allí una cuota de peticiones por minuto.

## Consecuencia para el diseño

Un piloto de capturas comerciales a 60 segundos es una propuesta de ingeniería,
no un mínimo garantizado por los proveedores. Pasar después a 30 segundos debe
depender de la medición por fuente: duración, fallos, 429/403, cambios útiles y
respuestas idénticas. Respetar `Retry-After` y volver a un intervalo mayor ante
rechazos. No afirmar que 1–5 segundos es seguro sin evidencia adicional.

La frecuencia de consulta de nuestra base puede ser mayor que la de captura:
sirve para reducir cuánto tarda en aparecer una observación ya recibida. No
crea cambios de precio que la fuente no haya publicado. Mantener separadas la
hora de comprobación y la hora de la última observación aceptada.
