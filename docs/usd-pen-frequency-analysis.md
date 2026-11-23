# Viabilidad de mayor frecuencia USD/PEN

Fecha: 2026-11-23. Análisis; no se cambiaron intervalos ni configuración productiva.

## Conclusión

Probar primero captura comercial cada 60 segundos y lectura de últimas
observaciones cada 5 segundos. Evaluar 30 segundos por proveedor solo después
de medir estabilidad y utilidad. No existe un mínimo seguro demostrado para
los endpoints públicos actuales. Fuentes externas: [investigación](usd-pen-frequency-sources.md).

## Evidencia del repositorio

- `apps/web/src/features/dashboard/fx/useFx.ts`: latest e history cada 60 segundos.
- `apps/web/src/features/dashboard/fx/data.ts`: suscripción desactivada en Neon.
- `ops/pi/systemd/edicius-fx.timer`: cada 5 minutos, retraso aleatorio de 30 segundos.
- `services/api/app/services/fx/collector.py`: vencimiento comercial a 4 minutos
  (cadencia menos margen de 1 minuto), referencias casi cada 4 horas. Fuentes
  procesadas secuencialmente y envío remoto después de completar el recorrido.
- `services/api/app/services/fx/providers.py`: timeout HTTP de 30 segundos;
  429 respeta Retry-After acotado; 403 espera 6 horas. Varias fuentes usan HTML.
- `services/api/app/services/fx/retention.py`: conserva cada cambio; si la
  cotización comercial no cambia, conserva una observación cada 10 minutos.
- `neon/migrations/20261111_public_compat.sql`, `read_fx_history`: devuelve el
  rango completo; 1D/7D conservan observaciones, 1M/1Y/ALL agregan por día.

## Latencia y carga estimadas

Modelo ideal sin red, ejecución, jitter, errores ni colas. Si un cambio persiste
hasta la siguiente captura, la espera nominal es menor que captura + lectura;
el promedio aproximado es la mitad si las fases se distribuyen uniformemente.

| Captura / lectura UI    | Espera nominal máxima aproximada | Promedio aproximado |
| ----------------------- | -------------------------------- | ------------------- |
| 300 s / 60 s actuales   | 360 s                            | 180 s               |
| 60 s / 5 s piloto       | 65 s                             | 32,5 s              |
| 30 s / 5 s experimental | 35 s                             | 17,5 s              |

No son SLA. Un cambio transitorio entre capturas puede perderse por completo.
Con siete fuentes comerciales, una solicitud por fuente y captura, operación
24 horas sin fallos: 2.016 solicitudes/día a 300 s, 10.080 a 60 s y 20.160 a 30 s.
La UI actual hace unas 120 RPC/hora por pestaña visible. Llevar ambas consultas
a 5 s produciría unas 1.440 RPC/hora, incluyendo historiales completos repetidos.
Consultar solo latest a 5 s supone unas 720 RPC/hora más las lecturas de historial.
No se calculó precio monetario ni se midieron payloads o tiempos de producción.

## Cambios necesarios antes de acelerar

1. Reparar o diagnosticar las fuentes atrasadas. Una respuesta inválida no se
   arregla consultando más veces.
2. Configurar cadencia por fuente y ajustar conjuntamente timer, margen y jitter.
   Reducir solo el timer no supera el `next_due` actual; restar el margen actual
   de un intervalo de 30 segundos daría un período negativo.
3. Evitar que una fuente lenta retrase a las demás y al envío de observaciones:
   concurrencia limitada o programación independiente, manteniendo seguridad de
   SQLite, exclusión entre procesos, archivo durable y replay idempotente.
4. UI: latest cada 5 segundos solo visible, refresco al foco y al reconectar.
   Reconsultar el historial seleccionado cuando cambia su observación, y mantener
   reconciliación periódica para revisiones antiguas y ventanas móviles.
5. Vista 1D para cambios intradía; no forzar la preferencia guardada. Si sube mucho
   el número de puntos, medir antes de añadir lectura incremental o agregación.
6. Conservar la deduplicación: no añadir puntos artificiales. Separar salud de
   consulta de la edad de la observación en los indicadores.

## Piloto y decisión

Medir por proveedor durante 24–48 horas incluyendo horario comercial: duración
p50/p95, cambios efectivos, bytes, errores de parser, HTTP 403/429, cola de envío
y demora captura→réplica→UI. Comparar con baseline antes de probar 30 segundos.
Respetar las esperas del proveedor; revertir la cadencia de una fuente si aumenta
el bloqueo o se acumula trabajo. El piloto mide viabilidad operativa, no autoriza
uso ilimitado ni sustituye un contrato de API.

Para segundos reales de extremo a extremo hace falta una fuente con streaming
y condiciones explícitas, más entrega por eventos a la UI. Acelerar Neon o usar
SSE por sí solo no reduce el tiempo que tardamos en descubrir el cambio upstream.
