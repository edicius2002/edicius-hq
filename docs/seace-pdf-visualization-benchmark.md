# Pruebas de carga del visor PDF de SEACE

Fecha: 7 de noviembre de 2026. Se probó la rama `feat/seace-preview-prefetch-performance` sin cambiar el código de producción. El prototipo de streaming vivió solo durante la medición; las solicitudes a SEACE se hicieron en serie, con 1,1 s adicionales entre ellas.

## API: respuesta completa frente a streaming

Una aplicación local de prueba expuso dos rutas sobre el mismo PDF público de prod6 (`433954`, 2.338.665 bytes). La ruta `buffer` llamó a `preview_document` actual, que termina de leer SEACE antes de responder. La ruta `stream` validó la cabecera `%PDF-` y transfirió los fragmentos conforme llegaron. Ambas usaron un cliente HTTP compartido y `GZipMiddleware`; el cliente recibió y verificó el mismo PDF completo en todas las solicitudes. Se excluyó una primera solicitud de calentamiento para comparar tres repeticiones por modo.

| Modo              | Primer byte, mediana | Archivo completo, mediana | Tiempos completos individuales |
| ----------------- | -------------------: | ------------------------: | ------------------------------ |
| Actual, buffer    |             1.569 ms |                  1.579 ms | 1.687, 1.465, 1.579 ms         |
| Prototipo, stream |               129 ms |                  1.509 ms | 1.402, 1.630, 1.509 ms         |

El streaming adelantó el primer byte unos 1,44 s, pero la finalización solo mejoró 70 ms en esta muestra. Esa diferencia es menor que la variación entre solicitudes. El frontend actual espera `response.blob()` completo antes de crear el iframe, por lo que el primer byte temprano no se traduce directamente en una página visible más pronto. La prueba fue local; una conexión API → navegador lenta podría dar otro resultado. El prototipo tampoco resolvió cómo devolver un error HTTP una vez enviados los primeros bytes si el PDF supera el límite de tamaño.

## Navegador: clic hasta carga del iframe

Se instrumentó la página real en `127.0.0.1:5174` con marcas de `performance.now()`, `PerformanceResourceTiming` y el evento `load` del iframe. Se abrió el mismo PDF de una fila de SEACE por la ruta autenticada real; cada prueba cerró el modal antes de repetir. Los clics se dispararon desde la página para medir el flujo React y de red sin el retraso de la herramienta de automatización.

| Anticipación antes del clic | Fin de solicitud relativo al clic | Aparición de `blob:` en iframe | Evento `load` del iframe |
| --------------------------- | --------------------------------: | -----------------------------: | -----------------------: |
| Ninguna, intento 1          |                         ~2.624 ms |                       2.734 ms |                 2.791 ms |
| Ninguna, intento 2          |                         ~3.121 ms |                       3.219 ms |                 3.238 ms |
| Cursor 1 s                  |                          1.946 ms |                       2.036 ms |                 2.047 ms |
| Cursor 2 s                  |                            781 ms |                         894 ms |                   932 ms |
| Cursor 9,66 s               |       6.724 ms **antes** del clic |                         346 ms |                   376 ms |

La precarga inició la solicitud entre 251 y 265 ms después de señalar el enlace. En los dos clics sin anticipación, el iframe emitió `load` entre 19 y 57 ms después de recibir su `blob:` URL. El evento `load` es un indicador del visor listo, **no** una medición exacta del primer píxel legible; no se capturó vídeo de los fotogramas. Las variaciones de SEACE impiden atribuir diferencias pequeñas a una optimización.

## Miniatura y extracción

Se descargaron dos PDF públicos y se inspeccionaron en memoria con PyMuPDF:

| Documento                   |             PDF | Descarga | Texto en primera página | JPEG de primera página a escala 1,3× | Render + codificación |
| --------------------------- | --------------: | -------: | ----------------------: | -----------------------------------: | --------------------: |
| prod6 `433954`, 7 páginas   | 2.338.665 bytes | 2.251 ms |            0 caracteres |                        117.506 bytes |                132 ms |
| prod4 `153221571`, 1 página |    76.129 bytes |   821 ms |            0 caracteres |                         81.020 bytes |                 67 ms |

El PDF grande contenía una imagen JPEG de primera página de 294.201 bytes, que se pudo extraer en ~1 ms **tras descargar el PDF**. En el PDF pequeño, la miniatura JPEG resultó mayor que el PDF. Ninguno de los dos permite una vista textual sencilla de la primera página; haría falta OCR. Crear miniaturas bajo demanda agrega trabajo a la primera apertura. Prepararlas o guardarlas previamente solo conviene si se observan reaperturas o documentos grandes de interés.

## Decisión para esta instalación

El tiempo restante está dominado por la solicitud del PDF, mientras el visor nativo tarda poco después de recibir el `blob:`. No hay evidencia suficiente para reemplazarlo por PDF.js ni para incorporar streaming solo por latencia en la conexión local. La precarga existente es la mejora visible más clara. La siguiente oportunidad concreta es medir cuántas veces se reabre el mismo PDF y, si es frecuente, retener **un** `Blob` por un periodo corto al cerrar el modal. Si la aplicación se usa por una conexión remota lenta, repetir la comparación de streaming desde ese cliente antes de decidir.
