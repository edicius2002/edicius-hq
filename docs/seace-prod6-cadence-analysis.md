# Cadencia de prod6 desde bodas

Fecha: 23 de octubre de 2026. Los horarios de las pruebas corresponden a America/Lima.

## Evidencia

La primera pasada con telemetria termino a las 08:21:48. Duro 2 min 19 s y produjo 70 intentos prod6 en 9,6 s: 23 HTTP 200 y 47 HTTP 403. Los tres search fueron 200; 43 detail y cuatro files recibieron 403. El primer 403 fue el intento 16, unos 7,3 s despues del primero. El maximo observado fue cinco solicitudes simultaneas y 27 respuestas terminaron dentro de un mismo segundo. Ningun 403 trajo Retry-After. La cola mantuvo 47 IDs pendientes y ocho completos.

Una consulta serial con las mismas cabeceras del MCP todavia recibio 403 varios minutos despues, incluso sobre un ID antes exitoso. A las 08:30, una busqueda con esas cabeceras recibio 200. Un User-Agent generico recibio 403 entre dos busquedas 200 con las cabeceras del MCP, por lo que las sondas con esa cabecera generica no sirven para medir el tiempo de recuperacion.

Con las cabeceras del MCP se probaron 20 detalles distintos a un inicio cada dos segundos: 20 HTTP 200. Despues de una pausa se probaron otros 20 detalles a un inicio cada segundo: 20 HTTP 200. Tras otra pausa se probaron 25 IDs alternando detail y files, con un inicio por segundo: 50 HTTP 200. Cada prueba se detenia al primer rechazo. Estas solicitudes diagnosticas no se guardaron en la cola ni se publicaron.

## Interpretacion y decision

La correlacion entre la rafaga y los 403, seguida por recuperacion posterior y resultados 200 a ritmos menores, apoya un control temporal sensible a la velocidad de solicitudes. No identifica su regla exacta ni excluye controles por IP, sesion o cabeceras. La documentacion oficial revisada no publica una cuota HTTP para prod6; ver seace-prod6-official-limits.md.

El transporte debe conservar el maximo de cinco solicitudes simultaneas y separar los inicios de todas las solicitudes prod6 de un mismo proceso MCP por al menos un segundo. La cola ya conserva los IDs rechazados. El espaciado debe ser configurable y aplicarse a search, detail, files y reintentos. Un segundo es la cadencia inicial medida, no una garantia permanente. Observar varias pasadas completas, incluidas las que reintentan pendientes, antes de aumentar el ritmo.

## Verificacion operativa

- Contar respuestas por estado y fase en los eventos seace.prod6 de cada pasada.
- Comprobar que la distancia entre inicios inferidos de timestamp menos latency_ms sea de al menos un segundo, salvo precision de reloj.
- Vigilar IDs pendientes, duracion total, y los timestamps de notices, processes y contracts despues de cada pasada.
- Si aparece un 403, detener las pruebas activas y conservar la cola; la ausencia de Retry-After no autoriza reintentos inmediatos.
