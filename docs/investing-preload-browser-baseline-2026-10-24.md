# Investing: prueba de navegador previa a desplegar la precarga

Fecha: 2026-10-24. Web de producción abierta en Chrome con sesión existente;
worker y Supabase de producción. Los cambios locales de precarga y sondeo a
750 ms **no están desplegados**. No se modificaron posiciones ni documentos.

## Método

Se seleccionó una temporalidad desde la interfaz y se observó cuándo el
gráfico anunció velas visibles. La hora del clic y del primer dibujo se
registró con el reloj del controlador del navegador; `created_at`,
`claimed_at` y `completed_at` se leyeron después desde
`collector_requests`. El controlador y Supabase usan relojes distintos y la
observación del DOM tiene resolución limitada: las diferencias de decenas de
milisegundos son indicativas, no precisión de laboratorio. Los tiempos de
clic incluyen la automatización del botón.

| Caso frío | Clic → crear | Cola | Worker | Completar → dibujo | Clic → dibujo |
| --- | ---: | ---: | ---: | ---: | ---: |
| USO `15m` | 2,353 s | 2,443 s | 1,669 s | ≈0,098 s | 6,563 s |
| USO `1M` | 3,011 s | 1,421 s | 0,986 s | ≈0,055 s | 5,473 s |
| BNO `1w` | 8,329 s | 1,065 s | 1,175 s | ≈0,008 s | 10,577 s |

En USO `1w`, el primer registro de solicitud apareció 16,669 s después de
accionar la temporalidad. No se obtuvo una marca suficientemente precisa para
su primer dibujo. En USO `1h` apareció una serie antes de que la solicitud
nueva terminara; por eso se separaron primeras velas y datos actualizados en
las pruebas posteriores.

Al volver a una serie ya cargada, USO `1h` mostró velas dentro de 0,447 s de
la acción observada y USO `1w` dentro de 0,551 s. Estas son revisitas de la
misma sesión, no una prueba de la precarga aún no desplegada.

## Verificación del código local

- `useCandles.test.tsx` y `supabaseMarket.test.ts`: 59 tests pasaron.
- Toda `src/features/investing`: 466 tests en 34 archivos pasaron.
- `npm run typecheck --workspace apps/web`: pasó.

Los tests locales prueban que la temporalidad visible va primero, las otras
seis se consultan secuencialmente en segundo plano, las consultas se reutilizan
al seleccionarlas, se cancela trabajo obsoleto y se reconcilia cada 750 ms al
inicio. No prueban la latencia de extremo a extremo en producción.

## Lectura de los resultados

En los tres casos fríos con marcas completas, el resultado de Supabase
se dibujó casi de inmediato. El rastro antiguo de 1,79 s entre
`completed_at` y dibujo no se reprodujo aquí. La espera antes de crear la
solicitud fue considerable, especialmente en BNO `1w`; incluye el clic
automatizado, `getSession`, una posible lectura de IndexedDB y la lectura
inicial de `market_bars`. No hay marcas internas para atribuirla a una de esas
operaciones. Tampoco hay un archivo de autenticación de desarrollo en esta
máquina para abrir la versión local en un navegador con sesión. Por eso la
prueba antes/después de la nueva precarga requiere un despliegue aislado o
habilitar el acceso local de desarrollo.

La próxima instrumentación útil es: inicio de acción, fin del clic, fin de
`getSession`, fin de IndexedDB, fin del primer SELECT a `market_bars`, inserción
de solicitud, recepción del resultado y primer dibujo. Solo tras esa medición
se puede atribuir la espera previa a `created_at` y cuantificar el efecto real
del nuevo sondeo.
