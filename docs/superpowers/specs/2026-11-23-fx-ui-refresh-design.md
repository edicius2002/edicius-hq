# USD/PEN: actualización perceptible y datos atrasados

Estado: propuesta para ejecutar en una rama y entregar al usuario para revisión.

## Objetivo y evidencia

El dashboard debe mostrar si está consultando, cuándo terminó una consulta correcta
y qué antigüedad tienen las observaciones que presenta. Una consulta correcta no
significa que la fuente haya publicado una nueva cotización.

La revisión del 23 de noviembre comprobó que `useFx` consulta cada 60 segundos y
que dos ciclos con respuestas nuevas actualizan las celdas y los paths SVG sin
remontar el gráfico. Pasaron 32 pruebas del módulo. Neon no tiene suscripción de
eventos en este adaptador. El polling se pausa en segundo plano y el proveedor
global desactiva la consulta al recuperar foco. El texto `Stale` está oculto
visualmente. Kambista es la selección predeterminada; en la consulta realizada
ese día estaba atrasada, al igual que Securex.

## Enfoques

Propuesta del agente: conservar polling de 60 segundos, recuperar datos al volver
y exponer frescura real. Es suficiente para capturas comerciales cada 5 minutos.
Reducir el intervalo aumenta consultas sin resolver fuentes atrasadas. Introducir
streaming Neon exige otro alcance y tampoco repara la adquisición de proveedores.

## Comportamiento propuesto

- Mantener el intervalo de 60 segundos con la pestaña visible. Al recuperar foco,
  consultar si la caché está vencida; usar `staleTime: 30_000` explícito para FX.
  Mantener consulta al reconectar y la pausa en segundo plano.
- Estado compacto en la cabecera: `Updating…`, `Checked <hora Lima>` o
  `Refresh failed`. Mostrar `Offline` si las consultas están pausadas por red.
  La hora de éxito conjunto es el mínimo de los `dataUpdatedAt` de cotizaciones
  e historial activos, solo cuando ambos tienen datos y no están en error.
  No conservar una hora de éxito del historial de otra fuente/rango.
- Una etiqueta junto a cada fuente muestra la edad de `observed_at`; para datos
  atrasados, `Stale · <edad>`. Usar `age`, `time` y `freshness` existentes.
  No sumar una cuarta columna. Mostrar la fecha exacta en un tooltip accesible.
- Encima del gráfico, mostrar fuente seleccionada y última captura del historial
  activo. Si está atrasada, mostrar `No recent captures`; si no hay puntos,
  conservar el estado vacío. Usar la última observación por `observed_at`.
- Conservar selección y preferencias. No cambiar automáticamente a otra fuente.
  No dibujar puntos artificiales ni animar precios cuando no cambiaron.
- Conservar datos durante consultas y errores; distinguir error de lectura de
  fuente atrasada. Un fallo no debe etiquetar los datos como recién actualizados.
- Mantener estilo compacto, tres columnas, escritorio y móvil, y textos en inglés
  conforme a la UI existente. No anunciar cada minuto por lector de pantalla.

## Límites

Sin nuevas dependencias, cambios de esquema, cambio global de React Query ni
modificaciones de recolectores. Los umbrales actuales de `freshness` se conservan;
las referencias oficiales no se presentan como cotizaciones en vivo. Diagnosticar
y reparar los proveedores atrasados requiere una tarea de backend independiente.

## Aceptación

Un usuario puede distinguir consulta en curso, éxito sin cambio de precio, fallo,
falta de conexión y captura atrasada. Nuevas respuestas cambian tabla y gráfico;
volver a la pestaña con datos vencidos inicia una consulta sin esperar otro minuto.
La rama se entrega para revisión sin merge ni despliegue.
