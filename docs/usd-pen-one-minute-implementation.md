# USD/PEN: captura cada minuto y casos límite

Fecha: 2026-11-23. Rama: `fix/fx-one-minute-collection`.
Estado: implementado y probado localmente; no desplegado en la Raspberry Pi.

## Cambio

Timer UTC cada 60 segundos, jitter máximo configurado de 2 segundos y precisión
de 1 segundo. El recolector permite una nueva captura comercial tras 55 segundos
para tolerar diferencias entre rondas. Las referencias continúan cada 4 horas,
con el mismo margen de 5 segundos. La UI conserva su polling actual de 60 segundos.

## Casos límite comprobados

| Caso                                       | Comportamiento y evidencia                                                                                             |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Jitter menor en la siguiente ronda         | La fuente vuelve a estar disponible en el siguiente minuto; prueba parametrizada comercial/oficial.                    |
| Cotización idéntica cada minuto            | Once capturas válidas en diez minutos producen dos observaciones persistidas; salud se actualiza en cada éxito.        |
| Precio cambia cada minuto                  | Tres precios producen tres observaciones locales y remotas mediante cloud de prueba.                                   |
| Fuente devuelve 429                        | Su cooldown permanece mientras otras fuentes se capturan cada minuto.                                                  |
| 429 llega 25 s después con Retry-After: 60 | Se reintenta a partir de t+85, no t+60. Se reprodujo el fallo antes de corregirlo.                                     |
| Retry-After con fecha absoluta             | Se conserva el vencimiento absoluto (respetando los límites existentes de 60 s a 24 h), sin sumar de nuevo la demora.  |
| Parser Kambista falla                      | Primer reintento conserva espera de cinco minutos; posteriores fallos usan el backoff existente.                       |
| SQLite de una versión anterior             | Vencimientos pendientes de 4 minutos y de 6 horas sobreviven al cambio; después del éxito se aplica la nueva cadencia. |
| Dos procesos FX                            | El lock no bloqueante rechaza al segundo. No hay nuevas ejecuciones concurrentes del servicio.                         |
| Caída remota / confirmación incompleta     | Suite existente verifica archivo durable, outbox y replay sin pérdida ni duplicación.                                  |

## Límites operativos pendientes

- Fuentes siguen siendo secuenciales. Una respuesta lenta, una pasada que dura más
  de un minuto o problemas de replicación pueden exceder la cadencia nominal.
  El timer no ejecuta dos instancias simultáneas del mismo servicio.
- Kambista/Securex necesitan reparar sus parsers; Cambio Seguro necesita diagnóstico
  de transporte. Este cambio no convierte sus fallos en capturas válidas.
- El ensayo previo desde Windows observó TKambio hasta 24,63 segundos. Antes de
  probar intervalos menores, aislar fuentes lentas y medir duración de las pasadas
  y de la replicación desde la Pi.
- Los límites 403/429 y los vencimientos existentes no se reinician al desplegar.
- Mayor frecuencia aumenta trabajo y registros de ejecución aunque la cotización
  no cambie. Mantener observación operativa durante 24–48 horas.

## Verificación

- 125 pruebas pasaron, una omitida (`systemd-analyze` no disponible en Windows).
- Ruff y mypy de los módulos modificados pasaron.
- La revisión independiente detectó el cooldown contado desde el inicio de la
  pasada; se corrigió con regresión roja→verde. Revisión posterior sin hallazgos.
- Python disponible: 3.13.13. No se ejecutó una prueba visual ni se alteró producción.

Comando de pruebas desde `services/api` (PowerShell):

```powershell
$fxTests = @(rg --files tests -g 'test_fx*.py')
python -m pytest @fxTests tests/test_process_lock.py ../../ops/pi/tests/test_fx_lifecycle.py -q
```

Se usó un `--basetemp` dentro de `.local-data` y `-p no:cacheprovider` por los
permisos del entorno. El despliegue debe instalar conjuntamente código y timer
mediante el procedimiento de release fijado del runbook, recargar systemd y
validar ejecuciones reales; cambiar solo el timer no activa la nueva cadencia.
