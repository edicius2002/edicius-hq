# Validación previa del gadget USD/PEN

Fecha: 29 de septiembre de 2026. Pruebas entre aproximadamente 16:45 y 17:10 UTC, desde Windows y desde la Raspberry Pi real. Pi: ARM64, Python 3.13.5; cliente del entorno existente: httpx 0.28.1. Se ejecutaron consultas públicas y simulaciones sin confirmar operaciones. No se instaló un colector ni se modificaron servicios, credenciales o bases de datos.

## Resultado ejecutivo

Se revisaron **30 fuentes o canales identificados**: tres oficiales, siete casas principales, trece alternativas, seis canales bancarios y CED. Once casas devolvieron compra y venta propias desde la Pi. BCRP también devolvió series oficiales e histórico. Es evidencia de extracción puntual, no una certificación de disponibilidad continua ni de licencia de redistribución.

- **Extracción técnica conseguida en Pi:** Kambista, Tu Cambista, Securex, Cambio Seguro, DollarHouse, Rextie, TKambio, Kambio, Dichikash, Inka Money y Chaski Dólar.
- **Referencia oficial conseguida en Pi:** BCRP, incluyendo sus series SBS. Se observaron respuestas inválidas en algunas consultas; se necesita detectar el cuerpo real de la respuesta.
- **Sin canal directo operativo demostrado:** SUNAT y SBS directo, varias casas y los canales bancarios listados abajo.
- **Histórico:** BCRP permite recuperar períodos pasados. Ninguna casa comercial tiene un archivo histórico propio descargable demostrado en esta investigación. Para esas casas, planificar capturas desde la activación.

TKambio, Kambio y Kambista son tres empresas/fuentes diferentes. El éxito de una no valida las otras.

## Criterio de validación

Para considerar una extracción conseguida se exigió: respuesta desde la Pi, números positivos con compra y venta identificadas, pertenencia a la entidad consultada y método/selector reproducible. En simuladores se contrastó el importe convertido con la tasa correspondiente. Se rechazaron ceros de carga, HTML de protección con HTTP 200, números de ejemplos educativos y comparadores de terceros.

La fecha económica, la hora de publicación cuando existe, la captura y el vencimiento son campos distintos. Un 200, la ausencia de reglas en robots o una página indexada por un buscador no prueba por sí solo actualidad, autorización de reutilización o funcionamiento del colector.

## Matriz completa

| #   | Fuente / canal                                                                                         | Resultado de acceso y extracción                                                                                             | Histórico / decisión                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | [BCRPData](https://estadisticas.bcrp.gob.pe/estadisticas/series/ayuda/api)                             | JSON válido en Pi; cuatro series diarias. También HTTP 200 sin JSON en una consulta histórica.                               | Apto técnicamente con manejo de fallos. Año 2020 descargado en Pi; enero 1997 descargado en Windows. No se descargaron las tres décadas completas.           |
| 2   | [SBS directo](https://www.sbs.gob.pe/app/pp/SISTIP_PORTAL/Paginas/Publicacion/TipoCambioPromedio.aspx) | Web remota muestra tasas; HTTP desde Pi y Windows devuelve protección/redirecciones.                                         | No listo como canal directo. SBS vía BCRP sí se extrajo, conservando proveedor de distribución y fecha real.                                                 |
| 3   | [SUNAT directo](https://e-consulta.sunat.gob.pe/cl-at-ittipcam/tcS01Alias)                             | HTTP 200 con `Request Rejected`, sin tabla, en Pi y Windows.                                                                 | No listo. No fabricar SUNAT desplazando fechas de SBS sin validar todas sus reglas.                                                                          |
| 4   | [Kambista](https://kambista.com/)                                                                      | Dos capturas Pi válidas; HTML `#valcompra`, `#valventa`.                                                                     | Extracción conseguida; histórico propio desde capturas.                                                                                                      |
| 5   | [Tu Cambista](https://tucambista.pe/)                                                                  | Dos capturas Pi válidas; botones del cotizador propio `.tc-quote-rate`.                                                      | Extracción conseguida. La hora del comparador de competidores no se interpreta como hora del precio propio.                                                  |
| 6   | [Securex](https://securex.pe/)                                                                         | Dos capturas Pi válidas; etiquetas locales Compra/Venta.                                                                     | Extracción conseguida por HTML. No necesita consultar el prefijo `/api` excluido en robots.                                                                  |
| 7   | [Cambio Seguro](https://cambioseguro.com/)                                                             | Dos capturas Pi válidas; `.value-rate` junto a Dólar compra/venta; contraste del estado Nuxt.                                | Extracción conseguida. Separar estándar, cupón, banco y precio por monto.                                                                                    |
| 8   | [DollarHouse](https://app.dollarhouse.pe/)                                                             | Dos capturas Pi válidas; `#buy-exchange-rate`, `#sell-exchange-rate`.                                                        | Extracción conseguida; cuatro decimales.                                                                                                                     |
| 9   | [Rextie](https://www.rextie.com/)                                                                      | HTML contiene ceros de carga. Su POST público de simulación con `commit=false` sí devuelve JSON válido en Pi, HTTP 201.      | Extracción conseguida por endpoint; conserva monto, dirección, promoción y `valid_until`.                                                                    |
| 10  | [TKambio](https://tkambio.com/)                                                                        | POST público de cotizador: inicialmente 403 en Pi con urllib; después 200 y precios válidos con httpx del entorno existente. | **Viable con acceso variable.** No atribuir el cambio de resultado al cliente sin aislar otras variables.                                                    |
| 11  | [Kambio / KAMBIO.ONLINE](https://www.kambio.com.pe/)                                                   | API pública `GET https://kambio.com.pe/api/rates/current`; Pi devuelve `buy`, `sell`, `createdAt`.                           | Extracción conseguida. Guardar sólo campos de cotización, excluyendo metadatos ajenos al gadget.                                                             |
| 12  | [Dichikash](https://dichikash.com/index)                                                               | Dos GET públicos separados para compra y venta, ambos con texto decimal válido en Pi.                                        | Extracción conseguida; conservar hora de cada llamada. No son un snapshot atómico.                                                                           |
| 13  | [Inka Money](https://inkamoney.com/)                                                                   | POST `/convert` con sesión anónima y CSRF del formulario devuelve par válido en Pi.                                          | Extracción conseguida. Props HTML iniciales inconsistentes: usar respuesta del cotizador.                                                                    |
| 14  | [Chaski Dólar](https://chaskidolar.com/)                                                               | HTML y POST `/convert` válidos en Pi. El vocabulario está desde la perspectiva del cliente.                                  | Extracción conseguida; compra normalizada=`fxBaseSale`, venta=`fxBaseBuy`.                                                                                   |
| 15  | [Western Union Perú FX](https://www.westernunionperu.pe/cambiodemoneda/)                               | HTML 200 sin precios. El JS de cotización observado incluye reCAPTCHA; no se intentó resolverlo.                             | No listo para HTTP simple. Necesita un canal de datos accesible sin esa barrera.                                                                             |
| 16  | [Cambio Mundial](https://www.cambiomundial.com/)                                                       | 403 en Windows y Pi.                                                                                                         | Canal probado bloqueado; no listo.                                                                                                                           |
| 17  | [CambiaFX](https://cambiafx.pe/)                                                                       | 403 en Windows y Pi.                                                                                                         | Canal probado bloqueado; no listo.                                                                                                                           |
| 18  | [Money House](https://moneyhouse.pe/)                                                                  | 403 en Windows y Pi.                                                                                                         | Canal probado bloqueado; no listo.                                                                                                                           |
| 19  | [Mercado Cambiario](https://www.mercadocambiario.pe/)                                                  | 200/SPA. JSON contiene comparación de otras empresas y precio de apertura; no se demostró par propio simultáneo.             | No listo; no usar la tabla de competidores como cotización de Mercado Cambiario.                                                                             |
| 20  | [Dolarex](https://dolarex.pe/)                                                                         | 200/SPA sin cotizaciones HTML. No se comprobó endpoint dedicado del par.                                                     | No listo; API de compra/venta pendiente de un contrato público verificable.                                                                                  |
| 21  | [Cambio Sol](https://cambiosol.pe/)                                                                    | 403 en Windows y Pi; herramienta web muestra cifras sin timestamp.                                                           | No listo para colector probado.                                                                                                                              |
| 22  | [Fluyez](https://fluyez.com/)                                                                          | 403 directo; contenido oficial describe operación cripto y conversión fiat por proveedores.                                  | Excluir de USD bancario/PEN: no se verificó ese instrumento.                                                                                                 |
| 23  | [Lemon Perú](https://lemon.me/peru/dolar-cripto)                                                       | 200 en Pi; página describe promedio USDT/PEN y usa guiones sin datos en HTML.                                                | Categoría cripto separada. Histórico de cuatro días anunciado, descarga no comprobada; no equivale a compra/venta USD/PEN.                                   |
| 24  | [BCP](https://www.viabcp.com/otros-servicios/tipo-cambio)                                              | 403 desde Pi. Documentación dirige a cotizar en banca/app con identidad, monto y cuentas.                                    | No se demostró una cotización pública propia extraíble; no usar un precio de CED como captura directa del banco.                                             |
| 25  | [Cocos y Lucas](https://www.cocosylucasbcp.com/)                                                       | Pi 200 con sólo script de redirección a `/lander`; sin datos. `/lander` tampoco mostró cotización en prueba Windows.         | Excluir del catálogo operativo. Las páginas antiguas de BCP que lo mencionan no demuestran disponibilidad actual.                                            |
| 26  | [Interbank](https://interbank.pe/servicios/cambio-moneda/compra-venta-moneda-extranjera)               | 403 en Pi; documentación de sus canales no ofreció un par público validado.                                                  | No listo; precios/promociones de ejemplo no son tasa vigente.                                                                                                |
| 27  | [BBVA](https://www.bbva.pe/personas/servicios-digitales/cambia-dolares-a-soles.html)                   | 403 en Pi. Documentación sitúa la cotización en T-Cambio/app/banca.                                                          | No listo para el canal público probado.                                                                                                                      |
| 28  | [Scotiabank](https://www.scotiabank.com.pe/Personas/servicios/otros/cambiar-dolares)                   | Pi 200, página informativa; instrucciones de inicio de sesión y cálculo, sin par de precios públicos.                        | No listo. El blog con «tipo de cambio hoy» tampoco contenía una cotización propia.                                                                           |
| 29  | [Banco de la Nación](https://bancaporinternet.bn.com.pe/TCWeb/)                                        | Herramienta web muestra tabla fechada; Pi y Windows reciben `Radware Page`, verificación de navegador, con HTTP 200.         | No listo para HTTP simple. Rechazar la respuesta de protección.                                                                                              |
| 30  | [Cuánto Está el Dólar](https://cuantoestaeldolar.pe/)                                                  | Pi 403. Sus términos restringen automatización.                                                                              | No usar como fuente periódica sin resolver acceso/condiciones. Paralelo/Ocoña y Bloomberg vistos allí tampoco tienen canal propio validado en este análisis. |

## TKambio: validación pedida expresamente

Método descubierto en el JavaScript de su cotizador público:

```text
POST https://tkambio.com/wp-admin/admin-ajax.php
Content-Type: application/x-www-form-urlencoded

action=get_exchange_rate
```

Desde Pi con httpx 0.28.1, a las **17:00:22 UTC**, sin cuentas ni cabeceras de suplantación: HTTP 200, 282 bytes. Campos extraídos:

```json
{ "buying_rate": 3.434, "selling_rate": 3.46, "text_updated_at": "un minuto", "outdates_in": 300 }
```

El mismo contrato había recibido 403 a las 16:52:36 UTC con urllib. El éxito posterior prueba acceso, no la causa de la diferencia. Debe tolerar negativa temporal, conservar la captura anterior con su antigüedad y no presentar una respuesta fallida como actualización. La respuesta también contempla descuentos por monto y tarifas de banco; ceros en campos opcionales no son cotizaciones válidas. Histórico descargable propio no demostrado.

## Histórico y fecha de referencia

- **BCRP:** cuatro series desde 1997 según catálogo. Se probaron septiembre 2026, un tramo de enero 1997 y el año 2020. Desde Pi, 2020 devolvió 262 períodos, 254 con cuatro valores válidos; la petición de 1997 dio HTTP 200 sin JSON, aunque había funcionado en Windows.
- A las **16:49 UTC** BCRP tenía último dato válido del 25/09. A las **16:57 UTC** ya tenía el 28/09: SBS compra `3.432`, venta `3.440`. La actualización ocurrió durante el estudio; no fijar un supuesto retraso permanente.
- **SBS directo:** archivo histórico documentado, descarga automatizada no conseguida. Las series SBS distribuidas por BCRP son una alternativa claramente etiquetada.
- **SUNAT:** fecha asociada al cierre SBS del día anterior y reglas para días sin publicación. No se obtuvo la tabla oficial por HTTP; no sustituirla silenciosamente por otra serie.
- **Once casas:** cotización actual extraída, archivo histórico propio no demostrado. Comenzar el histórico con capturas y conservar proveedor, dirección, monto/canal y variante de precio. Capturas repetidas no recuperan revisiones o cotizaciones anteriores al inicio.

## Recomendación técnica después de validar

La primera integración puede basarse en **Kambista, Tu Cambista, Securex, Cambio Seguro, DollarHouse, Rextie y TKambio**, más BCRP/SBS como referencias diarias. Los cuatro adaptadores adicionales con extracción conseguida —Kambio, Dichikash, Inka y Chaski— son extensiones técnicamente factibles; tienen particularidades de semántica y condiciones documentadas en su nota.

No hace falta un navegador para las extracciones que funcionaron. La Pi puede usar el Python/httpx existente. Para una futura activación, queda implementar validación de schema, precisión decimal según fuente, errores por HTML inesperado, pausas tras 403/429, preservación del último dato, pendientes locales y separación de tasa estándar/promocional. La validación puntual no establece una frecuencia máxima admitida ni sustituye la observación del colector una vez implementado.

No guardar una falsa fecha de actualización cuando sólo se conoce la captura. No representar las referencias oficiales como ofertas comerciales elegibles para el ranking. No mezclar promedios diarios, último precio observado y bid/ask instantáneos en una misma serie sin identificarlos.

## Evidencia y límites

- [Pruebas oficiales y parser](usd-pen-validation-official.md).
- [Siete casas principales: selectores, endpoints, condiciones y repetición Pi](usd-pen-validation-commercial.md).
- [Trece fuentes adicionales](usd-pen-validation-other.md).
- [Registro reducido de consultas desde Pi](usd-pen-validation-evidence.json): códigos HTTP, URLs públicas, fechas y valores seleccionados. Excluye cookies, CSRF, cuerpos de páginas y metadatos ajenos al precio.

Las [condiciones de CED](https://cuantoestaeldolar.pe/term-cond) restringen expresamente automatización. Las condiciones de las casas se revisaron y enlazaron en las notas: extracción técnicamente posible no concede una licencia de redistribución. El gadget previsto es personal; cualquier decisión sobre publicar datos a terceros debe considerar esas condiciones. No se presupone que una cláusula general de propiedad intelectual implique por sí sola una prohibición universal de almacenar cifras.

Los canales que fallaron quedan evaluados con un impedimento concreto, no prometidos para implementación. No se verificaron sesiones bancarias privadas, cotizaciones personalizadas por identidad, todos los montos/cupones, todos los años históricos ni funcionamiento durante días completos. Los archivos previos de investigación conservan observaciones anteriores; esta matriz incorpora las pruebas posteriores desde la Pi.
