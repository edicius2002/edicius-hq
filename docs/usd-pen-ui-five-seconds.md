# UI USD/PEN: consultas cada cinco segundos

Implementado el 2026-11-23 en `fix/fx-one-minute-collection`; pendiente de despliegue.

- Cotizaciones: cada 5 segundos con la pestaña visible.
- Historial: invalidación por fuente cuando cambia una observación (también si
  conserva el precio pero cambia su fecha), más reconciliación cada 60 segundos.
- Capturas de otra fuente no provocan consultas del gráfico seleccionado.
- Al recuperar foco o conexión se consultan los datos vencidos, incluso con la
  configuración global que desactiva el refresco al foco.
- Polling pausado en segundo plano y sin conexión; no se solapan solicitudes
  lentas de cotizaciones.
- Los eventos Supabase consultan latest; el mismo detector de cambios actualiza
  el historial. Esto evita una segunda descarga por cada evento. Revisiones
  antiguas que no alteran latest se recogen en la reconciliación de un minuto.
- Se conserva el aislamiento por usuario, cancelación al salir y caché al navegar.

Verificación sin navegador: 57 pruebas de FX/Dashboard pasaron, incluyendo dos
ciclos de 5 segundos con cambios de celdas y paths SVG, cotizaciones idénticas,
cambio de otra fuente, reconciliación, foco, reconexión y solicitudes lentas.
Typecheck, ESLint de los archivos modificados y build pasaron. La regresión de
Realtime detectó tres solicitudes de historial en lugar de dos (inicial y una
actualización); se corrigió y comprobó antes de cerrar el cambio.

Esta frecuencia lee la réplica: no adelanta la publicación del proveedor ni la
captura del recolector. Cinco segundos es la cadencia nominal de consulta, no
una garantía de latencia de extremo a extremo. No se realizó carga sostenida
contra Neon ni validación visual en este cambio.
