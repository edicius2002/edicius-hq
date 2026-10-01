# Fuentes para el gadget USD/PEN

> Validación posterior: [matriz completa y pruebas desde Raspberry Pi](usd-pen-validation.md), incluyendo TKambio y endpoints directos. Esta nota conserva el inventario y las pruebas iniciales.

Investigación: 29 de septiembre de 2026. Alcance: páginas públicas, lectura web y solicitudes HTTP puntuales desde este equipo. No se implementó colector ni se probó desde la Raspberry Pi. Los precios observados sirven para comprobar presencia de datos; no son una cotización vigente para operar.

## Cuánto Está el Dólar: cobertura comprobada

La [portada](https://cuantoestaeldolar.pe/) presenta Paralelo/Ocoña, pestaña Sunat, dólar digital y cambio online. Su tabla online no devolvió las filas en la extracción web utilizada. El sitio actúa como publicador/comparador; cada casa de cambio sigue siendo el proveedor de su cotización. Conviene guardar ambas identidades.

Inventario **parcial y variable** observado en páginas propias; no equivale a la lista íntegra de casas activas en la tabla principal:

| Evidencia                                                                                 | Nombres observados                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [FAQ](https://cuantoestaeldolar.pe/preguntas)                                             | DollarHouse, Cambio Seguro, TKambio, Securex. El texto no indica fecha de actualización.                                                                                                       |
| [Ficha Tu Cambista](https://cuantoestaeldolar.pe/tu-cambista) y sus recomendaciones       | Tu Cambista, Western Union, Cambio Mundial, CambiaFX, Dollar House, Inka Money, Dichikash, Money House; también un rótulo `kambio online 2` enlazado a kambio.com.pe, pendiente de normalizar. |
| [Página bancaria](https://cuantoestaeldolar.pe/dolar-interbancario) y sus recomendaciones | Mercado Cambiario, Dolarex, Chaski Dolar, además de varias casas anteriores. Otra extracción indexada mostró Cambiosol; las recomendaciones varían.                                            |
| [Portada](https://cuantoestaeldolar.pe/)                                                  | Una extracción mostró Tu Cambista en el feed del día y otra Fluyez. No prueba que toda la tabla esté disponible.                                                                               |

La [página bancaria](https://cuantoestaeldolar.pe/dolar-interbancario) sí tiene cotizaciones de compra/venta, además de los filtros por bancos que aparecen en las casas online. Menciona BCP, Interbank, Continental/BBVA, Scotiabank y Banco de la Nación; también enlaza CocosyLucas de BCP. Afirma actualizar tres veces al día y califica sus precios como referenciales, sujetos a horario y políticas comerciales. La extracción no conservó nombres junto a cada par numérico: no se asignaron precios a bancos por posición. Un filtro de transferencias de una casa no convierte a ese banco en proveedor del precio.

La [sección dólar digital](https://cuantoestaeldolar.pe/dolar-digital) se presenta como USDT/USDC y muestra publicidad/enlace de Lemon. Separar stablecoins de USD bancario; no atribuir automáticamente todo precio digital a Lemon solo por el anuncio.

## Histórico y automatización de CED

El [historial público](https://cuantoestaeldolar.pe/historial) muestra Bloomberg, períodos y calendario, y describe los valores como promedios diarios. La extracción entregó estados sin datos/cargando. No se comprobó exportación ni histórico de cada casa. Su presencia no permite prometer un backfill intradía o por proveedor. Para cada fuente comercial se debe asumir histórico desde el inicio de nuestras capturas, salvo verificar después un archivo específico.

Los [términos, sección 02](https://cuantoestaeldolar.pe/term-cond) contienen una restricción explícita al software que automatiza interacción o descarga. La sección 08 indica que las posiciones publicitarias dependen de antigüedad y contratos: el orden del sitio no es un ranking del mejor precio. Recomendación de proyecto: usar CED como referencia y solicitar un canal autorizado o integrar fuentes directas tras comprobar sus condiciones. Esta observación describe los términos publicados; no determina por sí sola una conclusión jurídica universal.

Una solicitud GET con Python urllib a la raíz de CED recibió **HTTP 403**. No se reintentó con evasión, proxies ni credenciales; no se inspeccionaron bundles ni se validó API JSON. Por tanto, un colector CED periódico en la Pi no está técnicamente comprobado.

## Fuentes directas candidatas

| Fuente directa                             | Evidencia pública del 29/09/2026                                                                                  | Validación técnica y límites                                                                                            |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| [DollarHouse](https://app.dollarhouse.pe/) | Compra/venta numéricas, cotizador y estado de horario visibles.                                                   | GET Python 200, 25.624 caracteres. No se implementó parser ni API.                                                      |
| [Cambio Seguro](https://cambioseguro.com/) | Compra/venta numéricas, cupón, cotización preferencial por monto y PromoFLASH.                                    | GET Python 200, 348.643 caracteres. Falta parser y revisión específica de condiciones para colector.                    |
| [Securex](https://securex.pe/)             | Compra/venta numéricas y campo de cupón.                                                                          | GET Python 200, 103.004 caracteres; cifras observadas presentes en HTML. Falta parser y revisión de condiciones.        |
| [Tu Cambista](https://tucambista.pe/)      | Compra/venta numéricas, cupón y comparación con otros proveedores. La comparación publica fecha/hora.             | GET Python 200, 155.903 caracteres. No confundir cotizaciones de competidores republicadas con datos directos de éstos. |
| [TKambio](https://tkambio.com/)            | Calculadora con etiquetas compra/venta, cupones y TKOfertas; la extracción no devolvió valores numéricos propios. | GET Python 403. No se evadió. Existe app pública indexada con precios, pero no se validó como canal estable.            |
| [Kambista](https://kambista.com/)          | El agente principal verificó compra/venta numéricas en web pública durante esta investigación.                    | Extracción periódica/API pendiente de validar.                                                                          |
| [Rextie](https://www.rextie.com/)          | El agente principal observó cotizador, pero valores `0.0000`/actualizando en la extracción.                       | Nunca almacenar esos placeholders como cotizaciones. Extracción periódica pendiente.                                    |

HTTP 200 o una cifra visible no garantiza permiso de automatización, estabilidad del formato, actualidad del dato ni disponibilidad desde la Pi. Estas son candidatas, no siete integraciones ya operativas. No se verificó un archivo histórico público por cada casa.

## Condiciones que debe representar el gadget

- Compra significa que la entidad compra los dólares del usuario; venta significa que la entidad se los vende. Puede expresarse como «Te compran USD» y «Te venden USD». [Explicación de Cambio Seguro](https://cambioseguro.com/articulos/que-es-compra-y-venta-de-dolares).
- La tasa estándar y la promocional deben ser series diferentes. Cambio Seguro tiene promociones por banco y monto, y precio preferencial para más de USD 3.000. [Cotizador](https://cambioseguro.com/).
- TKambio anuncia TKOfertas para bancos específicos y cupones/puntos; no aplicar automáticamente una mejora a todos los usuarios. [TKambio](https://tkambio.com/).
- Securex distingue su precio público de una mejora comercial validada contra otra cotización. [Condiciones de promociones](https://securex.pe/promociones).
- Guardar hora de captura y hora publicada por la fuente por separado. Si sólo conocemos captura, rotularla como tal. Conservar disponibilidad/horario, monto, banco, variante y proveedor/publicador cuando existan.
- Ordenar por el mejor precio elegible: compra más alta para vender USD; venta más baja para comprar USD. Excluir de ese destaque cotizaciones ausentes, placeholders y valores vencidos.

## Recomendación para Raspberry Pi

Empezar por adaptadores HTTP pequeños para fuentes cuyo acceso y condiciones se validen; evitar que el dashboard lance scraping al abrirse. La Pi consulta, valida y almacena observaciones, y el gadget lee el histórico persistido. Propuesta inicial para precios comerciales: cada 10–15 minutos durante su horario y una captura al cierre; ajustar según autorización, frecuencia real y carga. Es una decisión de diseño, no una frecuencia publicada por todas las fuentes.

Mantener referencia BCRP/SBS diaria como serie independiente. No completar el pasado de una casa usando tasas oficiales de otra fuente. Las pruebas actuales no permiten asegurar backfill comercial ni acceso operativo desde la Pi.
