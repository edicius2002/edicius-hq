# Optimización de carga de datos — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reducir el tiempo hasta los primeros datos útiles al abrir la aplicación y al navegar entre sus siete pestañas, conservando aislamiento de usuarios, frescura y garantías de escritura.

**Architecture:** Mantener React Query, Better Auth y Neon Data API. Compartir autenticación en memoria, conservar cachés por sesión y dar prioridad a los datos visibles. Aplicar cambios en entregas independientes, con comparación antes/después.

**Tech Stack:** React, TypeScript, TanStack Query, Better Auth, Supabase JS como cliente de Neon Data API, Vite y Vitest.

**Spec:** Alcance y decisiones propuestos en este documento, derivados del análisis solicitado por el usuario el 2026-11-23. Este documento es un plan para revisar; no acredita implementación ni despliegue.

## Evidencia y límites

- Checkout analizado: `e592adf4b2d36b3d27ec60cccd9434214a212f35`. El último deployment Production registrado en GitHub tiene ese SHA y estado success, fechado 2026-11-16.
- HTML público: 122–375 ms en tres solicitudes; caché HIT. JavaScript principal: 376273 bytes descomprimidos y transferencia Brotli. No son tiempos de render ni mediciones de datos autenticados.
- `getNeonAccessToken()` ejecuta `neonAuth.token()` en cada llamada. Ocho llamadas concurrentes al módulo real, con HTTP simulado, produjeron ocho solicitudes de token. El cliente de datos espera ese callback antes de cada petición.
- `subscribeToNeonAuth()` consulta sesión por suscriptor. Dashboard elimina FX y publicaciones al desmontarse. Finance usa `refetchOnMount: 'always'` para recuperar una revisión que vive en el hook.
- Airfare ya prioriza el mes seleccionado; Investing ya muestra series guardadas. SEACE ya pagina y precarga. No duplicar estas optimizaciones.
- Falta baseline autenticado. El host de acceso a la extensión de Chrome devuelve `The browser access host is unavailable`. No hay evidencia para atribuir la latencia a SQL, al arranque de Neon o al Pi.

## Diseño propuesto y alternativas

**Recomendado: mejora incremental en el cliente.** Primero eliminar trabajo repetido comprobado, después medir cada pestaña y limitar precargas. Reutiliza la arquitectura y facilita aislar regresiones.

**Alternativa: bootstrap agregado en servidor.** Puede agrupar documentos y reducir viajes, pero introduce otro contrato, mantenimiento e invalidación. Reconsiderar solo si persisten viajes seriales relevantes tras las primeras entregas.

**Alternativa: persistencia general en IndexedDB.** Acelera recargas completas, pero necesita versionado, caducidad y reconciliación de documentos editables. Diferida hasta medir el beneficio adicional; conservar la persistencia de mercado existente.

### Restricciones globales

- No aumentar intervalos de actualización de datos vivos como sustituto de optimizar la carga.
- Tokens solo en memoria; no persistir JWT en localStorage, IndexedDB o artefactos de diagnóstico.
- Limpiar token, sesión y datos privados ante cierre de sesión o cambio de usuario, incluyendo respuestas en vuelo.
- Conservar comparación de revisiones, cola de escrituras, conflictos y bloqueo tras una lectura inicial fallida.
- Una consulta fría no puede mostrar un placeholder como si fuera información real; los datos previos deben conservar su fecha y estado de actualización.
- Mantener las alertas globales de Investing y la autoridad del Pi conforme al ADR 0004. No mover adquisición de proveedores al navegador.
- No agregar dependencias ni migraciones de base de datos sin evidencia que las justifique.
- Preparar cambios en una rama aislada al ejecutar; este plan no publica issues, commits ni despliegues.

### Criterios de aceptación

- Ocho lecturas simultáneas comparten una única solicitud de token cuando no hay token válido; dentro de su vigencia no generan otra.
- Los suscriptores simultáneos comparten una consulta inicial de sesión, sin perder eventos ni aceptar resultados de una sesión anterior.
- Dashboard → otra pestaña → Dashboard dentro de 30 s reutiliza datos y no repite lecturas de FX/publicaciones por el solo desmontaje.
- Sentiment conserva el snapshot durante la sesión hasta cuatro horas de inactividad y aplica su política de frescura existente de cuatro horas.
- Finance conserva datos visibles al volver; solo habilita ediciones cuando existe una revisión confirmada y no hay escritura/conflicto pendiente incompatible.
- Las precargas no crean trabajos de colectores ni retrasan las consultas de la vista activa.
- Para escenarios con datos en memoria: objetivo provisional de primer contenido útil en ≤200 ms desde la navegación. Validar en un dispositivo/perfil de red fijado; no prometer este valor para arranques fríos.
- Registrar tiempos, solicitudes y bytes por ruta antes/después. Si una ruta empeora, investigar antes de promover el cambio.

## Review Focus

1. Logout o cambio de usuario durante token/sesión/consulta: una respuesta antigua no restaura acceso ni datos.
2. Token vencido, expiración inválida o error de red: no reutilizar indefinidamente ni producir bucles de reintentos.
3. Salir de Finance mientras se guarda y volver antes del acuse: no permitir sobrescritura con revisión anterior.
4. Datos obsoletos con red fallida: conservar información identificada como previa sin presentar una actualización exitosa.
5. Navegación rápida, conexión limitada y pestaña oculta: evitar precargas ilimitadas y trabajo de colectores no solicitado.

## Tarea 1 — Baseline autenticado reproducible

**Archivos:** crear `docs/performance/2026-11-23-data-loading-baseline.md`; si se requiere instrumentación, crear `apps/web/src/shared/lib/loadTiming.ts` y su test, habilitada explícitamente para diagnóstico.

**Interfaces:** mediciones `{ route, scenario, firstUsefulMs, settledMs, requestCount, transferredBytes, authRequestCount }`, sin payloads, cookies o cabeceras de autenticación. Distinguir red de render; no confundir `isFetching=false` con contenido ya pintado.

- [ ] Conectar una sesión autenticada en el origen de producción y registrar SHA servido, navegador, dispositivo y perfil de red. Si sigue inaccesible, dejar baseline pendiente; continuar pruebas locales, sin afirmar mejoras reales.
- [ ] Medir cinco ejecuciones por escenario: apertura con sesión válida y caché cliente vacía; primera visita a cada ruta; regreso en menos de 30 s; regreso tras más de 5 min. Separar también la interacción humana de passkey del tiempo de carga de datos.
- [ ] Cubrir Dashboard, Finance, Greenlight, Investing, Airfare, Sentiment y las cuatro vistas de SEACE. Registrar parámetros iniciales constantes: símbolo/timeframe, ruta/mes y filtros.
- [ ] Registrar mediana y rango, secuencia auth → chunk → datos, tamaño de respuestas y llamadas a `/api/auth/*`. No informar p95 con solo cinco muestras.
- [ ] Si se añade instrumentación, probar que está deshabilitada por defecto y que emite únicamente metadatos. Usar marcas de render del contenido útil y mantener la navegación funcional.
- [ ] Guardar resultados redactados. Los HAR completos con credenciales no se incorporan al repositorio.

## Tarea 2 — Token y sesión compartidos

**Modificar:** `apps/web/src/shared/auth/neonAuth.ts`, `apps/web/src/shared/auth/useSupabaseSession.ts` y sus tests; ampliar `apps/web/src/shared/auth/neonAuthAdapter.test.ts` y `apps/web/src/shared/supabase/client.test.ts` según el contrato.

**Interfaces:** conservar `getNeonAccessToken(): Promise<string | null>`, `subscribeToNeonAuth(callback): () => void`, `getNeonOwnerId(): Promise<string | null>` y las funciones públicas de sign-in/sign-out. El gestor interno comparte token, petición en vuelo, snapshot de sesión y generación de identidad.

- [ ] Escribir pruebas que fallen: 8 llamadas simultáneas → 1 HTTP; llamadas sucesivas con token vigente → 0 HTTP adicionales; varios suscriptores → 1 consulta inicial de sesión.
- [ ] Cubrir expiración con reloj falso, error y recuperación, token nulo, logout durante solicitud, cambio de usuario y desmontaje de un suscriptor sin afectar a los demás.
- [ ] Ejecutar `npm run test -w web -- src/shared/auth/neonAuth.test.ts src/shared/auth/useSupabaseSession.test.tsx src/shared/auth/neonAuthAdapter.test.ts src/shared/supabase/client.test.ts`; comprobar los fallos nuevos esperados.
- [ ] Deduplicar peticiones en vuelo. Reutilizar JWT solo hasta `exp - 30 segundos`; con `exp` ausente/inválido, deduplicar únicamente en vuelo. La lectura de `exp` sirve para caducidad local, nunca para autorizar.
- [ ] Compartir una suscripción al cambio de sesión; deduplicar refrescos equivalentes y entregar snapshot/eventos consistentes a todos los consumidores. Invalidar por generación antes de sign-out y tras cambios de identidad; ignorar resultados viejos.
- [ ] Mantener errores transitorios diferenciados de sesión anónima. Verificar el mecanismo existente de actualización entre pestañas; añadir sincronización sin transmitir tokens si no cubre logout/login entre pestañas.
- [ ] Repetir las pruebas hasta PASS y revisar que el arranque no solicita un token adicional innecesario desde el gate. Preparar commit independiente.

## Tarea 3 — Caché de navegación: Dashboard, Sentiment y Greenlight

**Modificar:** `apps/web/src/features/dashboard/fx/useFx.ts`, `apps/web/src/features/dashboard/DashboardPage.tsx`, `apps/web/src/features/sentiment/hooks/useSentiment.ts`, `apps/web/src/app/providers/QueryProvider.tsx` solo si es necesario; sus tests asociados. Revisar `apps/web/src/shared/storage/useStoredDocument.ts` para Greenlight.

**Interfaces:** conservar query keys y API de hooks. El propietario global de limpieza es `QueryProvider`; el desmontaje de una vista no equivale a logout.

- [ ] Añadir regresiones que fallen: navegar fuera y volver conserva FX/publicaciones; logout elimina ambos; una respuesta tardía del usuario anterior no reaparece.
- [ ] Retirar borrado de caché ligado al desmontaje normal del Dashboard; conservar la limpieza global de identidad. Mantener el refresco de FX/publicaciones a 60 s.
- [ ] Fijar `gcTime: 4 * 60 * 60 * 1000` en Sentiment y conservar `staleTime` de cuatro horas. Probar regreso después de 6 min sin descarga y revalidación tras caducidad.
- [ ] Mantener inicialmente la frescura compartida de documentos en 30 s. Medir el payload Greenlight y asegurar que revalidación en segundo plano no reemplaza la vista por un skeleton; no dividir documentos por intuición.
- [ ] Ejecutar `npm run test -w web -- src/features/dashboard src/features/sentiment src/features/greenlight src/shared/storage/useStoredDocument.test.tsx src/app/providers/QueryProvider.test.tsx`; obtener PASS y preparar commit independiente.

## Tarea 4 — Finance: reutilización segura del documento

**Modificar:** `apps/web/src/features/finance/hooks/useRemoteDocument.ts`, su test y consumidores directos de la caché encontrados por búsqueda. Revisar `apps/web/src/features/finance/data/financeDocuments.ts` sin cambiar su contrato remoto.

**Interfaces:** mantener `RemoteStoredDocument<T>`. Introducir un registro interno de sesión por documento que conserve payload, revisión confirmada y estado de escritura/conflicto; no basta guardar la revisión junto a un payload optimista sin distinguir su generación.

- [ ] Reproducir con tests la salida/reentrada sin cambios y durante una escritura pendiente. Cubrir conflicto CAS, acuse tardío, lectura obsoleta, primer read fallido y cambio de usuario.
- [ ] Mantener el estado de coordinación de escritura durante desmontajes, o bloquear la edición al reentrar hasta resolver el guardado pendiente. Elegir la opción mínima compatible con la cola existente y documentarla en el cambio.
- [ ] Reutilizar una revisión confirmada junto con su documento; reemplazar `refetchOnMount: 'always'` por revalidación según frescura solo cuando esta reutilización sea segura. Mantener visible el documento durante la revalidación.
- [ ] Probar una modificación remota entre visitas: conflicto explícito, sin pérdida silenciosa. Conservar la recuperación tras conflictos y la serialización de escrituras.
- [ ] Ejecutar `npm run test -w web -- src/features/finance src/shared/storage/writeQueue.test.ts`; obtener PASS y preparar commit separado por su mayor riesgo funcional.

## Tarea 5 — Carga visible y trabajo secundario por pestaña

**Archivos a revisar/modificar según baseline:** `apps/web/src/features/investing/chart/useCandles.ts`, `useAssetPreload.ts` en el mismo directorio; `apps/web/src/features/airfare/hooks/useFareProjections.ts`; `apps/web/src/features/seace/SeacePage.tsx` y `data.ts`; sus tests existentes.

**Interfaces:** preservar las respuestas de hooks y RPC. Extender `loadSeacePage(query, signal?: AbortSignal)` si se añade cancelación de lecturas.

- [ ] Investing: medir peticiones de gráfico activo frente a precargas. Probar que una serie guardada aparece mientras se actualiza y que las precargas de otros activos no crean trabajos del Pi. Mantener alertas globales.
- [ ] Airfare: verificar que el mes activo se pinta antes de meses secundarios y que el fallback al histórico solo ocurre cuando corresponde. Si el baseline muestra competencia, limitar a dos lecturas secundarias concurrentes sin retrasar la primaria.
- [ ] SEACE: medir las tres combinaciones alternativas y siguiente página que se precargan. Mantener inicialmente siguiente página; disparar combinaciones alternativas por intención si la medición demuestra coste innecesario.
- [ ] SEACE: pasar el AbortSignal de React Query al RPC para filtros/navegación abandonados; conservar aislamiento de filtros y placeholder actual. Pasar sincronización a React Query con clave región/año y frescura de 30 s para reutilizarla al volver.
- [ ] Greenlight/Sentiment: si la deserialización o render domina el baseline, perfilar antes de proponer payload resumido o carga de detalle. Cualquier nuevo endpoint o índice requiere tarea adicional con evidencia.
- [ ] Ejecutar `npm run test -w web -- src/features/investing src/features/airfare src/features/seace src/features/greenlight src/features/sentiment`; obtener PASS. Separar commits por pestaña y omitir cambios que el baseline no justifique.

## Tarea 6 — Precarga selectiva de rutas

**Crear:** `apps/web/src/app/router/routeModules.ts` y su test.
**Modificar:** `apps/web/src/app/router/routes.tsx`, `apps/web/src/app/layout/TopNav.tsx`, tests de navegación y `apps/web/src/app/App.test.tsx`.

**Interfaces:** exportar cargadores compartidos por `React.lazy` y `preloadRoute(pathname: string): Promise<void>`. Mapear las cuatro rutas SEACE al mismo módulo y deduplicar imports; un fallo de precarga no bloquea la navegación normal.

- [ ] Probar intención de puntero/foco → un import, repetición → sin duplicados, ruta desconocida → no-op y fallo → navegación recuperable.
- [ ] Conectar `onPointerEnter` y `onFocus` de los enlaces a los mismos cargadores usados por las rutas. No descargar todos los módulos al iniciar sesión.
- [ ] Diferir precargas oportunistas si `saveData` está activo; no cambiar lecturas obligatorias. No añadir consultas de datos por hover en esta entrega: evaluar ese paso solo después de medir la precarga de código.
- [ ] Ejecutar `npm run test -w web -- src/app`; obtener PASS y preparar commit independiente.

## Tarea 7 — Validación conjunta y promoción

- [ ] Ejecutar `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run test` y `npm run build`; todos deben terminar correctamente. Si se modifica API/SQL, añadir sus checks específicos.
- [ ] Revisar diferencias de bundles y cobertura de los cinco riesgos de Review Focus. No considerar los tests con mocks una medición de latencia real.
- [ ] Repetir la matriz de la tarea 1 con el mismo dispositivo, red y datos seleccionados. Comparar por separado apertura fría y regreso con caché.
- [ ] Validar autenticación en un origen compatible con las passkeys existentes; una Preview de Vercel arbitraria no garantiza un login válido. Usar un flujo de prueba compatible ya disponible o preparar un despliegue controlado al origen admitido.
- [ ] Revisar la comparación y el diff antes de publicar. Promover primero autenticación/caché; después Finance; finalmente ajustes por pestaña y precarga. Conservar el deployment previo para rollback independiente.
- [ ] Tras cada promoción, comprobar login/logout, datos de las siete pestañas, edición de documentos, conflictos y alertas. Una mejora de tiempo que rompe estas funciones no satisface el plan.

## Dependencias y resultado esperado

Secuencia: baseline → autenticación → caché de navegación → Finance → ajustes por pestaña → precarga → validación. El baseline autenticado puede quedar pendiente mientras se desarrollan regresiones locales, pero es obligatorio antes de afirmar mejoras en producción.

La primera entrega tiene alcance transversal y evidencia de trabajo redundante. Las siguientes preservan las optimizaciones que ya existen y atacan únicamente costes medidos. La persistencia general en disco, agregación en servidor y cambios SQL quedan como decisiones posteriores basadas en resultados.
