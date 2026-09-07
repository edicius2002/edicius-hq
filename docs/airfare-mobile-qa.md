# Verificación de Airfare móvil — 7 de septiembre de 2026

Implementación basada en `1b950ef56766abf1e2d3ddf3ee366910b69adda7`, rama
`edicius2002/airfare-mobile-comprehensive`. Sólo Airfare y reglas de viewport
`max-width: 640px`; no se modificaron el shell, otras pestañas, backend o contratos.

## Antecedentes revisados

- #172: conservar la adaptación móvil, ausencia de overflow, detalle de dos
  columnas y tabla con scroll propio. La geometría compacta del band chart sigue
  siendo necesaria cuando aumenta el ancho del panel.
- #176: conservar botones, pinch, pan, reset y continuidad al levantar un dedo en
  DepartureChart.
- #177: conservar rotación, pinch, controles y la ruta de zoom existente del mapa.
- #179: conservar los gutters del shell en todas las páginas. Airfare recupera
  espacio mediante sus propios márgenes y clases de panel.

## Método y evidencia

Se leyó la guía `orca skills get orca-cli`. Vite se ejecutó desde una terminal Orca
propia en el puerto 5175. El navegador integrado permitió navegar, evaluar el DOM,
medir iframes de 360×800, 390×844, 430×932 y 1440×1000, y comprobar el zoom mediante
sus controles. No se transfirió el encargo ni se lanzaron otros agentes.

La sesión local requiere passkey. Para inspeccionar todos los paneles se montaron
los mismos componentes y el mismo shell en un harness local con copias de lectura
de **7 rutas y 15 archivos** ya existentes. Las respuestas se exportaron mediante
las funciones de lectura del repositorio, sin inventar tarifas ni escribir sobre
la watchlist. El harness rechaza las mutaciones y no se incluye en el producto.
El indicador API offline corresponde a ese entorno de QA.

La emulación directa `set viewport` del helper de Orca falló. Sus capturas también
terminaron en `Page.captureScreenshot: Screenshot timed out`, indicando que la
pestaña podía no estar visible. Las capturas completas y la emulación táctil se
completaron adicionalmente con Chromium/Playwright, DPR 1, `isMobile`, `hasTouch` y
`reducedMotion: reduce`, lanzado con `--disable-gpu` y
`--disable-accelerated-2d-canvas`. No se habilitó aceleración por hardware ni se
reinició Orca. Los números de las tablas siguientes proceden de ese entorno
repetible; Orca confirmó el mismo reparto con pequeños redondeos de su escala.

## Ancho medido

Píxeles CSS, datos idénticos antes y después. Canvas excluye los bordes del stage;
DepartureChart incluye su espacio funcional para ejes y etiquetas.

| Viewport | Canvas antes → después | DepartureChart antes → después | Ancho útil final del chart | Overflow de página |
| -------- | ---------------------- | ------------------------------ | -------------------------- | ------------------ |
| 360×800  | 286 → 348              | 288 → 350                      | 97,2 %                     | 0 px               |
| 390×844  | 316 → 378              | 318 → 380                      | 97,4 %                     | 0 px               |
| 430×932  | 356 → 418              | 358 → 420                      | 97,7 %                     | 0 px               |

Antes: gutter del shell de 15 px + padding de panel de 20 px + bordes.
Después: gutter exterior de 4 px, aumentado por `safe-area-inset-left/right` cuando
corresponde, y sin padding lateral en paneles de visualización. El texto y los
controles mantienen 10 px internos. No se recortó el margen funcional del dibujo.

PriceBandChart conserva el viewBox compacto de **505×284** en todo el rango móvil,
incluido el teléfono de 430 px que ahora entrega más de 400 px al componente. Su
SVG ocupa los mismos 350/380/420 px. La fórmula de radio del globe, `0.42 × lado`,
permanece intacta: el stage cuadrado permite que el disco también crezca.

## Altura y densidad

La página **no es más corta**: ahora dedica espacio a controles utilizables y
lecturas completas. Se reducen los espacios externos y se evita que una reserva
insuficiente comprima el dibujo o empuje contenido fuera de su panel.

| Medida                            | Antes           | Después: 360 / 390 / 430 |
| --------------------------------- | --------------- | ------------------------ |
| Altura del canvas                 | 258             | 348 / 378 / 418          |
| Altura dibujada de DepartureChart | 117 / 129 / 145 | 142 / 154 / 170          |
| Panel de mapa                     | 402             | 436 / 466 / 506          |
| Panel de detalle                  | 304             | 298 / 298 / 298          |
| Panel de análisis                 | 286             | 512 / 529 / 552          |
| Página completa                   | 2467            | 2873 / 2937 / 3035       |
| Separación entre paneles          | 30              | 12                       |
| Padding vertical de panel         | 20 por lado     | 12 por lado              |

El botón Day medía aproximadamente **18×13 px con texto de 7 px**. Los botones de
Airfare ahora miden al menos 44 px de alto; los controles de zoom también tienen
44 px de ancho. Inputs/selects usan 16 px para evitar el autozoom de formularios.
El enlace del crosshair tiene 44 px de alto; los enlaces de la tabla amplían su
hit area a 24 px utilizando el padding existente de las celdas.

Se reserva una segunda fila para los periodos y una fila para los controles del
chart. Al alternar Day/Week/Month o los dos gráficos, el panel conserva su altura
(diferencia menor de 1 px en los tres viewports). Esto deja espacio vacío cuando
PriceBandChart no necesita los controles de DepartureChart: es el coste explícito
de conservar la posición del contenido y evitar saltos.

## Cambios por componente

- **AirfarePage:** clases locales de panel, gutter seguro mínimo, separación de
  12 px y padding lateral cero para mapa/análisis. Sin cambios en Panel compartido.
- **RouteMap:** stage cuadrado, toolbar más compacta, reserva de SaveStatus
  ajustada sólo dentro de Airfare y targets de 44 px. Se conservan drag, pinch,
  teclado, botones, proyección y reduced-motion.
- **AnalysisPanel / PeriodSwitch:** nombres legibles, periodos en su propia fila,
  geometría estable entre vistas, altura suficiente para SVG y readouts.
- **DepartureChart:** controles táctiles completos y readout separado de los
  ejes. Un toque breve en móvil fija la lectura; el botón de pin la libera.
  Drag, pinch, cancelación y desktop no activan ese comportamiento.
- **PriceBandChart:** geometría compacta en todo móvil, texto de ejes adaptado y
  readout en flujo con reserva. Un toque conserva el crosshair. El gráfico permite
  scroll vertical y zoom de página (`pan-y pinch-zoom`); no tiene zoom propio que
  requiera apropiarse de esos gestos.
- **RouteDetail:** mantiene dos columnas, mejora legibilidad y reduce la reserva
  superior que provenía de desktop.
- **RouteList:** filas con ruta/meses/acciones; los meses se distribuyen según el
  espacio. Scroll interno limitado a 40svh, sin perder navegación ni reordenación.
- **RouteEditor / AirportField:** dos aeropuertos con etiquetas encima, inputs de
  44 px y año con wrapping. Seis meses por fila caben con targets de 44 px; las
  sugerencias conservan su anclaje al grupo de aeropuertos. AirportField no
  requirió cambios en su implementación.
- **FlightTable:** filtros en dos columnas, filas y ordenación más compactas y
  scroller local. Ancho total medido final: **548 px**, dentro de un contenedor de
  330/360/400 px. Todas las columnas, filtros, enlaces y paginación se conservan.
- **RouteTransfer:** botones Import/Export con target táctil suficiente.
- **PriceHistoryChart:** inspeccionado; no se monta en Airfare actualmente, sólo
  aparece en sus tests. No se añadió al producto ni se alteró código sin uso.

## Pruebas y regresiones

TDD: doce invariantes CSS fallaron antes de la implementación. El caso del ancho
compacto y los dos casos de tap/crosshair también se verificaron en rojo antes de
corregirlos. Se añadieron además controles negativos de drag, pinch, cancelación,
desktop y una invariante del scroll del band chart: **20 casos nuevos** en total.
La allowlist CSS de Vitest se amplió para que las pruebas lean estilos reales.

- Formato: `npm run format:check`, correcto.
- Lint: `npm run lint`, 0 errores; 5 warnings preexistentes de Fast Refresh en
  `apps/web/src/app/router/routes.tsx`.
- Tipos: `npm run typecheck`, correcto.
- Web: `npm run test -w web`, **2221 passed, 2 skipped**; 146 archivos passed y 1
  skipped. Los saltos pertenecen a la suite existente.
- Producción: `npm run build`, correcto.
- Browser: taps, zoom/reset, pinch sintético de dos dedos, crosshair, targets,
  periodos, cambio de chart, Mercator/Globe, scroll de tabla y zoom de página al
  200 %, correctos en los tres viewports.
- Desktop 1440×1000: paneles y geometría conservan exactamente sus dimensiones
  anteriores; página de 2586 px. La comparación de las once hojas de estilo,
  excluyendo comentarios y bloques `max-width: 640px`, confirmó que no cambia
  ninguna declaración de desktop. El globe contiene dibujo dinámico; no se afirma
  identidad de cada píxel entre capturas tomadas en instantes distintos.

## Archivos de evidencia locales

Directorio relativo a la raíz del worktree: `.local-data/airfare-qa/`.
Está ignorado por Git y conserva los datos de QA localmente.

- `before-{360,390,430,1440}-full.png` y `after-{360,390,430,1440}-full.png`.
- `before-{360,390,430,1440}-history.png` y `after-{360,390,430,1440}-history.png`.
- `interaction-{360,390,430}-departure.png` y
  `interaction-{360,390,430}-history.png` muestran lecturas táctiles.
- `before-metrics.json`, `after-metrics.json`, `interaction-results.json`.
- `orca-after-{360,390,430,1440}.json`: mediciones finales del navegador integrado.
- `capture.mjs`, `interactions.mjs`, `host.html`, `page.html`, `page.tsx`: harness
  local reproducible mientras la app de desarrollo esté en el puerto 5175.

Quedan por validar en hardware físico iOS/Android el tacto y la inercia percibida;
la validación aquí fue en motores de navegador y eventos táctiles emulados. La
tabla mantiene scroll horizontal deliberado dentro de su contenedor. La sesión
privada y las operaciones reales de guardado/colección no se ejercitaron; sus
contratos y backend no cambian.
