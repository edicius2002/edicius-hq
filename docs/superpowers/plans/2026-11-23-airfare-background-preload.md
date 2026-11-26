# Airfare: plan de precarga en segundo plano

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preparar los datos de los gráficos de todas las rutas vigiladas desde la entrada a Airfare, antes de seleccionar una ruta, y adelantar la primera página de vuelos.

**Architecture:** Reutilizar el QueryClient existente mediante opciones de consulta compartidas y una cola de precarga con dos trabajos concurrentes. La selección conserva sus consultas visibles y las mismas claves; comparte resultados y solicitudes en curso con la precarga.

**Tech Stack:** React, TypeScript, TanStack Query, Neon Data API mediante el cliente Supabase existente, Vitest y Testing Library.

**Spec:** Diseño acotado en la sección siguiente, basado en la propuesta de precarga progresiva aceptada por el usuario el 2026-11-23. Este documento planifica la implementación; no acredita cambios de producto ni despliegue.

## Diseño y alcance

Al montar Airfare y disponer de rutas, comenzar la precarga después del primer render. Mantener la vista inicial sin selección y sin montar gráficos ocultos. Precargar las proyecciones de todos los meses vigilados, incluidos los históricos, y un calendario por ruta dirigida. AQP–LIM y LIM–AQP son rutas diferentes.

Orden inicial: mes de apertura de cada ruta y su calendario, siguiendo el orden de la lista; después, los demás meses de cada ruta. La primera página de vuelos del mes de apertura se añade cuando responde su proyección, detrás de los gráficos de apertura pendientes y antes de los meses secundarios. Cada trabajo usa la caché compartida y consume un puesto de la cola.

La tabla inicial utiliza `openingView(month).granularity` (actualmente `month`), `NO_FILTERS`, `DEFAULT_SORT`, página 1 y el período derivado de `latestCapture`. Precargarla solo si la proyección tiene disponibilidad conocida, revisión distinta de `archive` y un período válido. No descargar todas las páginas ni todas las combinaciones de filtros. Las vistas previamente modificadas siguen sus consultas normales.

Al seleccionar una ruta, sus consultas visibles arrancan sin esperar la cola. Si ya existe una petición para la misma clave, se comparte; si hay datos, se muestran inmediatamente y se revalidan según su frescura. Sus meses secundarios pasan delante de trabajos de otras rutas. El límite de dos se aplica al trabajo especulativo, no a las consultas visibles: puede haber más de dos peticiones totales durante una selección.

Al salir de Airfare, detener la cola y descartar pendientes. No cancelar desde la cola una consulta compartida que puede tener observadores; permitir que una lectura ya iniciada termine en caché, sin programar sucesoras. Al cerrar sesión o cambiar de usuario, detener también las continuaciones antes de que puedan programar trabajo para otra identidad; conservar la limpieza global de QueryProvider y la cancelación de sus consultas.

La precarga hace un recorrido por montaje, no un refresco periódico de todas las rutas. Registrar trabajos intentados evita reintentos infinitos y reprecargas por cada render. Reconciliar altas/bajas de rutas y meses sin reiniciar los trabajos existentes. Al volver a Airfare, reutilizar datos frescos y actualizar los obsoletos. Una colección manual conserva sus invalidaciones actuales; las consultas inactivas invalidadas se actualizarán al abrirse o en un nuevo recorrido.

Alternativas consideradas: montar todos los gráficos ocultos añade render innecesario; precargar solo por hover no satisface la carga desde la entrada; lanzar todas las lecturas simultáneas puede competir con la interacción. Se mantiene la precarga progresiva propuesta en la conversación. Dos puestos es una decisión inicial del plan, ajustable únicamente con mediciones.

## Restricciones globales

- Mantener `staleTime: 60_000` y `gcTime: 30 * 60_000`; no aumentar frescura para simular una mejora.
- Solo leer datos guardados; no iniciar búsquedas de proveedores, colectores ni escrituras del archivo Airfare.
- Mantener los gráficos desmontados cuando la interfaz no los necesita.
- Conservar fallback al histórico cuando la proyección sea nula; un error remoto no equivale a datos vacíos.
- Conservar revisiones, resúmenes de vuelos vencidos, invalidaciones y separación de rutas/meses.
- No introducir dependencias, migraciones SQL, persistencia en disco ni cambios generales de autenticación.
- No modificar el plan transversal existente `2026-11-23-data-loading-optimization.md`.
- No prometer una selección instantánea antes de terminar la precarga; medir espera de datos y render por separado.

## Review Focus

1. Selección durante una precarga: compartir petición, sin cancelar ni retrasar el contenido visible (tareas 1–3).
2. Logout o cambio de usuario durante una respuesta: ninguna continuación vuelve a llenar la caché anterior (tarea 3).
3. Proyección ausente o fallida: fallback correcto, cola continúa y selección permite recuperar el error (tareas 1–2).
4. Cambio de revisión entre proyección y tabla: no mostrar filas de otra revisión (tarea 4).
5. Lista editada, StrictMode y reentrada: sin duplicados, trabajo eliminado ni bucles de precarga (tareas 2–3).

## Tarea 1 — Compartir consultas entre precarga y vistas

**Archivos:** crear `apps/web/src/features/airfare/data/fareQueryOptions.ts` y `fareQueryOptions.test.ts`; modificar `hooks/useFareProjections.ts`, `hooks/useFareCalendar.ts`, `data/supabaseAirfare.ts` y `apps/web/src/shared/api/fares.ts`.

**Interfaces:** exportar `fareProjectionOptions(origin: string, destination: string, month: string)` y `fareCalendarOptions(origin: string, destination: string)` con retorno inferido mediante `queryOptions`. Mover `readMonth` sin alterar su contrato. Mantener las claves `['fares','projection',origin,destination,month]` y `['fares','calendar',origin,destination]`.

- [ ] Añadir pruebas de consumo compartido: precarga resuelta seguida de montaje fresco produce una llamada; montaje durante precarga pendiente produce una llamada; rutas inversas y meses distintos no comparten resultados.
- [ ] Añadir casos de proyección nula → histórico, error de proyección → error, y conservación de buckets y retención. Ejecutar pruebas nuevas y registrar el fallo esperado antes de extraer código.
- [ ] Extraer las opciones y reutilizarlas desde ambos hooks. Mantener las condiciones `enabled`, la prioridad actual del mes visible y `useRetainedData`.
- [ ] Propagar `AbortSignal` del calendario hasta `rpc(...).abortSignal(signal)` y comprobar cancelación. El wrapper actual descarta `options.signal`; conservar compatibilidad con los demás consumidores.
- [ ] Ejecutar `npm.cmd run test -w web -- src/features/airfare/data/fareQueryOptions.test.ts src/features/airfare/hooks/useFareProjections.test.tsx src/features/airfare/hooks/useFareCalendar.test.tsx src/features/airfare/data/supabaseAirfare.test.ts`; resultado esperado: PASS.

## Tarea 2 — Cola de precarga de gráficos

**Archivos:** crear `apps/web/src/features/airfare/data/farePreloader.ts` y `farePreloader.test.ts`.

**Interfaces:** `createFarePreloader(client: QueryClient)` devuelve `{ update(routes: readonly FareRoute[], today: string, selectedId: string | null): void; dispose(): void }`. Reutilizar `routeId`, `openingMonth` y las opciones de tarea 1. La cola es una instancia por montaje, no un singleton global.

- [ ] Escribir pruebas con promesas controladas: sin selección empieza a leer; máximo dos trabajos especulativos pendientes; orden de apertura antes de secundarios; `update` prioriza la ruta seleccionada; fallo libera puesto y permite continuar.
- [ ] Añadir pruebas de deduplicación por clave, altas/bajas de meses, rutas inversas, lista vacía y `dispose` durante solicitud. Una respuesta tras `dispose` no programa sucesoras.
- [ ] Ejecutar `npm.cmd run test -w web -- src/features/airfare/data/farePreloader.test.ts`; comprobar fallos nuevos esperados.
- [ ] Implementar cola priorizada y registro de intentos por clave. Usar `client.fetchQuery` con las opciones compartidas, capturar errores y continuar. No usar `setQueryData` para copiar respuestas ni crear observadores con polling para rutas inactivas.
- [ ] Quitar pendientes obsoletos al reconciliar la lista. Permitir completar trabajos en curso; no cancelar lecturas compartidas. Excluir de trabajos pendientes el mes activo ya atendido por la vista cuando corresponda, dejando que QueryClient deduplique carreras.
- [ ] Repetir pruebas y obtener PASS. No ejecutar el histórico completo por adelantado si existe una proyección mensual.

## Tarea 3 — Iniciar desde Airfare y respetar la sesión

**Archivos:** crear `apps/web/src/features/airfare/hooks/useFarePreload.ts` y `useFarePreload.test.tsx`; modificar `AirfarePage.tsx`; crear `AirfarePage.preload.test.tsx`. Ampliar `apps/web/src/app/providers/QueryProvider.test.tsx` si necesita comprobar integración de identidad.

**Interfaces:** `useFarePreload(routes: readonly FareRoute[], today: string, selectedId: string | null): void`. Usar `useQueryClient`, un efecto para el ciclo de vida y `subscribeToAuth` ya existente para detener la instancia ante cambio de propietario. Esperar identidad autenticada conocida antes de iniciar; no implementar otra consulta manual de sesión.

- [ ] Escribir prueba de página sin selección: cargada la lista, empiezan las lecturas y no se selecciona ninguna ruta automáticamente. Tras completar la precarga, seleccionar muestra gráficos con datos sin una segunda lectura fresca.
- [ ] Probar selección mientras hay solicitudes pendientes, navegación fuera/dentro, doble montaje de efectos en StrictMode y cambio de orden de la lista; no crece el número de lecturas por renders equivalentes.
- [ ] Probar logout/cambio de usuario durante una solicitud y entre proyección y trabajo dependiente: limpiar datos según QueryProvider, descartar continuaciones y no iniciar lecturas con las rutas del propietario anterior. Simular respuestas que ignoran cancelación para comprobar el aislamiento.
- [ ] Ejecutar las pruebas nuevas para registrar FAIL; implementar hook y llamada en `AirfarePage` conservando `selectedId = null` inicialmente.
- [ ] Si el árbol autenticado no garantiza desmontaje antes de cambiar de propietario, bloquear la instancia hasta un montaje nuevo con la nueva lista; nunca reiniciarla con la lista anterior. Verificar este orden con el gate real antes de cerrar la tarea.
- [ ] Ejecutar `npm.cmd run test -w web -- src/features/airfare/hooks/useFarePreload.test.tsx src/features/airfare/AirfarePage.preload.test.tsx src/features/airfare/AirfarePage.navigation.test.tsx src/app/providers/QueryProvider.test.tsx`; resultado esperado: PASS.

## Tarea 4 — Preparar la primera página de vuelos

**Archivos:** ampliar `data/fareQueryOptions.ts`, `data/fareQueryOptions.test.ts`, `data/farePreloader.ts` y `data/farePreloader.test.ts`; modificar `ui/ProjectedFlightTable.tsx` y `ui/ProjectedFlightTable.test.tsx` (todos bajo `apps/web/src/features/airfare/`).

**Interfaces:** exportar `fareFlightPageOptions(client: QueryClient, input: FareFlightPageInput)`. `FareFlightPageInput` contiene `origin`, `destination`, `month`, `revision`, `from`, `to`, `departure` de tipo string; `filters: Filters`, `sort: Sort`, `page: number`. Conservar la clave actual completa y retorno `{ data: FareFlightPage | null, departure: string }`. La comparación de revisión e invalidación de proyección viven en esta función compartida.

- [ ] Probar que proyección válida programa una primera página, con período calculado desde `latestCapture` usando `bucketKey` y `periodBounds`, `openingView(month).granularity`, filtros/orden por defecto y página 1.
- [ ] Probar que revisión `archive`, disponibilidad desconocida y captura nula no programan tabla; filtros, página o período distintos conservan consultas independientes.
- [ ] Probar revisión cambiada: invalidar la proyección y rechazar filas incompatibles; no crear un bucle automático de precarga. La vista mantiene su mecanismo de recuperación.
- [ ] Ejecutar las pruebas y comprobar FAIL; extraer la consulta y reutilizarla en tabla y cola. La primera página entra en los mismos dos puestos, sin una cadena que evade el límite.
- [ ] Verificar que un montaje de tabla con iguales parámetros reutiliza la precarga y que `useRetainedData` conserva sus etiquetas. Ejecutar pruebas de los cuatro archivos afectados hasta PASS.

## Tarea 5 — Validar comportamiento y medir el beneficio

**Archivos:** crear `docs/performance/2026-11-23-airfare-preload.md` al ejecutar; actualizar `docs/airfare-data-loading.md` con el comportamiento actual, separándolo de mediciones históricas.

- [ ] Antes de modificar producto, guardar baseline del checkout y medir apertura, clic inmediato, clic después de precarga, cambio de ruta y regreso tras más de 60 segundos. Usar la misma sesión, datos, red y dispositivo para la comparación final.
- [ ] Registrar por escenario cinco ejecuciones: tiempo desde clic hasta ambos gráficos con datos pintados, tiempo hasta primera tabla, duración total de precarga, solicitudes, bytes y errores. Separar espera humana y autenticación; no guardar tokens ni payloads privados.
- [ ] Añadir un escenario local determinista con respuestas demoradas: primer render sin selección, precarga completada, selección y cero peticiones nuevas para las claves frescas. Registrar que esa prueba demuestra reutilización, no velocidad real de Neon.
- [ ] Ejecutar `npm.cmd run test -w web -- src/features/airfare src/app/providers/QueryProvider.test.tsx`; después `npm.cmd run format:check`, `npm.cmd run lint`, `npm.cmd run typecheck`, `npm.cmd run test` y `npm.cmd run build`. Todos deben pasar; distinguir fallos previos ajenos al cambio.
- [ ] Comparar baseline y resultado. Comprobar que el mapa y la lista siguen interactivos mientras carga; no aceptar una mejora al seleccionar que introduce bloqueos iniciales o errores por exceso de solicitudes.
- [ ] Registrar limitaciones si no hay sesión autenticada disponible; no atribuir tiempos simulados a producción. Observar peticiones de token, dado que `getNeonAccessToken` actualmente llama `neonAuth.token()` por invocación; cualquier optimización transversal pertenece al plan separado.
- [ ] Revisar diff final, documentar pruebas y resultados; preparar commits por entregables en una rama aislada al ejecutar. Publicación y despliegue quedan fuera de este plan solicitado.

## Criterios de aceptación

- Desde la vista inicial, sin clic ni hover, se descargan progresivamente los datos de gráficos de todas las rutas y meses vigilados mientras Airfare permanezca montado y las lecturas respondan.
- Seleccionar una ruta preparada muestra sus datos desde caché; la misma consulta fresca no se repite y una petición en curso se comparte.
- Nunca hay más de dos trabajos especulativos concurrentes; las consultas visibles no esperan la cola.
- Primera página preparada cuando existe una proyección compatible; filtros y páginas posteriores siguen bajo demanda.
- Errores, cambios de lista, desmontaje y cambios de usuario no bloquean la cola ni mezclan datos.
- Se preservan política de frescura, actualizaciones manuales y lecturas históricas. El cambio no dispara recolección de tarifas.

**Orden de ejecución:** baseline de tarea 5 → tarea 1 → tarea 2 → tarea 3 → tarea 4 → validación restante de tarea 5. Implementación en esta misma sesión como método recomendado: las tareas comparten opciones y ciclo de vida, por lo que conviene mantener una única responsabilidad sobre su integración.
