# Validación de fuentes oficiales USD/PEN

Fecha: 2026-09-29, capturas Windows aproximadamente 11:40–11:55 America/Lima y contraste posterior desde la Pi a las 16:57:07 UTC. Pruebas HTTP con Python estándar (`urllib.request`); contraste documental con páginas primarias mediante navegación web. No se instaló ni activó un colector. El coordinador también probó la Raspberry Pi (aarch64, Python 3.13.5) a las 16:49:44 UTC: BCRP devolvió JSON válido de 4 series y 21 períodos, último dato válido 25/09; SBS con cookies normales devolvió HTML de protección de 212 bytes y SUNAT `Request Rejected` de 247 bytes. Una captura posterior de BCRP desde la Pi ya incluyó el 28/09; durante esa misma ronda el rango 1997 devolvió contenido no JSON. Por tanto, **también desde la Pi se observaron respuestas inválidas**.

## Resultado

| Fuente / canal          | Precio y fecha efectivamente observados                                                                                                           | Histórico                                                              | Estado desde Windows                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| BCRPData, interbancario | Primera captura: 25/09/2026, compra 3.41642857142857 y venta 3.41992857142857. Pi 16:57:07 UTC: 28/09/2026, compra 3.43671428571429 y venta 3.439 | JSON válido de enero 1997 en Windows y todo 2020 en ambos entornos     | Parser y datos validados; acceso **intermitente tanto en Windows como en Pi**, con HTTP 200 sin JSON                           |
| BCRPData, SBS           | Primera captura: 25/09/2026, compra 3.416 y venta 3.425. Pi 16:57:07 UTC: 28/09/2026, compra 3.432 y venta 3.440                                  | Mismas consultas, dos series adicionales                               | Durante el estudio pasó de ir atrasado a coincidir con la fecha y los valores observados en SBS directo                        |
| SBS directo             | La navegación web leyó 28/09/2026: compra 3.432; venta 3.440                                                                                      | Guía oficial describe consultas desde 03/01/2000 y archivos anteriores | **No validado para colector**: GET estándar entra en bucle de redirección; con sesión normal devuelve challenge; histórico 403 |
| SUNAT directo           | Ninguna pareja numérica extraída por HTTP en esta prueba                                                                                          | La web ofrece consulta mensual; descarga histórica no demostrada       | **Bloqueado desde este cliente**: HTTP 200 contiene `Request Rejected`, sin cotizaciones                                       |

Estos estados evalúan acceso y extracción, no una garantía de servicio. Poder ver una cifra en un buscador/navegador remoto no demuestra que Python en la Pi pueda obtenerla. No se resolvieron desafíos ni se intentaron evasiones.

## BCRPData: contrato y evidencia

La [API oficial](https://estadisticas.bcrp.gob.pe/estadisticas/series/ayuda/api) admite GET/POST sin inicio de sesión, JSON y rangos de fechas; permite hasta diez series de una misma frecuencia. El [catálogo](https://estadisticas.bcrp.gob.pe/estadisticas/series/diarias/tipo-de-cambio) identifica:

| Código      | Serie                | Inicio publicado |
| ----------- | -------------------- | ---------------- |
| `PD04637PD` | Interbancario compra | 02/01/1997       |
| `PD04638PD` | Interbancario venta  | 02/01/1997       |
| `PD04639PD` | SBS compra           | 02/01/1997       |
| `PD04640PD` | SBS venta            | 02/01/1997       |

Endpoint exacto, GET sin credenciales ni cabeceras especiales:

```text
https://estadisticas.bcrp.gob.pe/estadisticas/series/api/PD04637PD-PD04638PD-PD04639PD-PD04640PD/json/2026-09-01/2026-09-29
```

| Rango en el endpoint                                | HTTP | Bytes de respuesta | Filas      | Filas con las cuatro cotizaciones |
| --------------------------------------------------- | ---- | ------------------ | ---------- | --------------------------------- |
| `2026-09-01/2026-09-29`, primera consulta           | 200  | 2192               | 21         | 19                                |
| `1997-01-01/1997-01-10`                             | 200  | 943                | 8          | 7                                 |
| `2020-01-01/2020-12-31`                             | 200  | 22169              | 262        | 254                               |
| `2026-09-01/2026-09-29`, repetición minutos después | 200  | 289                | No es JSON | No contiene datos                 |

La repetición contiene scripts `/_Incapsula_Resource` en HTML; debe considerarse fallo de adquisición. No atribuir automáticamente ese resultado a exceso de frecuencia: esta muestra no establece la causa del desafío.

El coordinador repitió las consultas desde la Raspberry Pi; estos resultados complementan las capturas Windows anteriores y no las sustituyen:

| Captura Pi UTC del 29/09/2026 | Rango                      | HTTP | Bytes                     | Resultado                                         |
| ----------------------------- | -------------------------- | ---- | ------------------------- | ------------------------------------------------- |
| 16:49:44                      | Septiembre 2026            | 200  | No reportado en esta nota | JSON, 21 períodos; último dato válido 25/09       |
| 16:57:07                      | Septiembre 2026, misma URL | 200  | 2206                      | JSON, 20 fechas válidas; último dato válido 28/09 |
| Ronda de 16:57:07             | Enero 1997                 | 200  | 155                       | **No JSON**, sin histórico utilizable             |
| Ronda de 16:57:07             | Año 2020                   | 200  | 22169                     | JSON, 262 períodos, 254 filas válidas             |

La observación nueva del 28/09 contiene, en el orden solicitado, `["3.43671428571429", "3.439", "3.432", "3.44"]`. El proveedor actualizó el dato durante la investigación; no debe seguir presentándose el 25/09 como su último dato actual. La respuesta histórica inválida demuestra que el problema no se limita a Windows, aunque otras consultas desde la Pi funcionen. No se realizaron más peticiones para esta actualización documental.

El objeto JSON incluye `config.series` (cuatro nombres y precisión declarada `dec`) y `periods`, cuyos elementos contienen `name` y `values`. El orden de valores coincide con el de las series solicitadas y debe validarse por nombre. Los números son cadenas decimales: conservar `Decimal`, pues `dec=3` no elimina cifras adicionales de la respuesta.

Muestras realmente descargadas, con valores en el orden del endpoint:

```json
{"name":"02.Ene.97","values":["2.613","2.618","2.599","2.614"]}
{"name":"31.Dic.20","values":["3.62025","3.623","3.618","3.624"]}
{"name":"25.Set.26","values":["3.41642857142857","3.41992857142857","3.416","3.425"]}
{"name":"28.Set.26","values":["n.d.","n.d.","n.d.","n.d."]}
```

En la primera captura tanto el 28/09 como el 29/09/2026 carecían de datos; la captura posterior desde la Pi añadió valores para el 28/09. En 2020 hay ocho filas sin las cuatro cotizaciones, entre ellas 01/01, 09/04 y 10/04. No convertir `n.d.` a cero ni identificar última fila con última cotización. No se descargaron todos los años: el comienzo del archivo y un año intermedio están demostrados, la continuidad completa desde 1997 todavía no. La descarga 1997 se demostró en Windows, pero falló en la Pi en la ronda posterior.

Se ejecutó sobre las tres respuestas guardadas un parser con mapa explícito de meses españoles, validación del año respecto del rango, cuatro valores por fila, `Decimal > 0` para datos presentes y fechas únicas/ordenadas. Pasaron 21, 8 y 262 filas, respectivamente; la respuesta HTML repetida fue rechazada por el parser JSON.

Reproducción mínima de una consulta y validación, ejecutable tanto en Windows como Linux:

```python
import json
import urllib.request
from decimal import Decimal

url = ("https://estadisticas.bcrp.gob.pe/estadisticas/series/api/"
       "PD04637PD-PD04638PD-PD04639PD-PD04640PD/json/"
       "2026-09-01/2026-09-29")
with urllib.request.urlopen(url, timeout=30) as response:
    raw = response.read()
    payload = json.loads(raw)  # HTTP 200 con challenge HTML falla aquí
assert len(payload["config"]["series"]) == 4
valid = []
for row in payload["periods"]:
    assert len(row["values"]) == 4
    values = [None if v == "n.d." else Decimal(v) for v in row["values"]]
    assert all(v is None or v > 0 for v in values)
    if all(v is not None for v in values):
        valid.append((row["name"], values))
print(len(payload["periods"]), valid[-1])
```

Las [condiciones de BCRPData](https://estadisticas.bcrp.gob.pe/estadisticas/series/ayuda/condiciones-de-uso) permiten reproducción con atribución, advierten que el sitio puede cambiar y no garantizan disponibilidad. No se encontró una cuota numérica ni SLA. `https://estadisticas.bcrp.gob.pe/robots.txt` respondió 404; esto no equivale a una licencia adicional.

## SBS directo

Página pública exacta: [TipoCambioPromedio.aspx](https://www.sbs.gob.pe/app/pp/SISTIP_PORTAL/Paginas/Publicacion/TipoCambioPromedio.aspx). La navegación web mostró encabezado de fecha `Tipo de Cambio al 28/09/2026`, fila `Dólar de N.A.` y columnas compra `3.432` / venta `3.440`. Son observaciones del contenido web consultado, **no** un resultado extraído por Python.

Pruebas GET desde Windows:

1. `urllib.request.urlopen(url, timeout=35)`: excepción por bucle de redirecciones 302.
2. Cliente con `HTTPCookieProcessor(CookieJar())` y `User-Agent: Mozilla/5.0`: HTTP 200, 212 caracteres, script de protección `/_Incapsula_Resource`; sin formulario ni tabla.
3. [Entrada histórica](https://www.sbs.gob.pe/app/stats/seriesH_TC-CV-Historico.asp): bucle 302 sin sesión; HTTP 403 usando la sesión normal.

No se obtuvieron campos de formulario ni un POST reproducible de consulta histórica. No se debe presentar esta integración como lista. Tampoco se identificó una API JSON pública documentada.

La [guía oficial de series](https://www.sbs.gob.pe/app/pp/serieshistoricas2/guias/Tipo%20de%20Cambio.pdf) describe selección de fecha inicial, final, moneda y exportación Excel; compra/venta diaria desde 03/01/2000. Ofrece archivos antiguos: 1930–1975 con cierre anual, 1976–1977 con fechas de variación y 1978–2000 diarios. Esa cobertura es **documental**, no una descarga validada; los períodos antiguos exigen identificar la unidad monetaria y no mezclarlos automáticamente con PEN moderno.

La página visible contiene celdas vacías para algunas monedas y `S/M` en una tabla diferente, de mesa BCRP. El parser futuro deberá localizar específicamente la tabla de oferta/demanda y la fila USD, sin capturar por posición números de otras tablas. Se observó que el USD sí tiene ambos valores. No se demostró la representación de un día sin publicación mediante el formulario.

`https://www.sbs.gob.pe/robots.txt` devolvió 403. No se verificaron condiciones específicas que autoricen automatización ni una prohibición publicada aplicable; el resultado de robots no permite concluir ninguna de las dos.

## SUNAT directo

Entrada pública: [SUNAT - Tipo de Cambio Oficial](https://e-consulta.sunat.gob.pe/cl-at-ittipcam/tcS01Alias). La página visible mediante navegación web ofrece consulta por mes y descarga, y explica dos reglas relevantes: el dato corresponde al cierre SBS del día anterior; cuando no hay publicación se toma el del día inmediato anterior. La fecha SUNAT y la fecha de cierre SBS deben mantenerse como conceptos separados.

Dos GET Windows (cliente estándar y cliente con cookies normales/UA navegador) devolvieron HTTP 200, 247 bytes, título `Request Rejected`, sin cotizaciones ni formulario. El segundo confirmó el mismo patrón. No hubo una respuesta numérica válida, no se estableció un endpoint mensual ni un cuerpo POST comprobado y no se verificó el rango histórico efectivo. No se deben inventar esos parámetros a partir de ejemplos de terceros.

`https://e-consulta.sunat.gob.pe/robots.txt` devolvió 404. No se encontró durante esta revisión una API pública documentada sin autenticación que sustituya esta consulta. La documentación API SIRE que aparece en búsquedas corresponde a operaciones de registros del contribuyente y no acredita un feed público de tasas; no se usó.

## Decisión operativa

BCRPData es la integración oficial con contrato y parser demostrados en ambos entornos, con respuestas inválidas también observadas desde la Pi. Requiere manejar contenido no JSON como fallo, conservar la última captura válida y reintentar con espera. SBS vía BCRP debe etiquetarse con su fecha real: inicialmente mostraba 25/09 frente al 28/09 de SBS directo; a las 16:57:07 UTC ya incluía el 28/09 con los mismos valores SBS. Esta actualización observada no establece un horario fijo ni una garantía de demora. SBS directo y SUNAT quedan fuera de la lista de fuentes listas para activar mientras no exista una respuesta numérica reproducible desde la Pi o un canal oficial autorizado accesible. No sintetizar una serie SUNAT desplazando fechas SBS: no se validó la equivalencia completa de su calendario.
