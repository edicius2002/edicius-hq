# Cadencia de prod6 desde bodas

Fecha: 23 de octubre de 2026. Los horarios de las pruebas corresponden a America/Lima.

## Evidencia

La primera pasada con telemetria termino a las 08:21:48. Duro 2 min 19 s y produjo 70 intentos prod6 en 9,6 s: 23 HTTP 200 y 47 HTTP 403. Los tres search fueron 200; 43 detail y cuatro files recibieron 403. El primer 403 fue el intento 16, unos 7,3 s despues del primero. El maximo observado fue cinco solicitudes simultaneas y 27 respuestas terminaron dentro de un mismo segundo. Ningun 403 trajo Retry-After. La cola mantuvo 47 IDs pendientes y ocho completos.

Una consulta serial con las mismas cabeceras del MCP todavia recibio 403 varios minutos despues, incluso sobre un ID antes exitoso. A las 08:30, una busqueda con esas cabeceras recibio 200. Un User-Agent generico recibio 403 entre dos busquedas 200 con las cabeceras del MCP, por lo que las sondas con esa cabecera generica no sirven para medir el tiempo de recuperacion.

Con las cabeceras del MCP se probaron 20 detalles distintos a un inicio cada dos segundos: 20 HTTP 200. Despues de una pausa se probaron otros 20 detalles a un inicio cada segundo: 20 HTTP 200. Tras otra pausa se probaron 25 IDs alternando detail y files, con un inicio por segundo: 50 HTTP 200. Cada prueba se detenia al primer rechazo. Estas solicitudes diagnosticas no se guardaron en la cola ni se publicaron.

## Interpretacion y decision

La correlacion entre la rafaga y los 403, seguida por recuperacion posterior y resultados 200 a ritmos menores, apoya un control temporal sensible a la velocidad de solicitudes. No identifica su regla exacta ni excluye controles por IP, sesion o cabeceras. La documentacion oficial revisada no publica una cuota HTTP para prod6; ver seace-prod6-official-limits.md.

El transporte debe conservar el maximo de cinco solicitudes simultaneas y separar los inicios de todas las solicitudes prod6 de un mismo proceso MCP por al menos un segundo. La cola ya conserva los IDs rechazados. El espaciado debe ser configurable y aplicarse a search, detail, files y reintentos. Un segundo es la cadencia inicial medida, no una garantia permanente. Observar varias pasadas completas, incluidas las que reintentan pendientes, antes de aumentar el ritmo.

## Primera validacion en el colector desplegado

El commit 3b8dfa02e54acd9712d3e60c07de94034080f82a se instalo en `bodas`.
La pasada de las 08:49:53 a las 08:52:39 duro 2 min 46 s. Los 45 intentos
prod6 fueron HTTP 200: tres search, 20 detail y 22 files. La distancia minima
estimada entre inicios a partir de los eventos fue 1,0006 s. La cola paso de
ocho a 30 IDs con ambas fases completas; quedaron 25 con ambas pendientes y
dos con solo archivos pendientes. Los tres snapshots terminaron con timestamp
08:52:30. Una pasada correcta demuestra progreso con esta carga, no una cuota
segura universal.

## Segundo ciclo programado: despliegue reemplazado

La ejecucion programada de las 09:01 arranco desde la release
`f30f09860980984dea01d95c6e90d576ddba4269`, instalada a las 08:55,
despues de la release con espaciado. Su `server.py` carece de
`SEACE_PROD6_MIN_INTERVAL_SECONDS`; el journal registra 32 solicitudes prod6
en 8,75 s, hasta cinco simultaneas, con 19 HTTP 200 y 13 HTTP 403.
No es una prueba de fallo a una solicitud por segundo: esa version no aplico
el espaciado. Se detuvo temporalmente solo el timer programado de SEACE
para evitar otra rafaga mientras se integran ambas ramas. El timer de
solicitudes manuales sigue activo.

En ambas rafagas sin espaciado, el primer 403 fue la respuesta numero 16:
antes hubo 15 respuestas 200, y el rechazo aparecio a los 7,29 s y 7,72 s
del primer resultado, respectivamente. Los inicios estimados de esos primeros
403 estaban a 8,30 s y 8,78 s del primer inicio. Esta repeticion apunta a un
umbral de rafaga de corta ventana. No permite afirmar una regla exacta como
"15 solicitudes cada 10 segundos": las respuestas concurrentes pueden llegar
desordenadas y el servidor no publica la ventana ni la identidad de la cuota.

## Segunda validacion con espaciado

Despues de combinar el commit de Airfare presente en `main`, se desplego
`8c786b302a580a442de4f98bc16f7213be486245` y se inicio otra pasada
real. Sus 41 solicitudes prod6 (tres search, 17 detail, 21 files) fueron
HTTP 200. La distancia minima inferida entre inicios fue 1,0008 s. Sumadas
a la primera pasada espaciada, son 86/86 respuestas HTTP 200. Inmediatamente
despues, otro despliegue desde la rama de Airfare sustituyo esta release;
el commit posterior de esa rama se incorporo tambien a la integracion SEACE.
La cadencia de un segundo sigue siendo provisional hasta observar varias
ejecuciones programadas consecutivas con la version integrada.

## Verificacion operativa

- Contar respuestas por estado y fase en los eventos seace.prod6 de cada pasada.
- Comprobar que la distancia entre inicios inferidos de timestamp menos latency_ms sea de al menos un segundo, salvo precision de reloj.
- Vigilar IDs pendientes, duracion total, y los timestamps de notices, processes y contracts despues de cada pasada.
- Si aparece un 403, detener las pruebas activas y conservar la cola; la ausencia de Retry-After no autoriza reintentos inmediatos.
