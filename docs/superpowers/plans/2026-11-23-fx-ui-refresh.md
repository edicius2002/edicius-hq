# USD/PEN UI Refresh Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Hacer visible y verificable la actualización de datos y gráfico USD/PEN.

**Architecture:** Conservar `useFx` como dueño de las consultas. Corregir únicamente
las opciones FX y presentar sus estados en `UsdPenGadget`, reutilizando las
funciones de frescura existentes. `FxChart` sigue dibujando el historial recibido.

**Tech Stack:** React, TypeScript, TanStack Query, Vitest, Testing Library, CSS Modules.

**Spec:** [Diseño](../specs/2026-11-23-fx-ui-refresh-design.md).

## Global Constraints

- Polling visible: 60 segundos. Caché FX vigente: 30 segundos.
- Tres columnas; sin dependencias nuevas, cambios globales ni cambios de backend.
- Conservar preferencias y datos durante consultas; no simular movimiento.
- Rama propuesta: `fix/dashboard-usd-pen-refresh`; entregar sin merge ni despliegue.
- La única modificación inicial observada en `main` es la prueba añadida en
  `apps/web/src/features/dashboard/fx/UsdPenGadget.test.tsx`; preservarla.

## Review Focus

1. Volver después de varios minutos oculto: refresco inmediato de datos vencidos (tarea 1).
2. Consulta correcta sin cambio de precio: cambia la hora de consulta, no la captura (tarea 2).
3. Una consulta falla y otra funciona: no mostrar éxito conjunto (tarea 2).
4. Cambiar fuente/rango o cerrar sesión durante una petición: no mezclar datos (tareas 1–2).
5. Fuente atrasada, vacía o referencia oficial: señales correctas sin inventar precios (tarea 2).

## Tarea 1: Rama y recuperación del refresco

**Archivos:** `apps/web/src/features/dashboard/fx/useFx.ts`, `useFx.test.tsx`
y la prueba existente `UsdPenGadget.test.tsx` del mismo directorio.

**Interfaces:** Conservar `useFx(source: Source, range: Range)` y su retorno
`{ latest, history }`. Ningún consumidor requiere nueva API.

- [ ] Revisar `git status`, rama y diff. Crear `fix/dashboard-usd-pen-refresh`
      desde la base verificada, preservando los documentos y la prueba existente.
      Si se usa worktree, transferir solo estos cambios mediante un patch revisado.
- [ ] Ejecutar baseline: `npm.cmd run test -w web -- src/features/dashboard/fx`.
      Baseline registrado: 32 pruebas pasan.
- [ ] Añadir pruebas con reloj controlado y `focusManager`: tras ocultar 120 segundos
      no hay nuevos fetch; al volver se consultan latest/history; volver antes de 30
      segundos no consulta de nuevo. Usar defaults equivalentes a `QueryProvider`.
- [ ] Añadir caso de reconexión con caché vencida; restaurar managers y timers al
      terminar. Conservar tests de cambio de propietario y cancelación tras sign-out.
- [ ] Ejecutar `npm.cmd run test -w web -- src/features/dashboard/fx/useFx.test.tsx`
      y comprobar que el caso de foco falla por ausencia de nueva consulta.
- [ ] Establecer `staleTime: 30_000`, `refetchOnWindowFocus: true` y
      `refetchOnReconnect: true` en ambas consultas FX. Conservar intervalo y pausa.
- [ ] Repetir los tests: todos pasan. Commit local del comportamiento y pruebas.

## Tarea 2: Estado visible y antigüedad de las capturas

**Archivos:** `apps/web/src/features/dashboard/fx/UsdPenGadget.tsx`,
`UsdPenGadget.module.css`, `UsdPenGadget.test.tsx`.

**Interfaces:** Consumir `isFetching`, `fetchStatus`, `isError`, `dataUpdatedAt`
y `data` de ambas consultas, y las funciones existentes `age(value, now)`,
`time(value)` y `freshness(row, now)`. Conservar props y contrato de `FxChart`.

- [ ] Añadir pruebas de DOM para los estados del diseño: actualización con datos
      previos visibles, éxito conjunto, fallo parcial y consultas pausadas. Comprobar
      que la fecha mostrada no avanza como éxito en errores.
- [ ] Añadir prueba de respuesta idéntica: tras 60 segundos la hora `Checked`
      avanza, la edad de captura no se reinicia y los paths no cambian.
- [ ] Añadir pruebas para edad y `Stale` visibles, gráfico atrasado, historial
      vacío, referencia oficial y cambio de fuente/rango con carga pendiente.
- [ ] Ejecutar `npm.cmd run test -w web -- src/features/dashboard/fx/UsdPenGadget.test.tsx`;
      verificar fallos por elementos nuevos ausentes antes de implementar.
- [ ] Implementar cabecera compacta y etiquetas descritas en el diseño. Orden de
      estados: error, pausa por red, consulta activa, éxito conjunto, carga inicial.
      Actualizar edades mediante el `now` que ya recibe el componente cada 30 segundos.
- [ ] Mantener tres columnas; permitir ajuste de cabecera y etiquetas en móvil.
      El aviso atrasado debe ser texto visible, no solo color, tooltip o `srOnly`.
- [ ] Reejecutar pruebas. Mantener el test de dos ciclos que verifica valores,
      paths SVG nuevos y la misma instancia de gráfico. Commit local de UI y pruebas.

## Tarea 3: Validación y entrega para revisión

- [ ] Ejecutar suite FX y Dashboard:
      `npm.cmd run test -w web -- src/features/dashboard/fx src/features/dashboard/DashboardPage.test.tsx`.
- [ ] Ejecutar `npm.cmd run typecheck`, `npm.cmd run lint` y `npm.cmd run build`.
      Separar fallos preexistentes de fallos introducidos; no afirmar éxito con errores.
- [ ] Verificar formato de archivos modificados con Prettier.
- [ ] Comprobar layout a 1440 px y 390 px, sin overflow, texto legible, historial
      conservado al refrescar y señales correctas con datos de prueba controlados.
      La inspección de navegador requiere acceso autorizado; si no está disponible,
      documentar esa limitación y entregar la vista local para revisión del usuario.
- [ ] Revisar diff final: sin secretos, cambios ajenos ni escrituras a producción.
- [ ] Entregar rama, instrucciones para abrir la vista, pruebas ejecutadas y casos
      concretos para revisión: volver a pestaña, captura atrasada, actualización sin
      cambio de precio, error de red y diseño móvil. No mergear ni desplegar.

## Revisión del plan

El plan cubre recuperación al foco, estados de consulta y frescura por fuente e
historial. La prueba ya añadida comprueba redibujado; las nuevas comprueban los
fallos de percepción y recuperación. La adquisición atrasada de Kambista/Securex
permanece explícitamente fuera del alcance: esta rama debe hacerla visible.
