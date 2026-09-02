# ¿Reemplazar el mapa de Airfare por vgpu? Análisis de factibilidad

**Pregunta:** ¿es factible reemplazar el renderizado actual del mapa de Airfare — el globo
(proyección ortográfica) y, si se puede, el Mercator plano — por
[`vercel-labs/vgpu`](https://github.com/vercel-labs/vgpu)?

**Respuesta corta:** no. `vgpu` no es una librería de mapas — es un wrapper de bajo nivel
sobre WebGPU sin nada de geografía, proyecciones ni cartografía. Adoptarlo no sería
"cambiar el renderer del mapa", sería escribir un renderer de mapas GPU desde cero, en WGSL,
para un problema de rendimiento que ya está resuelto en este mismo repositorio con
matemática de CPU barata. Ver la recomendación completa en la §7.

---

## 0. Qué es vgpu, con evidencia

Repositorio: `github.com/vercel-labs/vgpu`. Existe, es público, no está archivado.

**Descripción del repo** (API de GitHub):
> "Modular cross-runtime WebGPU library for shaders, 3D scenes, GPU tensors, neural
> networks, and math viz"

**Primera frase de su README**:
> "vgpu is a TypeScript library for WebGPU: typed shader imports, a tiny gpu-first API,
> and the same code running in the browser, headless Node, and your test suite."

Es decir: una capa de conveniencia sobre `navigator.gpu` — importa `.wgsl` como módulos
TypeScript tipados, expone un contexto `Gpu` único y funciones como `init`, `draw`,
`compute`, `effect`, `frame`, `surface`, `target`, `uniforms`, `clock`, `frameLoop`. Ejemplo
de uso tal como aparece en su propio README:

```ts
import { clock, init, effect, frameLoop, surface } from "vgpu";
import waveShader from "./wave.wgsl";

const gpu = await init();
const canvasSurface = surface(gpu, canvas, { dpr: [1, 2] });
const wave = effect(gpu, waveShader, { set: { speed: 2 } });

const time = clock(gpu);
frameLoop(gpu, (frame) => {
  wave.set({ time: time.time });
  frame.pass(canvasSurface, wave);
});
```

Es la misma categoría de herramienta que `regl` o usar `navigator.gpu` a pelo, no la
categoría de Mapbox GL, deck.gl o MapLibre. **Ninguna mención a mapas, proyecciones
geográficas, globos, latitud/longitud, cartografía, canvas 2D o SVG aparece en su README ni
en el `package.json` de sus paquetes** — la búsqueda de código completa del repositorio no
pudo ejecutarse (la API de búsqueda de GitHub devolvió `401` sin autenticación), pero nada en
la documentación pública, los ejemplos publicados ni la descripción del proyecto sugiere que
exista esa pieza en ningún rincón del repo. Si existiera un ejemplo de mapa en su galería
(`vgpu.sh/examples`), sería un demo de un tercero hecho con la librería, no una pieza que la
librería resuelva por nosotros — exactamente como escribir un mapa con Three.js no viene
"incluido" en Three.js.

**Madurez.** Creado el 2026-05-05, último commit el mismo día de esta investigación
(2026-09-01) — proyecto activo. Versión npm actual `0.3.1` (pre-1.0), primera publicación
2026-05-26. 1.388 estrellas, 66 forks, 46 issues abiertas, **5 colaboradores** (uno de ellos
literalmente `claude`). 26 tags/25 releases. Sin aviso explícito de "experimental" en el
README, pero el propio `0.x` lo dice: es una API que aún puede romperse entre versiones
menores.

**Licencia.** MIT (`Copyright (c) 2025 Vercel, Inc.`), confirmada en el `LICENSE` del repo y
en los metadatos de npm.

**Publicación en npm.** Sí — paquete `vgpu` (no `@vercel-labs/vgpu`), 20 versiones
publicadas, ~32.700 descargas/mes. También publica paquetes separados bajo `@vgpu/*`
(`@vgpu/cli`, `@vgpu/core`, `@vgpu/wgsl`, `@vgpu/adapter-node`, `@vgpu/adapter-mock`,
`@vgpu/render`, …), es decir, un monorepo de infraestructura WebGPU, no un producto único.

**Qué requiere del navegador.** WebGPU nativo. El README no menciona WebGL en ningún punto
como *fallback* — es WebGPU o nada en el navegador. Sí soporta ejecución **fuera** del
navegador vía `vgpu/node` (respaldado por Dawn, la implementación nativa de Google) y un modo
`vgpu/mock` puramente por software para tests sin GPU real, que es justamente lo que hace
falta preguntarse en la §4.

---

## 1. Requisitos de navegador y soporte real de WebGPU

Según la wiki de estado del W3C GPU for the Web Community Group
(`github.com/gpuweb/gpuweb/wiki/Implementation-Status`, la fuente más autorizada y
actualizada porque la mantiene el propio grupo de trabajo del estándar):

| Navegador | Estado por defecto |
|---|---|
| Chrome / Edge (escritorio: Mac, Windows, ChromeOS) | Habilitado desde v113 (2023) |
| Chrome / Edge Android | Habilitado en ARM/Qualcomm/Intel Android 12+ desde v121; Imagination desde v139; Samsung Xclipse aún en curso |
| Firefox Windows | Habilitado desde v141 (jul. 2025) |
| Firefox macOS (Apple Silicon) | Habilitado desde v145/147 (fin 2025 / 2026) |
| Firefox macOS (Intel) / Linux | Solo en Nightly; Linux estable "en algún momento de 2026" |
| Firefox Android | Detrás de flag |
| Safari (macOS, iOS, iPadOS, visionOS) | Habilitado desde la versión de SO **"26"** (~sept. 2025) |

MDN clasifica WebGPU como **"Limited availability — not Baseline because it does not work in
some of the most widely-used browsers"** y exige contexto seguro (HTTPS). caniuse.com reporta
un ~85,6 % de soporte global (cifra aproximada; hay discrepancias de detalle con la wiki de
gpuweb sobre Firefox, que es la fuente que se prioriza aquí).

**Qué significa esto para este mapa en concreto:**

- Cualquier Safari/iOS anterior a la versión de sistema operativo "26" —lanzada hace apenas
  un año, y en un ecosistema donde no todo el mundo actualiza el SO— no dibuja nada.
- Firefox en Linux o en Mac con procesador Intel, hoy, tampoco.
- El repositorio **no tiene un `browserslist` configurado** (verificado: no existe
  `.browserslistrc` ni campo `browserslist` en `package.json`), así que no hay ni siquiera
  una matriz de navegadores objetivo declarada contra la que contrastar esto.
- `vgpu` no trae ningún mecanismo de *fallback* — la detección de si `navigator.gpu` existe y
  qué mostrar si no, es responsabilidad de quien lo adopta.

Un mapa que no dibuja nada en un Safari sin actualizar o en un Linux con Firefox no es una
mejora, es una regresión para esa fracción de sesiones — y la única forma honesta de evitarla
es mantener **dos** implementaciones completas (la actual y la de GPU) y decidir en tiempo de
ejecución cuál mostrar, lo que cambia radicalmente el cálculo de coste de la §5.

---

## 2. Qué hay hoy — inventario de la implementación actual

Antes de comparar, lo que existe (arquitectura resumida en el propio comentario de cabecera
de `apps/web/src/features/airfare/ui/RouteMap.tsx:51–108`, que documenta la decisión con la
misma seriedad que un ADR):

- **Dos superficies superpuestas**, no una:
  - Un `<canvas>` (`RouteMap.tsx:1644`) pintado con la API Canvas 2D (`canvas.getContext('2d')`
    en `RouteMap.tsx:581`) para la esfera, el agua, el halo y cada frontera de país, usando
    `d3-geo`'s `geoPath(projection, context)` (`RouteMap.tsx:587, 766–768, 914`) para
    convertir geometría GeoJSON en trazos de canvas.
  - Un `<svg>` (`RouteMap.tsx:1645`) para los arcos de ruta, los aeropuertos y los nombres de
    lugar — nodos DOM reales, consultables por un test y por un lector de pantalla (decisión
    explícita, `RouteMap.tsx:94–95`).
- **Proyecciones**: `geoOrthographic` (globo) y `geoMercator` (plano), de `d3-geo`
  (`RouteMap.tsx:1`), con arrastre por cuaternión vía `versor` (`RouteMap.tsx:5, 1085–1180`) y
  reposicionamiento de zoom anclado al puntero.
- **Culling por casquete esférico** (`lib/visible.ts`, 275 líneas) para no proyectar geometría
  que no puede estar en pantalla — la optimización más importante del archivo, y a la que
  vuelvo en la §6.
- **Animación de flujo de los arcos** (`lib/arcFlow.ts`, 85 líneas): fases de
  `stroke-dashoffset` calculadas en JS puro pero **animadas por el propio navegador vía CSS**,
  sin bucle de `requestAnimationFrame` en reposo (`RouteMap.tsx:59–66, 68–76`).
- **Etiquetado de lugares** con anti-solape, fundido por zoom y por cercanía al horizonte
  (`lib/globe.ts`, 429 líneas: `limbFade`, `screenArea`, `roomFade`, `continentFade`,
  `countryFade`, `subdivisionFade`, `withoutOverlaps`, `nudgeIntoFrame`).
- **Paleta**: los colores del canvas se leen en cada frame desde variables CSS
  (`getComputedStyle` en `RouteMap.tsx:254–255`) para que el canvas y el SVG compartan
  exactamente la paleta de mapcn definida en `RouteMap.module.css`.
- Dependencias: `d3-geo ^3.1.1`, `topojson-client ^3.1.0`, `versor ^0.2.0`,
  `world-atlas ^2.0.2`.
- Historia (`git log --oneline --all | grep -i globe`): cuatro commits que construyeron esto
  de forma incremental — `240490c` (arcos sobre un globo o plano), `07a70e0` (zoom, pan,
  transparencia), `766b5ef` (paleta de mapcn y zoom con inercia), `907b6c2` (flujo de los
  arcos y color estable de los aeropuertos). No es un prototipo: es una feature madura con
  cuatro rondas de refinamiento y un archivo de tests de 1.626 líneas.

---

## 3. Inventario de lo que habría que portar

### 3a. Matemática de proyección — reutilizable, independiente del renderer

Esto no cambia lo use lo que lo use para pintar; sigue siendo aritmética sobre
longitud/latitud/radianes:

| Pieza | Dónde | Por qué es portable |
|---|---|---|
| Círculo máximo, `facesViewer`, `pairKey`, `nextWatch` | `lib/geo.ts` (296 líneas) | JS puro sobre `[lng, lat]`, sin canvas ni SVG |
| Arrastre por cuaternión (`versor.cartesian/delta/rotation/multiply`) | `RouteMap.tsx:1085–1180` | Calcula una rotación; no dibuja nada |
| `clampPan`, `limbFade`, `screenArea`, `roomFade`, `continentFade`, `countryFade`, `subdivisionFade`, `approach` (inercia del zoom) | `lib/globe.ts:87–301` | Devuelven números (offsets, opacidades, factores de escala) |
| Culling por casquete esférico (`capOf`, `capsMeet`, `viewCap`) | `lib/visible.ts` (275 líneas) | Decide qué proyectar, no cómo pintarlo — seguiría haciendo falta con GPU para no subir de más a la tarjeta |
| Fase del flujo animado (`polylineLength`, `flowDelay`) | `lib/arcFlow.ts` (85 líneas) | Aritmética sobre una polilínea ya proyectada |

Estas piezas se podrían seguir usando en CPU y pasar sus resultados (rotación, escala, pan,
opacidades) como *uniforms* a un shader — es, de hecho, la única parte de esta migración que
no habría que rehacer.

### 3b. Piezas casadas con el canvas/SVG actual — hay que reescribirlas

| Pieza | Dónde | Qué exigiría en GPU |
|---|---|---|
| `geoPath(shown, context)` | `RouteMap.tsx:587, 766–768, 914` | d3-geo delega el trazado real al `CanvasRenderingContext2D` que se le pasa. No existe un adaptador equivalente para WebGPU: hay que triangular a mano cada `Feature`/`MultiLineString` de topojson y subirla como buffers de vértices. |
| Gradientes radiales del agua y del halo, y el recorte "contorno grueso → clip → contorno fino" | `RouteMap.tsx:613–653` y alrededor de `766–914` | `createRadialGradient`/`ctx.clip()` son API de Canvas 2D sin equivalente directo; hay que escribirlos como shaders (un gradiente radial en el fragment shader, una máscara de stencil o un segundo *pass* para el recorte). |
| Lectura de paleta desde CSS (`readToken`/`getComputedStyle`) | `RouteMap.tsx:254–255` | La idea (leer el token, convertirlo a color) es portable; el mecanismo ("un color CSS leído cada frame") no lo es — un shader no toma strings, hay que definir una convención nueva de paso de color como uniform. |
| Corte por horizonte para decidir qué mitad del arco dibujar | `lib/arcFlow.ts:1–19`, `splitByHorizon` en `lib/globe.ts` (usado desde `RouteMap.tsx`) | Hoy decide **qué `<path>` de SVG dibujar**. Con GPU pasaría a ser lógica de fragment shader (descartar o atenuar el lado oculto), otra reescritura completa. |
| Animación de flujo de los arcos | `RouteMap.tsx:68–76`, CSS `stroke-dashoffset` | Hoy la anima el navegador solo, sin JS por frame — la arquitectura está diseñada explícitamente para que **no corra ningún bucle en reposo** (`RouteMap.tsx:59–66`, "No frame loop runs at rest"). Con GPU la animación pasa a ser explícita (`frameLoop`, un uniform de tiempo, como el propio ejemplo del README de vgpu) — es decir, **reintroducir** el bucle continuo que esta arquitectura fue escrita para evitar, con el coste de CPU/batería que eso implica mientras un arco fluye. |
| Aeropuertos, colores y etiquetas | `RouteMap.tsx:1830–1899` (`<circle>`, `<text>`) | Hoy son nodos DOM de verdad. Como píxeles de GPU pierden toda semántica: dejan de ser algo que `aria-label`, un lector de pantalla o `screen.getByText` puedan alcanzar. |
| *Hit-testing* del puntero sobre un arco | `<path className={styles.hit}>`, `RouteMap.tsx:1733–1738` | Hoy es un trazo invisible más ancho que el navegador hace clicable gratis vía `pointer-events`. Con un único `<canvas>` de WebGPU no hay elementos DOM que recojan el clic: hay que implementar *picking* a mano (un buffer de IDs por color y leer el píxel bajo el cursor, o repetir la geometría en CPU para un test matemático), duplicando lo que hoy regala el navegador. |
| Mercator | Todo el bloque anterior, con `geoMercator` en vez de `geoOrthographic` | No hay "Mercator ya resuelto" en vgpu — comparte exactamente el mismo problema: el shader de proyección hay que escribirlo, sea cual sea la proyección. |

En resumen: **de lo que hoy dibuja este mapa, la parte que vgpu resolvería por nosotros es
cero.** Lo único que vgpu aporta es el arnés para escribir y ejecutar shaders WGSL con buena
experiencia de desarrollo (tipado, *hot reload*, `vgpu/mock` para tests) — la cartografía en
sí (proyecciones, teselado, iluminación de la esfera, *picking*, texto) seguiría siendo
trabajo propio, íntegro, escrito a mano.

---

## 4. El coste en tests

`RouteMap.test.tsx` tiene 1.626 líneas y 55 bloques `it()`, con **120 llamadas** a
`getByRole`/`getByText`/`getByLabelText`/`querySelector`/`getAllBy*` — es decir, la inmensa
mayoría de sus aserciones leen la estructura del DOM/SVG (rutas, círculos, textos,
`aria-label`, atributos `data-route`). El propio archivo lo explica en su comentario de
cabecera (`RouteMap.test.tsx:33–41`):

> "jsdom gives this component no canvas — `getContext` returns null and the globe never
> paints. That is the point of the split: the sphere and the land live on a canvas nobody can
> test, and the *routes* live in the DOM, where these assertions and a screen reader can both
> reach them. **A map built on a tile renderer would fail every test below, because its
> entire output is one opaque canvas element.**"

Esa última frase, escrita por quien construyó la arquitectura actual, describe con precisión
lo que pasaría con un mapa en WebGPU: **peor que un "tile renderer" opaco**, porque jsdom ni
siquiera implementa `navigator.gpu` — no hay un `getContext` que mockear a `null` como se hace
hoy en la línea 48 (`vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)`),
porque no existe la API que interceptar. Cualquier assertion de los 55 tests que hoy lee un
`<path>`, `<circle>`, `<text>` o `aria-label` dentro del `<svg>` deja de tener nada que leer en
cuanto ese contenido pasa a ser píxeles de un único canvas.

Coste concreto si se migrara **por completo** (globo y Mercator, ambas superficies):

- Los 55 tests de `RouteMap.test.tsx` que hoy verifican geometría, colores por ruta, fundido
  de nombres, orden de capas o *hit-testing* dejan de tener nada verificable sin un dispositivo
  GPU real o el modo `vgpu/mock` (que valida que el shader corrió, no que el píxel resultante
  es geográficamente correcto).
- `lib/globe.test.ts` (131 líneas, 16 tests), `lib/visible.test.ts` (239 líneas, 16 tests),
  `lib/clampPan.test.ts` (93 líneas, 7 tests) y `lib/arcFlow.test.ts` (82 líneas, 7 tests)
  siguen siendo válidos **solo si** la matemática de proyección se mantiene en CPU (§3a) — se
  pierden en la misma medida en que esa matemática se traslade al shader.
- No hay en este repositorio ningún test que hoy dependa de leer CSS compilado para el mapa;
  lo que sí hay es un mecanismo en tiempo de ejecución (`getComputedStyle`, `RouteMap.tsx:255`,
  documentado también en `RouteMap.module.css:1–5`) que sincroniza la paleta del canvas con la
  del SVG — no es un test, pero es exactamente el tipo de acoplamiento a CSS que un shader no
  puede replicar sin una convención nueva.
- La alternativa a "sin cobertura" es tests de regresión visual (capturar el `<canvas>` con
  Playwright/Puppeteer contra un navegador con GPU real o software, comparar píxeles) — viable,
  pero es una categoría de test que este repositorio no tiene hoy en ningún sitio, y que exige
  infraestructura de CI con GPU (o Dawn/`vgpu/node` como *software renderer*, con el riesgo de
  que lo que valida no es lo que ve un usuario real).

**Honestamente: una migración completa borra la mayor parte de la cobertura de
comportamiento de este componente y la reemplaza, en el mejor caso, por una categoría de test
que hay que construir desde cero.**

---

## 5. ¿Tiene sentido una adopción parcial?

Sí, y es la única forma en que "GPU" aporta algo sin asumir el coste completo de la §4:
**GPU solo para los arcos y su animación de flujo, conservando `d3-geo` + Canvas 2D + SVG
para todo lo demás** (esfera, tierra, fronteras, aeropuertos, etiquetas, *hit-testing*).

Por qué esto es lo único razonable a considerar:

- El flujo de los arcos es, precisamente, la única parte de este mapa que hoy **no** tiene un
  problema de rendimiento (se anima gratis vía CSS, sin JS por frame — `RouteMap.tsx:68–76`)
  pero es también la única parte donde "más arcos, todos fluyendo a la vez" podría llegar a
  costar algo si esa restricción cambiara en el futuro (hoy está limitada a como mucho dos
  arcos a la vez por diseño — `RouteMap.tsx:1701–1703`, "bounded at two arcs by construction").
  Es decir: es la pieza con menos que ganar y menos que perder, el candidato de menor riesgo
  para experimentar.
- Aun así, migrar *solo* los arcos seguiría exigiendo escribir el corte por horizonte
  (`splitByHorizon`) y el *hit-testing* de cada arco en un shader/*picking* a mano — el trabajo
  de la §3b para esa pieza en concreto no desaparece, solo se acota.
- El resto de la superficie (tierra, fronteras, aeropuertos, nombres) seguiría siendo Canvas
  2D + SVG, así que **se pierde la coherencia de una sola tecnología de renderizado** — dos
  superficies conviven ya hoy (canvas + SVG); esto añadiría una tercera (WebGPU) por una parte
  de la escena que hoy cuesta cero JavaScript en reposo.
- El beneficio real de esto sería casi puramente estético/de aprendizaje (evaluar la librería
  en un rincón acotado del producto) — no resuelve ningún problema medido, porque no hay
  ninguno que medir en esa pieza (ver §6).

**Conclusión de esta sección:** una adopción parcial reduce el riesgo frente a una migración
total, pero no cambia la conclusión de fondo: no hay un problema que el arco animado tenga hoy
y que WebGPU resuelva. Sería una migración especulativa, acotada, pero especulativa igual.

---

## 6. Qué problema real resolvería — ¿hay un problema de rendimiento medible?

**No, y además el único problema de rendimiento que existió en este mapa ya está medido,
diagnosticado y arreglado en este mismo repositorio, con matemática de CPU, sin tocar el
renderer.**

La evidencia está en el propio código, no hay que estimarla:

`lib/visible.ts:8–29` documenta el problema **antes** de la optimización que el mismo archivo
implementa:

> "Measured in Chrome on the reader's own 433x460 stage, during a sixteen-notch wheel zoom to
> the 32x ceiling: a frame spent 9.4 to 12.1 ms filling the bundled 1:110m land and 6.0 to
> 8.1 ms stroking its boundary mesh, out of a 17.6 to 21.7 ms frame [...] On a 165 Hz panel,
> whose frame budget is 6.1 ms, that is a zoom running at forty frames a second."

Y el resultado **después** de añadir el culling por casquete esférico (`capOf`/`capsMeet`/
`viewCap`, el propio contenido de ese archivo):

> "With this in place the same gesture holds a 6.1 ms median and never exceeds 24 ms, and the
> frames it delivered over the same 1.4 s go from 66 to 156."

Es decir: el problema real que este mapa tuvo — un zoom que caía a 40 fps porque se proyectaba
el 99,9 % de un planeta que no cabía en 316 px de radio visible — ya se resolvió, midiendo,
con una idea de geometría esférica (un casquete y una distancia de círculo máximo) que cuesta
un `asin` por frame. El mapa hoy sostiene una mediana de 6,1 ms de frame en el escenario que
antes lo hacía caer a 40 fps.

Hay otras dos mediciones en el repo, de escenarios distintos y con contexto propio (no
contradicen la anterior, la complementan):

- `lib/fanOut.ts:59–70`: "the whole map draws in 26.3 ms today with a pointer down" — este
  número es con las subdivisiones de un país (fronteras internas, p. ej. regiones de Perú)
  visibles y en arrastre activo, un escenario deliberadamente más pesado que el zoom general
  medido en `visible.ts`, y ya es el escenario que ese mismo archivo existe para acotar (un
  presupuesto de bytes de geometría por vista).
- `lib/countries.ts:126, 319–355`: optimizaciones de la indexación de qué país hay bajo el
  puntero (de 25,7 ms a 0,72 ms en un paso de zoom concreto) — de nuevo, un problema ya medido
  y ya resuelto, y que no tiene relación con cómo se rasteriza el mapa.

No hay, en ningún comentario, issue o commit de este repositorio, una queja de rendimiento
**abierta** sobre el mapa de Airfare. El patrón que sí hay, cuatro veces, es: alguien mide,
encuentra un cuello de botella concreto y lo arregla con una idea más barata que "cambiar de
tecnología" — nunca con "hace falta más GPU".

**Un cambio de las ~2.700 líneas que suman `RouteMap.tsx` + `lib/globe.ts` + `lib/visible.ts`
+ `lib/arcFlow.ts` necesita un síntoma. "Es GPU" no lo es, y aquí no hay otro.**

---

## 7. Estimación de esfuerzo y recomendación

### Esfuerzo estimado (orientativo, para dimensionar la decisión, no un compromiso)

| Alcance | Qué incluye | Orden de magnitud |
|---|---|---|
| Completo (globo + Mercator, todas las piezas de §3b) | Teselado de tierra/fronteras en WGSL, shaders de agua/halo/recorte, corte por horizonte en shader, *picking* de arcos y aeropuertos, reescritura de ~1.600 líneas de tests, infraestructura de test visual nueva, ruta de *fallback* sin WebGPU mantenida en paralelo | Semanas de trabajo, no días; el riesgo dominante es el *picking*, la accesibilidad de aeropuertos/etiquetas y el *fallback* de navegador, no el shader de la esfera en sí |
| Parcial (solo arcos, §5) | Shader del arco + su corte por horizonte + *picking* del arco, uniform de tiempo, mantener el resto en Canvas 2D/SVG | Días a una semana; sigue exigiendo el *fallback* de navegador y pierde parte de la cobertura de `RouteMap.test.tsx` relativa a los arcos |
| No hacerlo | — | Cero coste, cero riesgo nuevo introducido |

### Recomendación: **no hacerlo.**

Tres razones, en orden de peso:

1. **La premisa no se sostiene.** `vgpu` no es una librería de mapas ni de proyecciones — es
   un wrapper de WebGPU de propósito general (shaders, escenas 3D, cómputo GPU), con cero
   menciones a cartografía en su documentación pública. Adoptarlo no ahorra ni una línea de
   la lógica de mapa que hoy vive en `lib/globe.ts`, `lib/visible.ts` y `RouteMap.tsx` — solo
   cambiaría la superficie de dibujo, y el trabajo cartográfico (proyección, teselado,
   *picking*, corte por horizonte) habría que escribirlo entero, a mano, en WGSL.
2. **No hay problema que resolver.** El único problema de rendimiento medido en este mapa
   (`lib/visible.ts:8–29`) ya está arreglado, con una mediana de 6,1 ms de frame y sin tocar
   el renderer. No hay una queja abierta, un test que falle por lentitud, ni un caso de uso
   (más países, más rutas) que hoy se acerque a los límites que sí motivaron los otros tres
   arreglos de rendimiento documentados en el repo.
3. **El coste es real y concentrado en lo que no se ve en la demo.** Se pierde el 100 % del
   valor de tener aeropuertos, etiquetas y arcos como nodos DOM accesibles y testeables
   (`RouteMap.test.tsx`, 1.626 líneas, 120 aserciones sobre esa estructura), se introduce por
   primera vez en esta feature la necesidad de una ruta de *fallback* para el ~15 % de
   sesiones sin WebGPU habilitado por defecto (Safari/iOS anterior a la versión de SO "26",
   Firefox en Linux o Mac Intel), y se reintroduce un bucle de renderizado continuo
   (`frameLoop`) que la arquitectura actual fue escrita explícitamente para evitar en reposo.

Si en el futuro apareciera un problema de rendimiento real y medido que el culling actual no
alcance a resolver (por ejemplo, muchos miles de rutas simultáneas, algo muy por encima del
uso actual de la feature), la primera pregunta debería ser si hace falta más cirugía de CPU
en la línea de `lib/visible.ts` — el patrón que ha funcionado las cuatro veces anteriores —
antes de considerar de nuevo un cambio de tecnología de renderizado, y en ese caso evaluando
una librería que sea, de hecho, un renderer de mapas.
