# Validación de fuentes comerciales USD/PEN

Fecha: 29 de septiembre de 2026. Investigación previa a implementación. Solicitudes públicas reales desde Windows y, mediante el agente coordinador, desde la Raspberry Pi ARM64/Python 3.13.5. No se instaló un colector, creó cuenta ni confirmó una operación de cambio. Los scripts y respuestas exploratorios se guardaron únicamente en TEMP; este documento conserva los contratos reproducibles. Los valores son evidencia de la prueba, no precios vigentes para operar.

## Resultado técnico

| Fuente        | Extracción validada                             | Windows                                        | Raspberry Pi                                                 | Estado para un adaptador                                                 |
| ------------- | ----------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Kambista      | GET HTML, selectores propios                    | 200, compra y venta válidas                    | 200, parser válido en segunda captura                        | HTTP listo técnicamente                                                  |
| TuCambista    | GET HTML, cotizador propio                      | 200, compra y venta válidas                    | 200, parser válido en segunda captura                        | HTTP listo técnicamente                                                  |
| Securex       | GET HTML, etiquetas del cotizador               | 200, compra y venta válidas                    | 200, parser válido en segunda captura                        | HTTP listo técnicamente                                                  |
| Cambio Seguro | GET HTML; contraste con estado Nuxt             | 200, compra y venta válidas                    | 200, parser válido en segunda captura                        | HTTP listo técnicamente                                                  |
| DollarHouse   | GET HTML, IDs propios                           | 200, compra y venta válidas                    | 200, parser válido en segunda captura                        | HTTP listo técnicamente                                                  |
| Rextie        | POST JSON de simulación pública, `commit=false` | 201, precios, importe y vencimiento coherentes | 201, misma estructura y cálculo correcto                     | HTTP listo técnicamente; no necesita navegador                           |
| TKambio       | POST del cotizador público                      | 200, precios y descuentos válidos              | 403 con urllib; posteriormente 200 con el httpx del colector | Viable condicionalmente; extracción conseguida desde Pi, acceso variable |

«Listo técnicamente» significa que se recuperó y normalizó la cotización propia. No certifica estabilidad permanente, autorización para redistribuir contenido ni que un precio permanezca vigente hasta una operación. No hacen falta siete navegadores ni siete sesiones autenticadas.

## Pruebas reproducibles por proveedor

### Kambista

- URL y método: `GET https://kambista.com/`.
- Compra: texto de `#valcompra`; venta: texto de `#valventa`. Limpiar espacios normales y NBSP; convertir con decimal, conservando precisión.
- Captura Windows `2026-09-29T16:48:25Z`: `{"buy":"3.43","sell":"3.458"}`. HTTP 200, 495.326 bytes.
- El parser no toma noticias, cifras de ahorro ni otros números del documento.
- No se encontró una fecha de publicación de la tasa en esos nodos. Registrar `observed_at`; no convertir «hoy» ni el temporizador en fecha de actualización del mercado.
- La [web propia](https://kambista.com/) y sus [condiciones de marzo de 2026](https://neocdn.kambista.com/wp-content/uploads/2026/03/2026-Terminos-y-Condiciones-KAMBISTA-S.A.C.pdf) distinguen tasa pública, cupones y tasa preferencial por monto. Esta última requiere negociación; el HTML base no demuestra acceso automático a ella.
- Histórico comercial descargable: no validado. La ayuda menciona el historial de operaciones del cliente autenticado; eso no es un archivo público de cotizaciones.

### TuCambista

- URL y método: `GET https://tucambista.pe/`.
- Delimitar cada botón `.tc-quote-rates .tc-quote-rate`; leer el par etiquetado `Compra:` o `Venta:` dentro del botón. Ejemplo de texto: `Compra: 3.430 --`; los guiones no pertenecen al valor.
- Captura Windows `2026-09-29T16:48:24Z`: `{"buy":"3.430","sell":"3.456"}`. HTTP 200, 156.226 bytes.
- La página también contiene un comparador con tasas de Rextie, Kambista, TKambio y otros. **Esos registros no se usan para afirmar disponibilidad de las otras fuentes directas.**
- La hora «Última actualización» pertenece a ese comparador. El estado de hidratación contiene `createdOn`, pero no se verificó que sea el instante en que cambió el precio propio; por ello se conserva como metadato bruto, no como un tick garantizado. El histórico propuesto se fecharía por captura.
- El [cotizador](https://tucambista.pe/) permite cupón. Guardar la tasa inicial sin cupón como variante pública; los acuerdos y cupones forman variantes independientes.
- Histórico descargable de compra/venta propio: no validado. La [FAQ](https://tucambista.pe/preguntasFrecuentes) confirma variaciones durante el día, pero no ofrece un contrato de archivo histórico en lo revisado.

### Securex

- URL y método: `GET https://securex.pe/`.
- Encontrar `span.fs-16-bold` cuyo texto sea exactamente `Compra:` o `Venta:`; tomar el siguiente hermano `span`. No usar cualquier número posterior al título general de la página.
- Captura Windows `2026-09-29T16:48:24Z`: `{"buy":"3.434","sell":"3.4595"}`. HTTP 200, 103.163 bytes. La venta demuestra que hacen falta al menos cuatro decimales, aunque algunas fuentes publiquen tres.
- El [cotizador](https://securex.pe/) ofrece cupones y negociación contra otra oferta; esas tasas no son equivalentes al precio público inicial. No se simuló ningún cupón.
- «Actualizado hoy» no da hora de publicación. `source_updated_at` queda desconocido; `observed_at` sí se registra.
- Histórico comercial descargable: no validado. No es necesario consultar `/api` para extraer el HTML; robots desaconseja expresamente ese prefijo.

### Cambio Seguro

- URL y método: `GET https://cambioseguro.com/`.
- Leer `.rates-price`: cada bloque contiene la etiqueta `Dólar compra` o `Dólar venta` y su `.value-rate`. Identificar por etiqueta, no por posición ni clase `active`.
- Captura Windows `2026-09-29T16:48:23Z`: `{"buy":"3.4350","sell":"3.4590"}`. HTTP 200, 351.575 bytes.
- Contraste adicional: se leyó el JSON de `#__NUXT_DATA__` y se resolvieron sus referencias por índice. El objeto propio resultó `compra:3.435`, `venta:3.459`, `preferential_rate:false`, `id_coupon:null`, `code_coupon:""`, `created_at:null`.
- El mismo estado contiene precios comparativos, paralelo y SUNAT. Se excluyeron del precio propio; los valores SUNAT embebidos carecían de fecha comprobada y no son una validación de SUNAT directo.
- El [sitio](https://cambioseguro.com/) anuncia cupones, precio preferencial por monto y promociones flash condicionadas. El adaptador inicial debe conservar la variante sin cupón; ofertas especiales requieren registrar condiciones y vigencia.
- Histórico descargable propio: no validado. Los artículos semanales son publicaciones editoriales, no un archivo estructurado exhaustivo de compra/venta de la casa.

### DollarHouse

- URL y método: `GET https://app.dollarhouse.pe/`.
- Compra: `#buy-exchange-rate`; venta: `#sell-exchange-rate`. El nodo `#textoperation3` representa la tasa aplicada al sentido seleccionado, por lo que no sustituye al par compra/venta.
- Captura Windows `2026-09-29T16:48:23Z`: `{"buy":"3.4360","sell":"3.4440"}`. HTTP 200, 25.638 bytes.
- No se encontró un timestamp de publicación asociado al par; usar captura. Tampoco se comprobó un contrato público de cupones o tramos en esa página. No suponer que todas las operaciones y bancos recibirán exactamente ese precio.
- Histórico descargable propio: no validado. La [web corporativa](https://dollarhouse.pe/) enlaza el servicio y sus condiciones, pero no un archivo de cotizaciones en lo examinado.

### Rextie

La portada devuelve `0.0000` mientras carga; esos ceros deben rechazarse. El módulo público del cotizador revela una simulación HTTP suficiente:

```http
POST https://app.rextie.com/api/v1/fxrates/rate/?origin=home&commit=false
Content-Type: application/json
rextie-country: pe
rextie-language: es
rextie-app-platform: rextie-web
rextie-app-version: 6.6.27

{"source_currency":"USD","target_currency":"PEN","source_amount":1000}
```

Se reprodujeron los encabezados públicos del cliente, sin cookies, credenciales ni tokens. La versión es la observada en esa fecha; el adaptador debe detectar cambios del contrato. Referencias de descubrimiento: [módulo FxRates](https://www.rextie.com/_astro/FxRates.astro_astro_type_script_index_0_lang.C9J-7PC6.js), [rextieFetch](https://www.rextie.com/_astro/rextieFetch.C5zsIW07.js), [configuración pública](https://www.rextie.com/_astro/environment.CxbSUsGx.js).

Respuesta Windows HTTP 201, capturada `2026-09-29T16:52:27Z`:

```json
{
  "fx_rate_buy": "3.4265",
  "fx_rate_sell": "3.4615",
  "source_currency": "USD",
  "source_amount": "1000.00",
  "target_currency": "PEN",
  "target_amount": "3426.50",
  "valid_until": "2026-09-29T11:57:28.534937-05:00",
  "quote_pk": null,
  "promo_code": null,
  "campaign": null,
  "is_preferential": false
}
```

La identidad `1000 USD × 3.4265 PEN/USD = 3426.50 PEN` confirma el sentido compra. El propio módulo presenta `fx_rate_buy` como Compra y `fx_rate_sell` como Venta; no usar `fx_bank_bid/ask`, que son referencias bancarias. `valid_until` es vencimiento de la simulación, no hora original de publicación. `commit=false` y `quote_pk:null` permiten comprobar que no se registró una orden de cambio. No cambiar ese parámetro al construir un colector.

Conservar monto y sentido consultados. La respuesta admite promoción, segmentación, márgenes y preferencia; la prueba solo valida USD 1.000 sin cupón. No se confirmó histórico descargable propio.

### TKambio

La página inicial no incluye las tasas del cotizador. Su JSON-LD contiene ejemplos `3.85`, `0.26` y moneda `PLN`: **no son las cotizaciones USD/PEN del widget**. El [JavaScript público del cotizador](https://tkambio.com/wp-content/themes/tkambio/inc/assets/js/calculator/main.js?ver=1.0.102-b-modified-1790269339) llama a:

```http
POST https://tkambio.com/wp-admin/admin-ajax.php
Content-Type: application/x-www-form-urlencoded

action=get_exchange_rate
```

Prueba Windows con `requests 2.34.2`, sin sesión ni encabezados especiales, HTTP 200:

```json
{
  "buying_rate": 3.431,
  "selling_rate": 3.456,
  "text_updated_at": "10 minutos",
  "outdates_in": 300,
  "discounts": [
    { "min_amount": 5000, "buying_rate": 3.434, "selling_rate": 3.453 },
    { "min_amount": 10000, "buying_rate": 3.435, "selling_rate": 3.452 }
  ],
  "ibk_buying_rate": 0,
  "ibk_selling_rate": 0,
  "campaigns": []
}
```

El código asigna `buying_rate` a Compra y `selling_rate` a Venta. No usar los campos IBK iguales a cero. `discounts` debe permanecer separado de la tasa base; la unidad y elegibilidad de cada umbral necesitan comprobarse antes de presentarlos como una oferta universal. Las campañas contemplan banco de envío/recepción, monto mínimo/máximo y stock. `profile=company` corresponde a otra variante; no fue la consultada.

`text_updated_at` es una descripción relativa, no fecha absoluta; `outdates_in` controla la recarga del cliente, no demuestra el instante del último cambio. La solicitud estándar usó `User-Agent: python-requests/2.34.2`, `Accept: */*`, `Accept-Encoding: gzip, deflate`, `Content-Length: 24`. No hubo proxy, cookies, identidad de navegador ni solución de desafío.

Desde la Pi, `urllib` recibió **403** tanto en la portada como en este POST (`16:52:36Z`). Posteriormente, a las `17:00:22Z`, el cliente real del colector del repositorio, **httpx 0.28.1** en su entorno virtual, obtuvo **HTTP 200**, JSON de 282 bytes, con el mismo POST y cuerpo, sin modificar encabezados. Extracto: `{"buying_rate":3.434,"selling_rate":3.46,"text_updated_at":"un minuto","outdates_in":300}`.

Esto confirma que sí se puede extraer TKambio desde la Pi con el cliente que ya utiliza el proyecto. Los 403 anteriores siguen siendo evidencia de disponibilidad variable; las pruebas no aíslan su causa ni permiten atribuirla concluyentemente al cliente HTTP. No se usaron proxies, suplantación de navegador ni resolución de desafíos. El adaptador debe tolerar 403 y conservar la última captura con su antigüedad, sin presentarla como nueva. Histórico descargable propio: no validado; el blog «Dólar hoy» no demuestra un archivo completo de tasas propias.

## Comprobación desde Raspberry Pi

La primera captura de páginas fue a las `16:49:44Z`. Una segunda ejecución con parser temporal de biblioteca estándar, enviado por stdin y sin instalar producto, normalizó los cinco proveedores entre `16:56:26Z` y `16:56:30Z`:

| Fuente        | Compra primera captura | Venta primera captura | Compra segunda captura | Venta segunda captura |
| ------------- | ---------------------: | --------------------: | ---------------------: | --------------------: |
| Kambista      |                   3.43 |                 3.458 |                   3.43 |                 3.459 |
| TuCambista    |                  3.430 |                 3.456 |                  3.432 |                 3.459 |
| Securex       |                  3.437 |                 3.461 |                  3.437 |                 3.461 |
| Cambio Seguro |                 3.4350 |                3.4590 |                 3.4340 |                3.4590 |
| DollarHouse   |                 3.4370 |                3.4440 |                 3.4370 |                3.4470 |

El parser validó ambos decimales y el orden compra ≤ venta. El intervalo demuestra valores recuperables y algunos cambios reales, sin establecer aún fiabilidad continua o cobertura fuera de horario.

La Pi reprodujo Rextie a las `16:57:08Z`: HTTP 201, `buy=3.4275`, `sell=3.4625`, `source_amount=1000.00 USD`, `target_amount=3427.50 PEN`, `valid_until=2026-09-29T12:02:08-05:00`, `quote_pk=null`, sin promoción ni preferencia. El POST de TKambio devolvió 403 inicialmente y HTTP 200 a las `17:00:22Z` mediante httpx 0.28.1 del entorno del colector, con compra `3.434` y venta `3.46`.

## Robots y condiciones revisadas

Se consultaron los siete `robots.txt` y los enlaces de condiciones encontrados en páginas propias. Robots indica preferencias de rastreo; ni un `Allow` concede licencia de datos ni la falta de una regla acredita permiso de redistribución. Las restricciones generales de propiedad intelectual se documentan sin afirmar una conclusión jurídica sobre números aislados.

| Fuente        | Robots observado                                                                                                                                               | Condiciones publicadas relevantes                                                                                                                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kambista      | [200](https://kambista.com/robots.txt), bloquea `/wp-admin/`, permite `admin-ajax.php`; raíz sin bloqueo                                                       | [PDF vigente enlazado](https://neocdn.kambista.com/wp-content/uploads/2026/03/2026-Terminos-y-Condiciones-KAMBISTA-S.A.C.pdf), propiedad de plataforma/contenido y límites de uso del software; no se encontró licencia de datos |
| TuCambista    | [200](https://tucambista.pe/robots.txt), raíz permitida; excluye `?rcode=`                                                                                     | [§9](https://tucambista.pe/terminosycondiciones), restricciones a reproducción y distribución de contenido sin autorización                                                                                                      |
| Securex       | [200](https://securex.pe/robots.txt), excluye `/api` y zonas técnicas/privadas; se eligió portada HTML                                                         | [PDF §6](https://d1wsm5e95h4wcn.cloudfront.net/Resources/WebContent/public/web/pdf/Terminos%26Condiciones.pdf), derechos sobre contenido/marca y usos sujetos a permiso                                                          |
| Cambio Seguro | [200](https://cambioseguro.com/robots.txt), sin exclusión general                                                                                              | [Términos generales](https://cambioseguro.com/terminos-y-condiciones), licencia limitada y restricciones sobre software/plataforma; no licencia de datos verificada                                                              |
| DollarHouse   | [404 en la app](https://app.dollarhouse.pe/robots.txt); no equivale a permiso                                                                                  | [§5](https://dollarhouse.pe/terminos-condiciones-y-politicas-de-privacidad/), derechos sobre contenido e identidad visual sujetos a autorización                                                                                 |
| Rextie        | [200 en landing](https://www.rextie.com/robots.txt), excluye zonas privadas y parámetros `origin` del host consultado; no se verificó aquí robots del host API | [§14](https://www.rextie.com/terminos-y-condiciones/), contenido y uso con fines distintos sujetos a restricciones; su apartado API comercial no equivale a licencia del endpoint público                                        |
| TKambio       | [200](https://tkambio.com/robots.txt), `Disallow` vacío                                                                                                        | [PDF enlazado](https://tkambio.com/wp-content/uploads/2023/11/TERMINOS-Y-CONDICIONES-ACTUAL-2.pdf), sin cláusula de automatización identificada en la revisión; no se encontró una licencia expresa de datos                     |

No se solicitó autorización a terceros ni se enviaron mensajes. Si el gadget se va a publicar o comercializar, resolver el alcance de reutilización con cada proveedor antes de tratar estas páginas como un servicio de datos autorizado.

## Implicación para el gadget y el histórico

Se puede diseñar ya la comparación con siete fuentes cuya extracción se consiguió desde la Pi. TKambio queda como integración condicional por los 403 observados antes del éxito con httpx: cuando falle, mostrar «sin actualización» junto a la antigüedad de su última captura. No mostrar cero ni reutilizar indefinidamente un precio viejo como actual.

Para cada observación guardar proveedor, compra, venta, captura UTC, fecha publicada si es conocida, vencimiento si existe, método de obtención, variante, monto y condiciones aplicables. Las cotizaciones requieren precisión de al menos cuatro decimales. No redondear a dos decimales antes de almacenar.

En las siete casas **no se validó un archivo histórico público descargable de sus propias tasas**. Las búsquedas por dominio, páginas de ayuda, cotizadores y scripts examinados no proporcionaron ese contrato. Esto no demuestra que sea inexistente; significa que el backfill comercial no está confirmado. El histórico verificable comienza con las capturas periódicas propias, sin rellenar el pasado con SBS/BCRP, noticias o cotizaciones de competidores republicadas.
