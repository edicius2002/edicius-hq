# El mapa de Airfare: por qué se siente lento y plano, y qué hacer

> **Nota sobre este documento.** La primera versión de este análisis (commit `c588485`)
> respondió una pregunta de rendimiento — "¿hay un cuello de botella que justifique GPU?" —
> y concluyó que no, citando una medición (`lib/visible.ts:8-29`) que en realidad cubre otro
> escenario: el mundo a 1:110m, no las subdivisiones territoriales. El objetivo real es que
> el mapa **se vea mejor** (fluidez, atmósfera/iluminación, detalle, inmediatez), y esa
> pregunta merecía su propia medición. Este documento la hace, mide el caso correcto, separa
> causa de renderer para cada queja, cubre los efectos visuales que faltaban del todo en la
> versión anterior, y termina en un plan por fases en vez de un sí/no. El análisis de `vgpu`
> del documento original se conserva íntegro en la §5.1 — sigue siendo válido y sigue siendo
> la respuesta correcta a la pregunta que se hizo entonces.

## Resumen ejecutivo

- **Sí, el zoom se atasca cuando hay subdivisiones territoriales en pantalla, y está medido
  en esta sesión con Chromium real (§1).** Para EEUU (334 KB de fronteras a 1:10m) reconstruir
  y volver a proyectar esa geometría cuesta una mediana de ~18-24 ms por frame en las
  condiciones que se explican abajo — por sí solo, más que el presupuesto de un panel a 60 Hz
  (16,7 ms) y varias veces el de uno a 165 Hz (6,1 ms). Y ese coste se paga **en cada frame**
  mientras la cámara se mueve, no solo una vez, por una razón de caché que se explica en la
  §2.
- **La causa de las cuatro quejas no es la misma, y solo una de las cuatro roza el renderer**
  (§2): fluidez (A) y detalle (C) son un problema de _cuánta geometría se reproyecta por
  frame_ y de _qué presupuesto de bytes se le da a cada país_; inmediatez (D) es una decisión
  de temporización que no toca ni un píxel; aspecto (B) tiene partes que ya existen en Canvas
  2D, partes baratas de añadir sin GPU, y una sola pieza (relieve/batimetría con textura sobre
  un globo que gira) que sí pide un shader.
- **La mayoría de lo que se pide se puede conseguir sin cambiar de tecnología de
  renderizado** (§4, §6): extender el índice de `lib/visible.ts` a las subdivisiones,
  separar "cuándo pedir datos" de "cuándo mostrar los que ya están en caché", un terminador
  día/noche con `d3-geo`, brillo en los arcos vía filtro SVG nativo. Ver el plan en fases,
  §7 — la mayor parte del beneficio percibido está en la fase 1, sin tocar el renderer.

---

## 1. El zoom con subdivisiones, medido

### 1.1 Por qué el número anterior no vale para esta queja

El documento anterior citó `lib/visible.ts:8-29` (una mediana de 6,1 ms tras culling por
casquete esférico) como evidencia de que no hay problema de rendimiento. Esa medición es real,
pero es del **mundo entero a 1:110 m** — el atlas base, sin ninguna subdivisión territorial
cargada. `lib/visible.ts` no menciona subdivisiones ni una vez, y su culling por casquete
opera sobre qué _países_ pueden estar en pantalla, no sobre los miles de vértices que forman
el contorno de un solo país ya en pantalla. El propio `RouteMap.tsx` lo dice sin rodeos, en el
bloque que construye la geometría fina de un país (`RouteMap.tsx:711-721`):

> "This is the layer the cull cannot help with, and the reason is worth stating: culling
> drops shapes that are somewhere else, and the shapes here are the countries the reader has
> deliberately closed in on. [...] Measured, projecting the fine land and the fine internal
> borders of Peru, Bolivia and Chile was 16 to 20 ms a frame with everything else in the frame
> down to three."

Es decir: el propio código ya documentaba, antes de este reencuadre, que esta capa cuesta
16-20 ms cuando hay varios países con subdivisiones a la vista — un número que el análisis
anterior no citó porque estaba buscando en el archivo equivocado.

### 1.2 Medición de esta sesión

Para responder con el caso exacto que pide la tarea (EEUU, Brasil, España), medí el coste real
en un Chromium sin cabeza (el mismo binario que usa Playwright, ya presente en la máquina:
`~/.cache/ms-playwright/chromium-1187`), pilotado por CDP desde un script Node desechable
(no forma parte del repositorio). El _benchmark_ replica exactamente la secuencia de
`RouteMap.tsx:758-770` y `833-874` — construir un `Path2D` por país vía `d3-geo`'s `geoPath`
a partir de los ficheros de subdivisiones realmente servidos
(`services/api/app/data/subdivisions/{840,076,724,604,068,152}.json`, es decir EEUU, Brasil,
España, y Perú+Bolivia+Chile como control cruzado contra la cita de arriba), proyectar con
`geoOrthographic().fitSize(...)` ajustado a un lienzo de 529×460 (el mismo tamaño que cita
`lib/fanOut.ts:60`), y luego `fill`/`stroke` sobre canvas real.

**Resultado — reconstruir el `Path2D` desde cero (lo que pasa en cualquier frame donde la
cámara se movió), mediana de 38 repeticiones tras descartar 2 de calentamiento:**

| País                                 | Peso servido | Mediana          | Mín–máx          |
| ------------------------------------ | ------------ | ---------------- | ---------------- |
| España (724)                         | 63,2 KB      | 4,2–4,6 ms       | 2,7–13,2 ms      |
| Brasil (076)                         | 153,4 KB     | 10,8–14,5 ms     | 8,4–35,6 ms      |
| Perú+Bolivia+Chile (control cruzado) | 187,1 KB     | 17,1–18,6 ms     | 12,2–38,5 ms     |
| **EEUU (840)**                       | **326,3 KB** | **18,6–21,3 ms** | **11,2–49,5 ms** |

El control cruzado (Perú+Bolivia+Chile, 17,1-18,6 ms medidos aquí) coincide casi exactamente
con los 16-20 ms que ya documentaba `RouteMap.tsx:719-721` para el mismo trío de países — lo
que valida el método. EEUU solo, con más del doble de bytes, cuesta más: 18,6-21,3 ms de
mediana, con una cola de hasta 49,5 ms.

**Resultado — reutilizar un `Path2D` ya construido (lo que pasa cuando la cámara está
parada), mismas condiciones:** 0,0-0,1 ms para los cuatro casos. El `fill`/`stroke` en sí, es
decir el trabajo que le correspondería a "el renderer", **es gratis**. El coste entero está en
`geoPath` recorriendo miles de coordenadas para construir el `Path2D` — trabajo de CPU en
JavaScript, no de rasterizado.

**Advertencia de método, con la misma honestidad que pide la tarea:** esto corre en un
Chromium sin aceleración de GPU real (`--disable-gpu`, _software rendering_ vía SwiftShader),
sin las optimizaciones de contexto completo que sí tiene la app en producción (el `clip()` al
contorno grueso que acota el área a rellenar, el batching de varios países en un solo
`fill`/`stroke`). Es razonable esperar que en el Chrome real de un lector, con GPU, los números
sean **algo mejores** que estos — y aun así el control cruzado los sitúa a menos de un 15% del
número que el propio equipo ya midió en su propia máquina. La conclusión que importa no depende
del número exacto: **reconstruir esta geometría cuesta un orden de magnitud más que
reutilizarla, y ese orden de magnitud por sí solo excede el presupuesto de un frame.**

### 1.3 Por qué se paga en cada frame y no solo una vez

`RouteMap.tsx` ya tiene una caché para esto — `served.current`, un `Map` por país que guarda
el `Path2D` construido y la "vista" (`view`) con la que se construyó
(`RouteMap.tsx:378-380`):

> "The served geometry as this view projects it, kept until the view moves. [...] it is also
> the one thing that arrives while the camera is standing still, which is what makes projecting
> it once per view both possible and the difference between a fade and a lurch."

El problema es qué cuenta como "la vista". La clave de caché (`RouteMap.tsx:753`) es:

```
const view = `${projection}|${zoom.current}|${rotation.current.join(',')}|${pan.current.x},${pan.current.y}|${rect.width}x${rect.height}`;
```

`zoom.current`, `rotation.current` y `pan.current` cambian en **todos** los frames mientras
la cámara se mueve — y `draw()`, que es donde se lee y escribe esta caché, se invoca en cada
`requestAnimationFrame` mientras `moving` es verdadero (`RouteMap.tsx:1031-1052`, el bucle que
el propio archivo llama "a frame loop only while something is actually moving"). Así que la
caché ayuda exactamente en el caso que su comentario describe — la cámara parada — pero **no**
en el caso que un lector reporta como lento: seguir haciendo zoom o arrastrar el mapa
_después_ de que las subdivisiones de un país ya están cargadas y visibles. En ese momento,
cada frame cambia la clave `view`, la caché falla, y se paga el coste completo de la §1.2 —
18-21 ms para EEUU — encima de todo lo demás que el frame ya tenía que hacer.

Esto es indistinguible, en código, de "seguir mirando EEUU mientras haces zoom" — precisamente
el gesto que un lector describiría como "el mapa se atasca cuando aparecen las subdivisiones".

---

## 2. Causa por queja, separada del renderer

| Queja                                          | Causa                                                                                                                                                                                                                                                                                                                                                                                                                                             | Categoría                                                                                                                                                                         | ¿Argumento a favor de GPU?                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Fluidez al hacer zoom con subdivisiones** | La caché de `Path2D` (`served.current`) solo sobrevive con la cámara parada; cualquier frame de zoom/arrastre con un país ya cargado reconstruye su geometría entera, 18-21 ms para EEUU (§1)                                                                                                                                                                                                                                                     | **(i) volumen de geometría reproyectada por frame**, causado por el alcance de una caché, no por el volumen de datos en sí                                                        | **No.** La §1.2 demuestra que el `fill`/`stroke` (lo único que un renderer nuevo cambiaría) cuesta 0 ms; el 100% del coste es la reproyección en JS, que un pipeline de GPU también tendría que pagar en algún punto — a menos que se rediseñe la estrategia de caché, que es exactamente el arreglo de la §4, sin GPU. |
| **B. Aspecto plano**                           | Ver desglose por efecto en §3                                                                                                                                                                                                                                                                                                                                                                                                                     | Mixto — depende del efecto                                                                                                                                                        | Solo para uno de los efectos pedidos (relieve/batimetría con textura sobre el globo girando); el resto ya existe o es alcanzable en Canvas 2D/SVG                                                                                                                                                                       |
| **C. Fronteras toscas / detalle insuficiente** | Dos causas distintas según qué se esté mirando: (a) países vecinos que se quedan sin presupuesto — `lib/fanOut.ts:85`, `VIEW_BUDGET_BYTES = 256_000` (256 KB); EEUU solo ya pesa 326 KB, **más que todo el presupuesto de una vista**, así que al mirar EEUU, Canadá y México se quedan en el atlas de 1:110m aunque el país central esté a 1:10m; (b) el propio 1:10m es, hoy, el techo de resolución que existe — no hay un "1:1m" al que subir | (a) **(ii) estrategia de carga de datos** (presupuesto de bytes); (b) **(iii) resolución de los datos servidos**, pero ya en su máximo práctico para cobertura mundial (ver §2.1) | No en ninguno de los dos casos — ninguno es "el canvas no puede pintar suficiente detalle", es "el presupuesto no llega" o "no existe un fichero más fino"                                                                                                                                                              |
| **D. Inmediatez — la espera del desvanecido**  | `SETTLE_MS = 250` (`RouteMap.tsx:200`) más `ARRIVAL_MS = 250` (`RouteMap.tsx:215`) se aplican **siempre**, incluso cuando el país ya está en caché de React Query (`staleTime: Infinity, gcTime: Infinity`, `useSubdivisions.ts:70-71` — no hay red de por medio en una revisita). Mínimo 500 ms de espera desde que el mapa se detiene hasta que las fronteras están a opacidad completa, sea la primera vez o la décima                         | **(ii) estrategia de temporización/UX**, cero relación con geometría o con el renderer                                                                                            | **No.** Confirmado en el propio código: es un `setTimeout` con un valor fijo, no una espera por datos o por un frame lento.                                                                                                                                                                                             |

### 2.1 Sobre la resolución de los datos (aclarando C)

`services/api/app/services/subdivisions.py:4-12` documenta exactamente qué resolución existe:

> "There is no 1:110m admin-1 anywhere: Natural Earth's 1:50m admin-1 covers nine countries
> and nobody else, so the only worldwide option is 1:10m, which is 40 MB of GeoJSON."

Es decir: **1:10m ya es el techo mundial disponible en una fuente pública y sin atribución**
(Natural Earth, verificado el 2026-08-19 según el mismo docstring) para fronteras de primer
nivel. Pedir "más resolución" en las subdivisiones ya servidas no tiene a dónde ir sin salir
a fuentes oficiales por país, heterogéneas y bastante más caras de mantener. Lo que sí tiene
recorrido — y es el caso concreto de C — es **cuántos países consiguen ese 1:10m en una vista
dada**, que es enteramente cuestión del presupuesto de 256 KB de `lib/fanOut.ts`, no de qué
existe.

---

## 3. Los efectos visuales (queja B), uno por uno

| Efecto pedido                                                                                                    | ¿Existe ya?                                                                                                                                                                                    | ¿Alcanzable en Canvas 2D / SVG?                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Coste                                                                                  |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Atmósfera / halo alrededor del globo**                                                                         | **Sí, ya existe.** `RouteMap.tsx:642-652`: un `createRadialGradient` justo fuera del limbo del globo (radio 0,96x a 1,16x), leído de `--map-halo`                                              | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Ya pagado                                                                              |
| **Iluminación del globo (cara "lit")**                                                                           | **Sí, ya existe.** `RouteMap.tsx:613-631`: el océano se pinta con un `createRadialGradient` descentrado (arriba-izquierda, `cx - radius*0.35, cy - radius*0.4`) para simular una fuente de luz | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Ya pagado                                                                              |
| **Terminador día/noche real** (la mitad nocturna del globo oscurecida según la hora)                             | No                                                                                                                                                                                             | **Sí.** `d3-geo` (ya una dependencia) tiene `geoCircle()`; centrado en el punto antisolar actual con radio 90°, da exactamente el círculo del terminador. Se dibuja como un `Path2D` más, oscurecido y semitransparente, con el mismo `geoPath` que ya se usa para todo lo demás                                                                                                                                                                                                                                                                          | Bajo — una función más en `lib/globe.ts`, un `fill()` más en `draw()`                  |
| **Brillo/resplandor en los arcos que fluyen**                                                                    | No (verificado: no hay `shadowBlur`, `filter` ni `drop-shadow` en `RouteMap.tsx` ni en `RouteMap.module.css`)                                                                                  | **Sí, y más barato de lo normal:** los arcos son `<path>` de SVG (`RouteMap.tsx:1733-1739`), no canvas — un filtro SVG nativo (`<feGaussianBlur>` + `feMerge`, o simplemente `filter: drop-shadow(...)` en CSS) da resplandor sin una sola línea de JavaScript, compuesto por el propio navegador                                                                                                                                                                                                                                                         | Muy bajo — una regla CSS                                                               |
| **Profundidad real en los arcos** (elevados sobre la superficie, no pegados a ella, como en Cesium/Google Earth) | No. `greatCircle()` (`lib/geo.ts:275-285`) muestrea puntos exactamente sobre la esfera, sin altitud                                                                                            | Sí, pero con más trabajo: `geoOrthographic` solo sabe proyectar puntos _sobre_ la esfera unitaria. Elevar un arco exige calcular a mano la posición 3D de cada muestra (escalar el vector unitario por `1 + altura(t)`), aplicar la misma rotación que ya usa `versor`, y proyectar con una perspectiva débil manual — matemática de vectores en CPU, sin canvas ni GPU de por medio, pero es trabajo nuevo, no una línea de configuración                                                                                                                | Medio                                                                                  |
| **Profundidad continua en arcos/aeropuertos que se alejan del centro visible**                                   | Parcial y binaria: `RouteMap.module.css:329-331`, `.behind { opacity: 0.3 }` — un interruptor, no un desvanecido                                                                               | **Sí**, con la misma función que ya usan los nombres de lugar: `limbFade()` (`lib/globe.ts:125-128`, ya usada en `RouteMap.tsx:1452`) da un desvanecido continuo por cercanía al horizonte. Aplicarla a la opacidad de arcos y aeropuertos en vez del interruptor fijo es reutilizar código que ya existe                                                                                                                                                                                                                                                 | Bajo                                                                                   |
| **Relieve / batimetría (textura de elevación) sobre el globo girando**                                           | No                                                                                                                                                                                             | **No, honestamente.** `drawImage` de Canvas 2D solo hace transformaciones afines (escala, rotación, traslación); deformar una textura equirectangular a través de una proyección ortográfica no lineal, cada frame, mientras el globo gira, no es una transformación afín. Es exactamente el caso donde un _fragment shader_ de GPU (muestrear una textura por lat/lon, por píxel) es la herramienta natural — remapear la imagen en CPU con `ImageData` es posible pero cuesta del orden de decenas de ms por frame para un lienzo completo, y no escala | Alto, y el único ítem de esta lista donde "GPU" es la respuesta honesta, no una excusa |

**Resumen de la sección:** de seis efectos pedidos, dos ya están hechos, tres son alcanzables
en la pila actual (uno de ellos, el resplandor de los arcos, casi gratis por ser SVG), uno es
de esfuerzo medio pero sigue sin requerir GPU, y **solo uno — relieve/batimetría con textura
sobre un globo que gira — es honestamente un caso de GPU**, y ni siquiera ese exige adoptar
`vgpu` en particular (ver §5).

---

## 4. Victorias baratas, sin cambiar de renderer

En el orden en que atacan las cuatro quejas:

1. **Extender la caché de geometría fina más allá de "vista exactamente igual".** El arreglo
   de fondo para la queja A: en vez de invalidar `served.current` con cualquier cambio de
   `zoom`/`rotation`/`pan`, reproyectar solo cuando el cambio acumulado supera un umbral (p.
   ej. un grado de rotación, o un 2% de zoom) y, entre medias, aplicar una transformación
   afín aproximada sobre el `Path2D` ya construido (canvas soporta `setTransform` sobre el
   contexto antes de un `fill`/`stroke`, que es exactamente una operación afín barata) — el
   mismo patrón que un motor de mapas por _tiles_ usa para no volver a pedir un _tile_ en
   cada frame de un _pan_. Esto no cambia el renderer, cambia cuándo se le pide trabajo.

   **Implementado (commit `efa84d8`, #147) de forma distinta a como se esboza arriba, y
   recalibrado en esta sesión.** En vez de un umbral por grados de rotación acumulados más
   una afín aproximada, `reprojectionCache.decideReuse` usa una afín _exacta_ para
   escala/traslación (§1.3 de este documento sigue describiendo esa parte con precisión) y,
   solo para el caso de rotación — donde ninguna afín puede ser exacta — un umbral de
   **tiempo**: la geometría ya proyectada se sigue dibujando sin moverse hasta
   `ROTATE_REBUILD_MS` (120 ms) después de construida, y entonces se reproyecta. Ese umbral
   fijo resultó ser el propio origen de un bug nuevo: durante esos hasta 120 ms el país
   dibujado se queda literalmente detrás del giro del globo, un desfase medido en esta sesión
   (globo real, Chromium con GPU, no el Chromium sin aceleración de §1.2) en hasta **~60 px**
   para EEUU a zoom de fronteras estatales con un giro de 60°/s — visible como una costura o
   una cuña oscura en el borde de avance del país mientras gira. La causa: el umbral de 120 ms
   se calibró para el país más caro (EEUU) pero se aplicaba **igual a todos**, así que un país
   barato de reproyectar (El Salvador, por ejemplo) pagaba el mismo retraso que EEUU sin
   necesitarlo. El arreglo — `rotateThrottleMs`/`geometryWeight` en `reprojectionCache.ts` —
   escala ese umbral por el peso real de la geometría de cada país (vértices de tierra y
   fronteras internas, decodificados), calibrado para que EEUU (el más pesado, 41.825 puntos)
   siga recibiendo exactamente los mismos 120 ms de antes — sin regresión para el caso que
   motivó la constante — mientras que México (12.747 puntos, ~30% del peso de EEUU) se pone
   al día más de tres veces más seguido, y un país tan liviano como El Salvador (1.031 puntos)
   se reproyecta en prácticamente cada frame. Medido en el mismo escenario tras el cambio: el
   desfase de EEUU no cambia (sigue el mismo umbral, ~40-60 px según el frame muestreado,
   coherente con no tocar el caso calibrado), y el de países livianos cae a 0 px en la ventana
   de prueba. La cuadrícula de pruebas de este trade-off vive en
   `reprojectionCache.test.ts`.

   **Recalibrado otra vez en una sesión posterior (commit de este trabajo): degradar
   resolución en vez de congelar posición.** El (b) de arriba deja EEUU con exactamente el
   mismo desfase de antes de (b) — su peso es la propia referencia, así que sigue recibiendo
   los 120 ms íntegros — y ese desfase medido de nuevo en esta sesión, con el mismo método de
   navegador (globo real, sin aceleración de hardware forzada, `performance.now` interceptado
   para simular pasos de 16 ms dentro de una sola llamada de página, comparando la posición
   verdadera de un punto lon/lat contra su reproyección bajo la instantánea congelada), llega
   a **hasta ~195 px** para EEUU a una escala de proyección de 2.386 (zoom de fronteras
   estatales, Montana/Dakota del Norte/frontera con Canadá) — más que los ~60 px heredados
   porque el punto de prueba y la escala son distintos, no porque el bug haya empeorado; y a
   **~66 px** para México en el mismo experimento, sobre el mismo punto de referencia
   (12.747 puntos, throttle de ~36,6 ms), que el informe anterior no había medido con este
   método. El problema de fondo — el umbral acota _cuándo_ se paga por reproyectar, no _qué_
   se dibuja mientras tanto — seguía sin tocar.

   La premisa se verificó antes de tocar código: reproyectar el contorno 1:110m de EEUU (el
   mismo que ya sirve `world-atlas/countries-110m.json` y que el mapa ya usa para un país
   fuera de presupuesto, §4 punto 5 y `lib/fanOut.ts`) cuesta, medido en el navegador sobre
   3.000 repeticiones, **~0,52 ms de media** — contra ~85 ms para reproyectar la geometría
   1:10m completa (tierra + fronteras internas) en el mismo banco de pruebas, **164 veces más
   barato**. Sobra margen de sobra dentro de un frame de 16,7 ms para pagarlo todos los
   frames, incluso los que además reconstruyen la geometría 1:10m completa de otro país.

   El arreglo: mientras `decideReuse` devuelve `stale` para un país, `RouteMap.tsx` ya no
   reutiliza su `Path2D` 1:10m congelado sin moverlo. En su lugar dibuja el contorno 1:110m de
   ese mismo país — el que `coarse.shapes` ya recorta como clip cada frame, así que la única
   `geoPath` nueva es sobre un contorno, no sobre miles de vértices — reproyectado con la
   proyección **en vivo** de ese frame, y omite sus fronteras administrativas internas
   mientras dura la degradación (dibujarlas contra un contorno que se acaba de mover las
   habría dejado cruzando la costa). Al construirse desde la misma instancia de proyección que
   todo lo demás en el frame, la posición dibujada coincide con la verdadera por construcción,
   no por medición — lo que sí se midió, en esta sesión, es que la ruta de código realmente se
   activa: de 60 frames de un giro simulado de 60°/s, EEUU pasó por la rama degradada en 52 y
   México en 40, y en ninguno de los dos el contorno degradado costó más de ~1 ms.

   Medido tras el cambio, en el mismo escenario: el coste por frame de `draw()` durante un giro
   continuo simulado (120 llamadas reales, sin simular el reloj) tiene una mediana de 7 ms y un
   p95 de 11,3 ms, con solo 3 de 120 frames por encima de 16,7 ms — el mismo patrón de picos
   ocasionales por la reconstrucción periódica de EEUU cada ~120 ms que este documento ya
   aceptaba antes de (b) y (c), sin empeorar: `decideReuse`, `geometryWeight` y
   `rotateThrottleMs` no cambiaron una línea de lógica en esta sesión, solo sus comentarios —
   verificado por diff. El paso de escalón no compite con `SETTLE_MS`/`ARRIVAL_MS` por la misma
   razón: no toca cuándo se piden ni cuándo llegan los datos, solo qué se dibuja mientras un
   país ya detallado se pone al día con el giro. Los 79 tests de
   `reprojectionCache.test.ts`/`RouteMap.test.tsx` siguen en verde sin cambios, porque la
   decisión (`decideReuse`) no cambió — lo que cambió es una rama de dibujo en `canvas`, que
   `RouteMap.test.tsx` no ejerce (`getContext` se mockea a `null` en ese archivo), de ahí que la
   verificación real para este cambio sea de navegador y no de test unitario.

   **Recalibrado una tercera vez (esta sesión): un reporte de "bordes negros de los países,
   aún hay bugs visuales" durante el giro.** (c) resuelve la posición de un país degradado
   mientras gira — su contorno 1:110m se reproyecta en vivo, no se queda congelado — pero
   `decideReuse` sigue decidiendo `stale` país por país, de forma independiente. Durante un
   giro continuo, dos países vecinos pueden estar en ramas distintas en el mismo frame: uno ya
   reproyectado en 1:10m, el otro todavía dibujando su contorno 1:110m porque su propio
   `rotateThrottleMs` no ha vencido. Verificado en el navegador forzando ese desacople
   (`decideReuse` de un país fijado a `stale` mientras sus vecinos seguían en `rebuild`/`reuse`,
   ambos capturados con `window.__mapDebug` frame por frame durante un giro real): la frontera
   compartida entre Chile (forzado `stale`) y Bolivia (sin forzar) se abre en una costura
   dentada de fondo oscuro, no un doble trazo — la línea 1:110m de Chile y la línea 1:10m de
   Bolivia no comparten vértices en absoluto, y difieren en 1,5-5,2 km de mediana (hasta 31 km
   en el peor vértice, la misma medición de más arriba en este documento), así que ninguno de
   los dos rellenos cubre la franja entre ambos. Eso es exactamente lo que un lector describe
   como "bordes negros" — y solo durante el giro, porque en reposo todos los países vecinos
   comparten la misma resolución (todos en 1:10m o, tras un `reset`, todos recién construidos a
   la vez).

   El arreglo no puede ser país por país, porque el desacople es entre las respuestas de dos
   países, no un error en ninguna de las dos por separado. `reprojectionCache.anyStale`
   decide, **antes de que ninguno dibuje nada**, si algún país redibujado en este frame
   respondió `stale`; si es así, `RouteMap.tsx` hace que **todos** los países redibujados de
   este frame dibujen su contorno 1:110m juntos — la misma rama de (c), aplicada al grupo en
   vez de a cada país por su cuenta — en lugar de dejar que cada uno responda por separado. El
   costo es que un país que ya le tocaba ponerse al día se queda en baja resolución tanto como
   el vecino más lento; el beneficio es que las dos resoluciones nunca coexisten en la misma
   frontera compartida, porque el atlas 1:110m ya tesela consigo mismo por construcción. Un
   país cuyo `decideReuse` respondió `rebuild` pero cuyo frame terminó degradado por el grupo
   **no reproyecta su geometría 1:10m ese frame** — el trabajo se habría descartado sin
   dibujarse — así que su caché queda tan desactualizada como estaba, y la próxima vez que
   `decideReuse` lo pida se reproyecta desde la rotación que esté vigente entonces, no desde
   una ya vieja cuando se pidió. Repetido el mismo experimento de forzado tras el cambio: la
   costura desaparece porque ambos países — el forzado y su vecino — degradan juntos al mismo
   contorno 1:110m, verificado con capturas antes/después a la misma región y el mismo zoom.
   `anyStale` vive en `reprojectionCache.ts` junto a `standInFor`/`strokesInnerBorders`, con
   tests que cubren: ningún país `stale` (falso), un solo país en pantalla que sí lo es
   (verdadero), y un `stale` entre otros que no lo son (verdadero) — la regla que la corrección
   necesitaba probar, porque un país vecino "vota" por todos.

2. **Separar "cuándo pedir datos" de "cuándo mostrarlos" (queja D).** `SETTLE_MS`/`ARRIVAL_MS`
   existen para no bombardear la red mientras el lector gira el globo — una razón válida
   para el _fetch_. Pero un país cuyos datos **ya están en la caché de React Query** no tiene
   ninguna razón de red para esperar: el `setTimeout` de `RouteMap.tsx:969-995` podría
   comprobar si el país ya está resuelto (`queryClient.getQueryData`) y, si lo está, saltar
   directo al desvanecido de `ARRIVAL_MS` sin los 250 ms de `SETTLE_MS` — sin tocar una línea
   de canvas.
3. **Subir el presupuesto de fan-out de forma dinámica en vez de fijo (queja C).**
   `VIEW_BUDGET_BYTES = 256_000` es un valor medido para que un frame no baje de ritmo —
   pero la medición que lo fijó (`lib/fanOut.ts:59-70`) es anterior a saber que reconstruir
   la geometría cuesta 0 ms con caché fría y 18-21 ms sin ella (§1.3). Si el arreglo nº 1 se
   hace primero, el presupuesto puede subirse con más margen sin repetir el mismo frame lento
   — más países como Canadá o México llegan a 1:10m junto a EEUU.
4. **Terminador día/noche, resplandor en los arcos, desvanecido continuo por horizonte en
   arcos/aeropuertos (queja B).** Los tres de la tabla de la §3 marcados como alcanzables sin
   GPU — el resplandor de los arcos en particular es una regla CSS.
5. **Servir un nivel 1:50m intermedio para los vecinos que se quedan fuera del presupuesto**,
   en vez de que se queden en 1:110m — decisión 12.24 rechazó **empaquetar** 1:50m en el
   bundle inicial por peso (236 KB gzip para el mundo entero), pero eso no impide **servirlo
   bajo demanda**, igual que ya se hace con el 1:10m, como un peldaño entre "nada" y "1:10m
   completo" para el país que no entra en el presupuesto — una idea a validar, no algo que
   este documento confirme que ya funciona.

**Conclusión de la evaluación 1:50m (2026-09-02): no implementarlo aún.** Natural Earth solo
cubre nueve países en esa escala, por lo que no puede ser el escalón general que sustituya al
atlas 1:110m para un vecino rechazado. El catálogo y el endpoint actuales solo describen una
variante 1:10m por país; añadir 1:50m exige producir, servir y presupuestar una segunda variante
y medir sus bytes, tiempo de descarga y coste de `geoPath` en esos nueve casos. El presupuesto
de 512 KB ya cubre el caso de uso prioritario sin esa complejidad; si futuros perfiles muestran
que uno de esos nueve países sigue siendo el rechazo dominante, se hará esa medición y se
propondrá como una fase de datos separada.

**Qué cubren estas cinco de las cuatro quejas:** A (parcial a total, según cuánto se suba el
umbral del nº1), B (parcial — tres de seis efectos), C (parcial — nº3 y nº5 alivian, no
eliminan, el límite del presupuesto), D (total — nº2 elimina la espera artificial en
revisitas). Ninguna de las cinco toca `RouteMap.tsx`'s elección de Canvas 2D + SVG.

---

## 5. Alternativas de renderer

### 5.1 vgpu — análisis original, conservado íntegro

`vercel-labs/vgpu` **no es una librería de mapas**: es un _wrapper_ de bajo nivel sobre WebGPU
de propósito general (shaders WGSL tipados, escenas 3D, cómputo GPU — README: _"Modular
cross-runtime WebGPU library for shaders, 3D scenes, GPU tensors, neural networks, and math
viz"_). MIT, activo (`0.3.1` en npm, primera publicación 2026-05-26, ~32.700 descargas/mes,
5 colaboradores), pre-1.0. Cero menciones a proyecciones, globos, canvas 2D o SVG en su
documentación pública — adoptarlo no resolvería una sola línea de la cartografía que hoy vive
en `lib/globe.ts`/`lib/visible.ts`/`RouteMap.tsx`, solo cambiaría la superficie de dibujo, y
todo el trabajo de proyección, teselado, _picking_ y corte por horizonte habría que
escribirlo a mano en WGSL. Requiere WebGPU nativo del navegador — habilitado por defecto en
Chrome/Edge desde 2023, mucho más recientemente en Safari (solo desde la versión de SO "26",
~sept. 2025) y de forma parcial en Firefox (Windows sí, Linux/Mac Intel no todavía) — sin
ningún mecanismo de _fallback_ propio. El inventario completo (qué es matemática de proyección
portable y qué está casado con el canvas actual), el coste en los 55 tests de
`RouteMap.test.tsx`, y el análisis de adopción parcial siguen en el documento original y no
se repiten aquí porque no ha cambiado nada de eso — la única corrección de este reencuadre es
que "no hay síntoma de rendimiento" **era cierto para el mundo a 1:110m y falso para las
subdivisiones**, ver §1.

### 5.2 Las alternativas que sí son renderers de mapas

A diferencia de `vgpu`, estas tres traen proyección, interacción y algunos efectos ya resueltos.
Lo que sigue combina hechos que puedo dar por conocidos con razonable confianza (arquitectura,
licencia, características principales) con huecos explícitos que **no verifiqué en esta
sesión** — la búsqueda dedicada a esto se lanzó y fue interrumpida antes de completarse, así
que cualquier cifra exacta (tamaño de bundle en KB, fecha de último release, nº de estrellas)
marcada como "sin verificar" debe confirmarse contra bundlephobia.com/npm/el repo antes de
decidir con ella.

|                                                                     | **deck.gl (`GlobeView`)**                                                                                                                                 | **globe.gl / three-globe**                                                                                                | **MapLibre GL JS (proyección `globe`, v5+)**                                                                                                                                                                                                     |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Motor                                                               | WebGL2. (Su sucesor `luma.gl` v9 explora WebGPU, pero `GlobeView` en producción hoy es WebGL2, no WebGPU — **confirmar versión exacta antes de decidir**) | Three.js → WebGL. (Three.js tiene un `WebGPURenderer` experimental, pero `three-globe`/`globe.gl` no lo usan por defecto) | WebGL/WebGL2                                                                                                                                                                                                                                     |
| ¿Globo + Mercator en la misma librería?                             | Solo globo (`GlobeView` es una vista 3D dedicada; el Mercator plano de deck.gl es una vista distinta, `MapView`)                                          | Solo globo — es su único modo                                                                                             | **Sí**, es la única de las tres pensada para esto: la proyección `globe` de MapLibre v5 es un modo del mismo mapa, intercambiable en caliente con el Mercator plano de siempre                                                                   |
| Licencia                                                            | MIT                                                                                                                                                       | MIT (ambos)                                                                                                               | BSD-3-Clause (bifurcación de Mapbox GL JS anterior al cambio de licencia de Mapbox)                                                                                                                                                              |
| Nodos DOM/SVG por elemento (aeropuertos, etiquetas) vs. todo-canvas | Todo-canvas; _picking_ por buffer de color codificado, no hay nodo por marcador                                                                           | Todo-canvas (escena Three.js); _picking_ por _raycasting_, no hay nodo por marcador                                       | **Híbrido** — las capas de datos (`fill`/`line`/`circle`) son WebGL, pero su API `Marker`/`Popup` coloca elementos DOM reales posicionados sobre el mapa, pensada explícitamente para casos donde un marcador necesita ser interactivo/accesible |
| Arcos animados como primitiva                                       | **Sí** — `ArcLayer` es una de sus capas principales, hecha justo para esto (origen/destino con gran círculo)                                              | Sí — `three-globe` incluye una capa de arcos, es una de sus demos insignia                                                | No como primitiva directa; se puede construir con una fuente `geojson` de líneas y estilos animados, con más trabajo manual                                                                                                                      |
| Datos propios (GeoJSON/TopoJSON locales, sin _tiles_)               | Sí, sin problema — es agnóstico a la fuente                                                                                                               | Sí, sin problema                                                                                                          | Sí — soporta una fuente `type: "geojson"` con datos locales y un estilo sin ninguna capa de _tiles_ ("_blank style_"), que es justo el caso de este repositorio (nunca toca la red para _tiles_)                                                 |
| Tamaño de _bundle_                                                  | Conocido por ser considerable (núcleo + capas); cifra exacta **sin verificar** — confirmar en bundlephobia antes de decidir                               | Three.js por sí solo ronda un mínimo no trivial y `three-globe`/`globe.gl` añaden más; cifra exacta **sin verificar**     | Cifra exacta **sin verificar**                                                                                                                                                                                                                   |
| Mantenimiento activo a sept. 2026                                   | Proyecto de Uber/OpenJS Foundation con historial largo de mantenimiento; estado exacto reciente **sin verificar**                                         | Proyecto individual con adopción amplia; estado exacto reciente **sin verificar**                                         | Proyecto de OpenJS Foundation, sucesor comunitario de Mapbox GL JS, con cadencia de releases activa conocida; fecha exacta del último release **sin verificar**                                                                                  |

**Lo que se puede afirmar sin más verificación, solo con lo anterior:**

- Las tres siguen siendo **una sola superficie de canvas** para los datos del mapa en sí — el
  problema de la §3b del análisis de `vgpu` (aeropuertos y etiquetas dejan de ser nodos DOM
  consultables por `RouteMap.test.tsx` o por un lector de pantalla) se repite en deck.gl y en
  globe.gl/three-globe **igual que con WebGPU crudo**. MapLibre es la única con un mecanismo
  propio (`Marker`/`Popup`) pensado para resolver justo eso, porque lo necesitaba para sus
  propios usuarios de mapas de verdad.
- Las tres son WebGL, no WebGPU — el problema de soporte de navegador de la §1 del análisis
  de `vgpu` **no existe** con ninguna de las tres: WebGL2 tiene soporte casi universal desde
  hace años, sin la brecha de Safari/Firefox que sí tiene WebGPU hoy.
- MapLibre es la única que resuelve el requisito de "globo y Mercator en el mismo sistema" sin
  mantener dos motores de render en paralelo — pero también es la que más se aleja del modelo
  de estilos/capas que este mapa usa hoy (paint properties declarativas, no dibujo a medida),
  así que el coste de adopción no es solo el _renderer_: es reaprender su forma de describir un
  mapa.
- deck.gl es la única con un `ArcLayer` literalmente hecho para lo que la queja de "arcos con
  brillo/profundidad" pide, pero solo resuelve el globo, no el Mercator, y viene con el coste
  de _picking_ de la fila anterior.

**Lo que queda explícitamente sin verificar y debe confirmarse antes de tomar una decisión con
alguna de las tres:** tamaño exacto de _bundle_ de cada una (crítico, porque esta feature hoy
pesa lo que pesan `d3-geo` + `topojson-client` + `versor`, mucho menos que un motor de mapas
completo), fecha del último release y cadencia de mantenimiento actual, y si alguna ha añadido
soporte WebGPU de forma estable desde la fecha de conocimiento de quien escribe esto.

---

## 6. Plan por fases

Ordenado por beneficio percibido entre riesgo — lo que más se nota primero, lo más reversible
primero:

**Fase 1 — sin tocar el renderer, días.**
Los cinco puntos de la §4: extender la vida de la caché de `Path2D` más allá de "vista
idéntica" (arreglo de fondo para A), separar el _fetch_ de la temporización visual para
países ya en caché (arreglo completo para D), terminador día/noche y resplandor SVG en los
arcos (dos de los seis efectos de B), y desvanecido continuo por horizonte en arcos/aeropuertos
reutilizando `limbFade`. Riesgo: bajo — son cambios locales, con los tests de
`RouteMap.test.tsx` ya en pie para verificar que nada de la interacción se rompe.

**Fase 2 — presupuesto y datos, días a una semana.**
Subir `VIEW_BUDGET_BYTES` una vez la fase 1 haya bajado el coste real de reproyectar (nº3 de
la §4), y evaluar si servir un peldaño 1:50m para los países que se queden fuera incluso del
presupuesto ampliado (nº5) — esto necesita medir primero cuánto margen dejó la fase 1, así que
va después, no en paralelo. Riesgo: bajo, pero depende de datos que la fase 1 todavía no ha
producido.

La subida a 512 KB ya quedó validada. La evaluación 1:50m concluye por ahora que no conviene
servirlo: su cobertura se limita a nueve países y faltan las mediciones por variante que
justificarían una segunda ruta de datos; se reabre solo con evidencia de un rechazo recurrente
en uno de esos países.

**Fase 3 — el único efecto que pide GPU, si de verdad importa.**
Relieve/batimetría con textura sobre el globo girando (la única fila de la §3 marcada como
GPU-honesto). Si se hace, la pregunta correcta no es "¿WebGPU o WebGL?" sino "¿vale la pena
añadir una sola textura vía WebGL —soporte universal, sin la brecha de Safari/Firefox de
WebGPU— para un solo efecto, manteniendo Canvas 2D/SVG para absolutamente todo lo demás?" Es
la única fase de este plan que introduce una segunda tecnología de render, y debería evaluarse
sola, después de ver qué tanto queda por pedir una vez hechas las fases 1 y 2.

**Cuándo tendría sentido plantearse un cambio de renderer completo (MapLibre, deck.gl, u
otro):** no como respuesta a estas cuatro quejas — las fases 1 y 2 las cubren sin eso — sino
si en el futuro aparece un requisito que el modelo actual (Canvas 2D + SVG, dibujado a mano)
no pueda dar en absoluto, por ejemplo _tiles_ de un proveedor externo, miles de rutas
simultáneas muy por encima del uso de hoy, o un catálogo de efectos que crezca mucho más allá
de la §3. Llegado ese punto, MapLibre es la candidata que menos se pelea con lo que ya existe
(soporta datos locales sin _tiles_, tiene un mecanismo DOM para marcadores accesibles, cubre
globo y Mercator a la vez) — pero su adopción sigue siendo una reescritura del modelo de
dibujo, no un cambio de una línea, y merece su propio análisis de factibilidad el día que haya
un motivo real para plantearla.
