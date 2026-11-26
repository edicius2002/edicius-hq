# Reparación de fuentes USD/PEN

Fecha: 2026-11-23. Rama: `fix/fx-one-minute-collection`.
Alcance: reparar Kambista, Securex y Cambio Seguro antes de desplegar la nueva cadencia.

## Causas y solución

### Kambista

La [portada pública](https://kambista.com/) ya no expone los IDs `valcompra` y
`valventa`. El nuevo HTML incluye valores iniciales de ejemplo, mientras que sus
scripts consultan una [simulación pública USD 100](https://api.kambista.com/v1/exchange/calculates?originCurrency=USD&destinationCurrency=PEN&active=S&amount=100).
Leer únicamente los nuevos IDs habría devuelto esos valores iniciales como si
fueran cotizaciones actuales.

El adaptador usa ahora ese GET, valida `tc.bid`, `tc.ask`, `rate` y `exchange`, y
registra monto USD 100 y método de simulación sin compromiso en el contexto.
No inicia operaciones, usa cupones ni vuelve al HTML si falla el JSON.

### Securex

La [portada pública](https://securex.pe/) conserva `data-rate` antiguos, distintos
de las tasas mostradas en `<strong>`. Su script público `SXApi.tipoCambio` usa
POST a `https://securex.pe/getTipoCambio` con `compra: 0`, `venta: 0` y
`Accept: application/json`. Es una consulta de tasas base sin cupón ni sesión.

Se usa ese contrato en vez de elegir uno de los dos valores HTML discrepantes.
Se exige `estado: true` y `result.compra/venta` válidos. Los otros campos de la
respuesta no se guardan. La validación real detectó que omitir `Accept` puede
devolver HTML con HTTP 200; se añadió una regresión específica y el encabezado.
No se usa el endpoint de fallback de staging que aparece en el JavaScript.

### Cambio Seguro

La [respuesta pública](https://cambioseguro.com/) anunciaba Brotli y HTTP 200,
pero `httpx` produjo `DecodingError` durante la lectura del cuerpo. Con gzip la
descarga y los selectores existentes funcionaron.

El adaptador solicita `Accept-Encoding: gzip, deflate` únicamente para esta fuente.
Se mantienen el límite de tamaño, timeout y validación completa. No se acepta HTML
parcial ni se ocultan errores de transporte.

## Cobertura

- Pruebas nuevas de endpoints, método, parámetros y encabezados exactos.
- Rechazo de JSON incompleto, tasas inválidas/invertidas/no finitas y estado falso.
- Validación de coherencia entre tasa y monto de la simulación Kambista.
- Rechazo de HTML de ejemplo cuando se espera JSON; sin fallback a tasas antiguas.
- Lectura de gzip, sin exigir soporte Brotli en el cliente.
- Fixtures reducidos, sin cookies, tokens ni campos de usuario del proveedor.
- Revisión independiente sin hallazgos pendientes.

## Evidencia y límites

Resultado: tres capturas válidas por fuente, separadas por un minuto. Kambista
devolvió compra/venta 3.437/3.463 (máximo 529 ms); Securex 3.439/3.463
(máximo 987 ms); Cambio Seguro 3.4370/3.4650 (máximo 833 ms).
No hubo errores en esas nueve capturas de los adaptadores corregidos.

Suite FX, locks y lifecycle: **140 pruebas pasaron, una omitida** por ausencia de
`systemd-analyze` en Windows. Ruff, formato Python y mypy pasaron. Las pruebas de
contratos nuevos se observaron fallar antes de reparar los adaptadores.

Pruebas realizadas desde Windows, no desde la Pi, sin navegador ni escrituras en
producción. La validación inicial de Securex falló por el encabezado `Accept`
ausente y se conservó en la evidencia; la validación posterior usa el código final.

- [Rondas Kambista/Cambio Seguro y diagnóstico inicial Securex](usd-pen-source-repair-validation-2026-11-23.json).
- [Rondas Securex después de corregir Accept](usd-pen-securex-repair-validation-2026-11-23.json).

Esta reparación no recupera automáticamente las capturas que faltan en el
histórico. Requiere desplegar el código y validar desde la Pi para que vuelvan a
llegar observaciones a producción. No se activó todavía el timer de un minuto.
