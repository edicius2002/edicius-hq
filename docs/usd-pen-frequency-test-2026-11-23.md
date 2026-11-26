# Ensayo de frecuencia USD/PEN — 23 de noviembre de 2026

## Método

Prueba sin navegador y sin escrituras en producción, desde el equipo Windows de
desarrollo (no desde la Raspberry Pi). Se ejecutó el adaptador real `fetch` de
`services/api/app/services/fx/providers.py`, con un cliente por proveedor y sin
solapamiento de solicitudes a una misma fuente. No se usaron credenciales.

Ventana: 12:01:45–12:06:17 America/Lima, aproximadamente 4 minutos 32 segundos.
Una captura inicial, dos intervalos de 60 segundos y cinco intervalos de 30
segundos. Se detuvo cada fuente ante su primer error, sin reintentos. No se
consultaron referencias diarias BCRP/SBS para este ensayo intradía.

## Resultados

35 solicitudes: 32 cotizaciones válidas y tres errores. Ningún HTTP 403 o 429.

| Fuente        | Capturas válidas / intentos | Cambios de compra/venta | Mediana  | Máximo    |
| ------------- | --------------------------- | ----------------------- | -------- | --------- |
| DollarHouse   | 8/8                         | 0                       | 535 ms   | 574 ms    |
| Rextie        | 8/8                         | 1                       | 555 ms   | 640 ms    |
| Tu Cambista   | 8/8                         | 1                       | 805 ms   | 836 ms    |
| TKambio       | 8/8                         | 1                       | 2.206 ms | 24.630 ms |
| Kambista      | 0/1                         | No evaluable            | 1.107 ms | 1.107 ms  |
| Securex       | 0/1                         | No evaluable            | 920 ms   | 920 ms    |
| Cambio Seguro | 0/1                         | No evaluable            | 1.314 ms | 1.314 ms  |

Los tres cambios se observaron durante la fase de 60 segundos:

- TKambio: venta de 3.462 a 3.461 a las 12:02:45.
- Rextie: compra/venta de 3.4366/3.4705 a 3.4361/3.4700 a las 12:03:45.
- Tu Cambista: compra/venta de 3.4375/3.4635 a 3.437/3.463 a las 12:03:45.

Las 20 lecturas de la fase de 30 segundos fueron válidas; ninguna detectó un
cambio adicional frente a la lectura anterior. No demuestra que 30 segundos no
aporte valor en otros momentos. TKambio tuvo una respuesta de 24,63 segundos en
esa fase; no se puede atribuir causalmente esta demora al intervalo del ensayo.

Kambista y Securex devolvieron HTTP 200, pero el parser produjo `missing-quote`
en la etapa HTML. Cambio Seguro devolvió HTTP 200 y luego `transport-error`
durante lectura del cuerpo. El estado HTTP por sí solo no garantiza una captura.

## Comprobaciones offline

- Proveedores, recolector y retención: **77 pruebas pasaron** con Python 3.13.13
  disponible en el equipo. El entorno virtual del repo apuntaba a un Python 3.12
  inexistente. Hubo avisos de deprecación y permiso de caché de pytest, sin fallos.
- Frontend FX: **32 pruebas pasaron**, incluida actualización de celdas y paths
  SVG en dos ciclos de 60 segundos, sin inspección visual.
- Simulación de `collect_once` real con proveedor falso y SQLite temporal:
  invocaciones en 0, 30, 60, …, 300 segundos solo capturaron en **0 y 240**.
  Confirma que reducir el timer no elimina el vencimiento interno de 4 minutos.

## Decisión sustentada y límites

Hay evidencia de cambios reales recuperables con consultas cada 60 segundos.
DollarHouse, Rextie y Tu Cambista son candidatos a un piloto sostenido de 60
segundos y evaluación posterior de 30 segundos. TKambio requiere aislar sus
demoras antes de acelerar el recorrido completo. Reparar Kambista/Securex y
diagnosticar Cambio Seguro antes de incluirlos en un piloto acelerado.

Este ensayo corto no demuestra estabilidad durante 24 horas, cuotas permitidas,
comportamiento desde la Pi ni latencia completa hasta Neon y la UI. No se probó
polling del navegador a 5 segundos ni se cambiaron los intervalos productivos.
Los timestamps comerciales del adaptador son horas de captura locales, no
timestamps de publicación proporcionados por el proveedor.

## Evidencia

- [Outputs y métricas JSON](usd-pen-frequency-test-2026-11-23.json).
- Harness local: `.local-data/diagnostics/fx-frequency-20261123/probe.py`.
- Output original local: `.local-data/diagnostics/fx-frequency-20261123/results.jsonl`.
- Pruebas backend: `python -m pytest tests/test_fx_providers.py tests/test_fx_collector.py tests/test_fx_retention.py -q` (desde `services/api`, con `--basetemp` dentro del workspace).
- Pruebas frontend: `npm.cmd run test -w web -- src/features/dashboard/fx`.
