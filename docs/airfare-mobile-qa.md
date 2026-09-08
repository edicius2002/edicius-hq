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

## Corrección de densidad tras revisión — 2026-09-07

Esta revisión sustituye los controles de 44 px descritos arriba por controles
compactos de 32 px, siguiendo la petición posterior del usuario. Todos los cambios
están dentro de `max-width: 640px` en CSS de Airfare.

- Globe/Mercator: padding del toggle de 3 a 1 px; 2 px de padding vertical en la
  fila con Saved/Reset. El panel pierde 12 px sin reducir el canvas.
- Watched routes: campos, meses, tiles, acciones y transferencia de 32 px;
  menos separación vertical. Origin y Destination quedan junto a sus campos.
- AnalysisPanel/PeriodSwitch: toggles de 32 px y texto de 12 px; los nombres largos
  caben en dos líneas. Metadata de 66 a 54 px. Cuerpo de `56.24cqw + 84px` a
  `56.24cqw + 60px`, conservando la altura entre ambos gráficos.
- DepartureChart/PriceBandChart: gaps de 10 a 4 px; lectura de departure de 60 a
  42 px y de history de 60 a 56 px. Una reserva menor en history encogía el SVG
  con lecturas de tres líneas; el valor final conserva todo el ancho con crosshair.
- FlightTable: labels junto a campos, ambos a 12 px; altura de 44 a 32 px y menos
  ancho ocupado por controles. Dos columnas de filtros y scroll local de tabla.
- RouteDetail: labels al lado de valores. Los importes mantienen su ancho;
  la aerolínea y el rango usan filas completas para admitir valores largos.

Alturas en px, antes de esta corrección → resultado final:

| Ancho | Página      | Watched routes | Flight details | Análisis      | Tabla         |
| ----- | ----------- | -------------- | -------------- | ------------- | ------------- |
| 360   | 2873 → 2488 | 693.0 → 588.0  | 298.1 → 226.5  | 512.2 → 446.4 | 758.6 → 627.6 |
| 390   | 2937 → 2517 | 710.6 → 585.0  | 298.1 → 212.5  | 529.1 → 463.3 | 758.6 → 627.6 |
| 430   | 3035 → 2580 | 745.8 → 585.0  | 298.1 → 212.5  | 551.6 → 485.8 | 758.6 → 627.6 |
| 1440  | 2586 → 2586 | 803.4 → 803.4  | 117.7 → 117.7  | 699.6 → 699.6 | 742.4 → 742.4 |

Anchos conservados: globe 348/378/418 px; gráficos 350/380/420 px. Overflow global:
0 px. Desktop 1440×1000 conserva las dimensiones y declaraciones anteriores.
Los móviles exactos se verificaron con Chromium sin GPU; Orca verificó además
iframes 360×800, 390×844 y 430×932, con ancho útil 345/375/415 px por su scrollbar
nativo, también sin overflow. La aceleración hardware permanece deshabilitada.

TDD: expectativas responsive fallidas antes de implementar, luego correctas;
16 contratos CSS (tres nuevos). Suite web: 2224 passed, 2 skipped. Format, lint,
typecheck y build correctos, con cinco warnings preexistentes de Fast Refresh.
Browser: periodos/chart sin salto, tap/crosshair, pinch, zoom/reset, targets de
32 px, dt/dd en línea y ancho efectivo del dibujo con crosshair activo.

Evidencia en `.local-data/airfare-qa/`: `compact-before-*`, `compact-after-*`
(full/history, cuatro viewports), `compact-interaction-*` (tres móviles),
`compact-before-metrics.json`, `compact-after-metrics.json`,
`compact-interaction-results.json`, `orca-compact.json` y logs `compact-*.log`.

La reserva restante bajo el eje sostiene lecturas táctiles y avisos de colección,
y evita saltos entre gráficos. Los campos usan 12 px por petición del usuario;
falta comprobar enfoque y zoom automático en iOS físico. El zoom manual sigue
habilitado. Las demás limitaciones de la revisión anterior siguen aplicando.

## Auditoría de alternativas Lima–Madrid y Madrid–Lima

La primera auditoría de líneas sólo cubría las cuatro conexiones principales.
Al revisar escalas se detectó una omisión del harness local: el export incluía
coordenadas de aeropuertos principales, pero no pedía las de `viaPoints`.
Se corrigió el export local y se incorporaron 24 aeropuertos usando el mismo
catálogo IATA del backend; ninguna coordenada quedó sin resolver. No fue
necesario modificar el código de producción ni sus contratos.

Se compararon las secuencias únicas de escalas de cada mes del archivo con todos
los segmentos SVG dibujados, en ambos sentidos y ambas proyecciones:

| Sentido                          | Mayo 2027 | Junio 2027 | Julio 2027 |
| -------------------------------- | --------- | ---------- | ---------- |
| LIM → MAD, alternativas / tramos | 12 / 30   | 10 / 24    | 12 / 29    |
| MAD → LIM, alternativas / tramos | 15 / 40   | 15 / 38    | 14 / 36    |

Los 36 casos (seis selecciones × dos proyecciones × tres anchos: 360, 390 y
430 px) dibujaron exactamente el número esperado de segmentos, todos con
geometría válida y longitud positiva. Las alternativas corresponden al mes y
sentido seleccionados, no a ambos sentidos simultáneamente. Los tramos
compartidos pueden superponerse y las escalas próximas se agrupan visualmente
al alejar el mapa; no equivalen a itinerarios omitidos. La ocultación del lado
posterior del globe sigue siendo intencional.

Evidencia local: `alternates-expected.json`, `alternates-results.json`,
`alternates-audit.mjs` y doce capturas `alternates-{sentido}-{mes}-{proyección}.png`
en `.local-data/airfare-qa/`. La vista del puerto 5175 fue recargada con las
coordenadas completas. La auditoría previa de RouteMap, geo y arcFlow pasó
111 pruebas. Esta corrección afecta únicamente al harness local de revisión.

## Divisiones territoriales y zoom móvil

Se retiraron los botones +/− del mapa únicamente en viewports de hasta 640 px.
Reset, pinch, drag y zoom por teclado/rueda siguen disponibles; desktop conserva
los dos botones y su texto accesible. La instrucción accesible móvil ya no promete
botones que no están presentes.

La auditoría detectó dos problemas distintos:

- El harness local devolvía 404 para geografía. Ahora sirve el catálogo y las
  respuestas originales desde `services/api/app/data/subdivisions`, sin cambiar
  backend ni inventar geometría. Se validaron 167 archivos TopoJSON y 4085 nombres
  con coordenadas finitas.
- En producción, un pinch rápido móvil podía terminar al 1.285× cuando los dedos
  habían solicitado 2×: el primer dedo levantado convertía el pinch en rotate/pan,
  y el último levantado ya no cerraba el zoom pendiente. Globe interpretaba ese
  zoom como activo y mantenía el terreno simplificado, sin bordes internos.
  Ahora el último dedo cierra el zoom también tras esa transición. El repintado
  final móvil utiliza la geometría más reciente y libera la espera al completar
  el temporizador, evitando un último fotograma simplificado sin otro pendiente.

TDD: dos casos reprodujeron el zoom incompleto en Globe y Mercator antes del
arreglo y pasaron después. Un tercer caso verifica ausencia de +/− en mobile,
presencia de Reset e instrucciones accesibles correctas.

Browser: Perú y España, ambas proyecciones, a 360×800, 390×844 y 430×932.
Todas las solicitudes geográficas observadas respondieron 200. Cada país y el
catálogo se descargaron una sola vez por sesión, incluso al volver a la zona.
Además de comprobar labels, se instrumentó el stroke de canvas para verificar
que los bordes internos regresan al terminar el gesto; las doce combinaciones
pasaron y sus capturas muestran el detalle. En 1440×1000 siguen los botones.
La aceleración hardware permaneció deshabilitada.

Evidencia local: `territories-*.png` conserva el estado anterior;
`territories-after-*.png` contiene el resultado final para Perú y España;
`territories-after-results.json` y `territories-after-spain-results.json`
registran países, respuestas, caché y restauración de bordes.

Validación final: 2227 tests web passed, 2 skipped; formato, lint, typecheck y
build correctos. Lint mantiene cinco warnings preexistentes de Fast Refresh.

### Selección táctil sin rectángulo nativo

El área SVG de la ruta heredaba `-webkit-tap-highlight-color:
rgba(51, 181, 229, 0.4)`. Al tocar, el mapa recibía foco pero no
`:focus-visible`; por tanto no era el outline de teclado. Se desactiva el
resaltado nativo únicamente en el stage móvil (<=640px), manteniendo los
strokes de selección y el área táctil de 16px. No se modifica el outline.

TDD: el nuevo contrato CSS falló antes y pasa con la regla. Browser en
360×800, 390×844 y 430×932 verifica color transparente heredado por las
rutas, selección LIM→MAD y sus 30 segmentos alternativos. El foco visible
por teclado permanece. En 1440×1000 se conserva el color nativo anterior.
Capturas locales: `selection-before-{pressed,selected}.png` y
`selection-after-{360,390,430,1440}-{pressed,selected}.png` dentro de
`.local-data/airfare-qa/`. Chromium ejecutado sin aceleración hardware.
La captura headless no reprodujo el flash nativo; su eliminación se verifica
por el estilo computado, además de la selección y las capturas posteriores.

Validación: 2228 tests web correctos y 2 omitidos; format, lint, typecheck y build correctos. Lint conserva los cinco warnings preexistentes.
