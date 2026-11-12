# Ensayo de migración a Neon — 2026-11-11

**Estado:** historial Airfare cargado y verificado en Neon `production`; la web general ya se desplegó con Neon por defecto. La Pi aún no ha cambiado de backend y no se borraron datos de origen.

## Respaldos locales

Se exportó el esquema `public`, los datos `public` y los datos `auth` de Supabase a `.local-data/neon-migration/`, carpeta ignorada por Git. Los archivos contienen datos privados y tokens de sesión; no deben publicarse. El volcado de `public` mide 910.086.770 bytes y tiene SHA-256 `6149d94935b8b06d3fab0c97c0bb4ec679bc271310e249f3d107899b89a204a3`. El de `auth` mide 353.612 bytes y tiene SHA-256 `f8e5f0df0d1dcbd9dfc0d205c96198f0ee7e611dd1074ad0ba0b499b5b3887b3`.

El respaldo de identidad incluye una cuenta y dos credenciales WebAuthn. La RP ID configurada en el proyecto es `edicius-hq-web.vercel.app`, igual al host de la aplicación. Se importaron la cuenta y ambas credenciales a `app_auth` primero en la rama temporal y después en Neon `production`. El UUID coincide con `edicius_owners`; la lectura posterior a cada escritura confirmó los identificadores, las claves públicas y los contadores originales. Better Auth respondió correctamente a JWKS y opciones WebAuthn en Vercel. El dueño confirmó un inicio de sesión real con una llave existente en el origen HTTPS de producción **en ambas ramas**; la pantalla de prueba verificó el JWT emitido con su UUID y `role: authenticated`. La función de Auth publicada ya usa Neon `production` y no depende de la rama temporal que vence el 18 de noviembre.

## Volumen de origen

| Tabla                  |   Filas | Bytes en el volcado |
| ---------------------- | ------: | ------------------: |
| `fare_snapshots`       | 106.159 |         345.630.817 |
| `collector_requests`   |   1.821 |         214.938.532 |
| `airfare_import_runs`  |   4.925 |         123.935.990 |
| `fare_baseline_points` | 158.528 |          44.344.539 |
| `fare_checks`          | 153.690 |          43.425.776 |
| `sentiment_snapshots`  |     167 |          40.269.531 |
| `market_bars`          |     229 |          32.008.846 |

Estas cifras son bytes de texto del volcado `COPY`, no tamaño físico de Postgres. La concentración de bytes en `collector_requests` y `airfare_import_runs` confirma que la retención operacional y evitar duplicar barras importan para la cuota.

## Rama de prueba

Se creó `migration-trial-20261111` desde `production`, con expiración el 2026-11-18. Su conexión directa quedó en un archivo ignorado. [El importador](../scripts/neon-migration-trial.py) cargó 21 tablas seleccionadas dentro de una transacción; verificó sus conteos y las claves primarias. Una segunda conexión de solo lectura confirmó 21 tablas y 81.387.520 bytes de base, incluidos 7 documentos de app, 2 de finanzas, 9.948 registros SEACE, 76.513 observaciones FX y 35.176 proyecciones de vuelos. No hay proyecciones de vuelos sin su proyección mensual.

La primera importación seleccionada excluyó las filas de `fare_snapshots`, `fare_baseline_points`, `fare_checks`, `airfare_import_runs`, `collector_requests` y `collector_runs`. En ese momento Neon `production` tenía 21 tablas seleccionadas, 81.747.968 bytes de base, una cuenta y dos llaves. El historial Airfare se incorporó después; los datos operativos antiguos permanecen excluidos.

Se creó `migration-jwks-trial-20261111` desde Neon `production`, con vencimiento el 18 de noviembre. Su Data API usa el JWKS vigente; las 21 tablas originales tienen RLS. Sin token o con token inválido, la lectura de documentos devuelve 401; el JWT del dueño ve una fila, otro UUID no ve ninguna, y un token sin `role` recibe 403. Se aplicó [la migración de compatibilidad](../neon/migrations/20261111_public_compat.sql) en el clon: seis tablas operativas/históricas inicialmente vacías, 41 funciones, 18 índices, 13 relaciones y 8 triggers. Las seis tablas nuevas también tienen RLS y no reciben grants directos. `supabase-js` leyó la Data API; los RPC de FX, proyección mensual y paginación de vuelos Airfare, y página SEACE respondieron 200. Una escritura de documento de otro UUID recibió 403; el dueño pudo crear y borrar un documento, y el conteo volvió a siete.

Tras la autorización expresa del dueño, se activó la Data API en `production` y se aplicaron inmediatamente las migraciones de RLS, permisos y RPC ya probadas en el clon. Neon crea el rol `authenticated` y `auth.user_id()` al activar la API, por lo que la migración de seguridad anterior a la activación no podía completarse; el primer intento se revirtió en su transacción. Una conexión nueva confirmó 27 tablas públicas con RLS, 13 políticas iniciales, lectura de documentos permitida al rol autenticado, lectura directa de historial Airfare denegada y ninguna ejecución pública del RPC comprobado. La API respondió 401 tanto sin token como con token inválido. Se añadieron después dos políticas para `collector_requests`: un JWT propio leyó e insertó en el clon (200/201) y otro UUID recibió 403 al intentar insertar para el dueño. La solicitud de prueba se eliminó. Las mismas dos políticas quedaron aplicadas en `production`, sumando 15. La llave real y la Data API ya superaron una prueba publicada; falta desplegar el cliente general y los colectores.

## Criterios de corte y pendientes

1. Supabase Auth responde HTTP 402, incluso en su JWKS público. No sirve mantenerlo como proveedor activo para restaurar acceso.
2. El dueño requiere conservar llave de paso. Better Auth propio con [passkeys](https://better-auth.com/docs/plugins/passkey) y [JWT/JWKS](https://better-auth.com/docs/plugins/jwt) preservó el UUID y superó dos pruebas de inicio de sesión real, una de ellas en Neon `production`. La web general ya usa esa sesión tras el despliegue de corte.
3. La [Data API de Neon](https://neon.com/docs/data-api/custom-authentication-providers) con `sub`, `role: authenticated`, privilegios SQL y RLS pasó las pruebas en el clon y está activa y protegida en `production`. Un JWT real de Better Auth leyó un documento; falta verificar los flujos completos de la web recién desplegada y su API privada.
4. El archivo JSONL Airfare de la Pi es la fuente autoritativa. Su copia actual ya se verificó por archivo y contra el volcado de Supabase. El historial se cargó y verificó también en `production`; falta establecer la sincronización continua desde la Pi antes del corte.

Un JWT firmado por Better Auth contra `production` leyó un documento (200, una fila); otro UUID vio cero y un token sin `role` recibió 403. La página de prueba publicada pidió una llave real y leyó ese documento por la Data API. Se publicó primero una versión opt-in de la app en la ruta normal con `?__neonTrial=1`; las comprobaciones HTTP dieron 200 y los bundles públicos no contenían cadenas de conexión Postgres. El dueño confirmó que la página opt-in cargaba y autorizó después el corte general.

En Vercel Production se configuró `VITE_DATA_BACKEND=neon` y se desplegó el commit `69e84ff` desde un archivo limpio de Git. Vercel marcó el despliegue `READY` y lo enlazó a `edicius-hq-web.vercel.app`; la página y `/api/auth/jwks` respondieron HTTP 200. La CLI no pudo empaquetar el worktree directamente porque carecía de permiso para recorrer `.pytest_cache`, por lo que se usó una copia temporal con solo archivos versionados y el vínculo del proyecto. La API privada configurada por `VITE_API_URL` no pudo conectarse desde este entorno; puede requerir la red Tailscale del propietario y aún se debe verificar con el nuevo JWT. No se imprimieron ni subieron archivos de entorno o respaldos.

El nuevo límite de los colectores por Postgres directo quedó preparado en código. En el clon se comprobaron lectura de dos documentos, 229 metadatos de barras, inicio/heartbeat/finalización de una ejecución, upsert y fusión de una cotización sintética, y el ciclo de una solicitud Airfare sintética desde cola hasta `complete`. Las filas sintéticas se eliminaron. Pasaron 60 pruebas existentes de colectores y el chequeo de tipos del módulo nuevo. La Pi sigue ejecutando la versión anterior; su archivo Airfare ya se copió y verificó sin modificar el original.

## Comprobación de la Pi

El dueño confirmó el 12 de noviembre que la prueba de llave de paso publicada funciona y pidió activar el corte general en desktop y móvil. La comprobación directa de esos dispositivos y de la API privada tras el despliegue general aún está pendiente.

Un primer intento SSH confirmó que `edicius` no podía recorrer/leer `fares`, que `setfacl` no estaba instalado y que `sudo -n` no estaba disponible. La Pi usa Debian 13. El operador concedió acceso de solo lectura temporal desde su propia terminal; la contraseña de sudo no se compartió con el agente.

El operador instaló `acl` y concedió acceso temporal. La lectura posterior confirmó 375 archivos regulares, 424.009.276 bytes contabilizados por `du`, ningún enlace simbólico y ningún archivo ilegible. Se guardó una copia tar de 424.325.120 bytes en `.local-data/neon-migration/`, ignorada por Git; **las huellas SHA-256 de cada uno de los 375 archivos coincidieron con las calculadas en la Pi**. No se imprimieron contenidos ni nombres privados. Se indicó al operador cómo retirar las ACL temporales. El archivo original de la Pi no se modificó.

El escáner de la aplicación validó la copia sin filas inválidas en snapshots ni baseline. Encontró 106.159 snapshots, 158.528 puntos baseline, 618 capturas de calendario, 152.996 checks de tablero únicos y 694 checks de calendario. Los identificadores y digests de los cuatro conjuntos históricos (`snapshots`, `baseline`, `board_checks`, `calendar_checks`) **coinciden exactamente** con el volcado local de Supabase. El archivo de la Pi es una fuente verificada para reconstruir esas tablas; los grupos históricos ya se verificaron en ambas ramas de Neon.

Se preparó un adaptador de sincronización Airfare por Postgres directo, seleccionado solo con `AIRFARE_SYNC_BACKEND=neon` y `AIRFARE_SYNC_ENABLED=true`. El valor predeterminado sigue siendo Supabase. En el clon de Neon, sus lecturas de manifiesto, rutas sucias y aeropuertos respondieron; insertó y borró un aeropuerto sintético, y la limpieza se verificó. Antes de activar la Pi se corrigió el adaptador para reutilizar una conexión Postgres en todos los lotes de una ejecución y evitar actualizar filas idénticas: cuatro pruebas del módulo pasaron, un upsert sintético repetido funcionó en el clon y una prueba de lectura en `production` confirmó la reutilización, 137 grupos y ninguna ruta sucia. La sincronización de la Pi continúa desactivada.

El módulo del adaptador pasó mypy, 58 pruebas enfocadas de configuración y Airfare pasaron, y `install.sh`/`verify.sh` pasaron `bash -n` en la Pi. El instalador y verificador aceptan la variable opcional `AIRFARE_SYNC_BACKEND` y exigen `DATABASE_URL` si se selecciona Neon.

Se corrigió la validación de entorno del instalador y verificador: en un despliegue totalmente Neon ya no exigen `SUPABASE_URL` ni `SUPABASE_SECRET_KEY`; las exigen si algún colector o sincronización Airfare sigue en Supabase. Ambos scripts pasaron `bash -n` local y por SSH. La suite de Pi terminó con 116 pruebas aprobadas y tres omitidas usando un directorio temporal del workspace. El host `bodas` todavía ejecuta el release anterior; sus siete timers consultados estaban activos y `collectors.env` solo es legible por root. No se modificaron los servicios ni ese archivo.

Se preparó [un script de corte de Pi](../ops/pi/activate-neon.sh) que conserva el entorno anterior en una copia root de modo 0600, cambia solo las variables de Neon, instala un release fijado por SHA y ejecuta la sincronización Airfare. El operador debe ejecutarlo con `sudo` en su propia terminal: `sudo -n` por SSH no está disponible y no se solicita ni transmite su contraseña. El script pasó `bash -n` en la Pi y las dos pruebas de reescritura del entorno pasaron; la suite completa de Pi quedó con 118 aprobadas y tres omitidas. Todavía no se ejecutó el corte.

La API privada de FastAPI ahora admite una configuración explícita `API_AUTH_BACKEND=neon` para verificar JWT ES256 de Better Auth contra el JWKS del dominio de producción. Valida emisor, audiencia, rol y UUID; el modo predeterminado sigue confiando solo en el emisor de Supabase. Pasaron 38 pruebas de JWT y del control de acceso de la API. No se activó este modo en ningún proceso desplegado.

Los comandos de verificación de la Pi ya tienen ruta Neon: `smoke-collector.py` consulta filas y crea las dos solicitudes de prueba directamente en Postgres cuando `COLLECTOR_DATA_BACKEND=neon`; `check-collector-run.py` comprueba el estado reciente en esa misma base; y `prune-operational-history.py` usa el RPC de retención de Neon, en modo de solo lectura por defecto. Se añadieron pruebas para escoger la ruta Neon sin abrir el cliente de Supabase. Pasaron 36 pruebas enfocadas de Pi, colector y retención. **Esto prepara la instalación, pero no significa que la Pi ya haya sido desplegada ni que sus temporizadores apunten a Neon.**

Los workers de mercado y de solicitudes Airfare ya omiten la conexión Realtime de Supabase cuando el colector usa Neon; sus bucles existentes siguen sondeando la cola. Pasaron 25 pruebas de ambos comandos, incluidas comprobaciones de que el modo Neon no inicia esa conexión.

La primera importación de `fare_snapshots`, `fare_baseline_points` y `fare_checks` al clon fue rechazada por la revisión automática porque el respaldo contiene datos privados y la autorización general no cubría esa transferencia concreta. Tras la autorización específica del dueño el 12 de noviembre, se importaron las tres tablas en una transacción: 106.159 snapshots, 158.528 puntos baseline y 153.690 checks. Una conexión nueva confirmó esos conteos, RLS activo y ausencia de `SELECT` directo para `authenticated`. El clon quedó en 484.188.160 bytes. El manifiesto de Neon coincide por conteo y digest en sus **137 grupos** con la copia de la Pi, incluidas 618 capturas de calendario que ya estaban en la selección inicial. Se recalcularon 28 rutas sucias, 101 proyecciones mensuales quedaron presentes y ninguna ruta quedó pendiente. Una consulta real de metadatos y página de snapshots devolvió 15 registros en el filtro de prueba y una página de tres elementos con la misma revisión.

Con autorización expresa para el corte completo, la misma importación se confirmó en Neon `production`. Una conexión nueva verificó los tres conteos, RLS activo y `SELECT` directo denegado a `authenticated`; los 137 grupos coincidieron por conteo y digest con la copia verificada de la Pi. La lectura de metadatos y una página de tres snapshots funcionó con revisión consistente. Se recalcularon las 28 rutas marcadas y quedaron 0 pendientes, con 101 proyecciones mensuales. No se importaron filas operativas antiguas ni se borró el archivo de la Pi.

## Verificación del código preparado

El 12 de noviembre la suite web completa terminó con 204 archivos aprobados y uno omitido; 2.768 pruebas aprobadas y dos omitidas. La nueva prueba de sesión verifica que la app recibe el estado inicial incluso si la señal de Better Auth no se emite inmediatamente. Esa corrección se publicó en la versión opt-in de Vercel y `/?__neonTrial=1` respondió HTTP 200. La comprobación interactiva de la app todavía depende de una llave de paso real.

El 11 de noviembre pasaron la comprobación de tipos de la app y de la configuración de Vite, cuatro pruebas del importador de llaves y `git diff --check`. La migración SQL de compatibilidad se regeneró desde el esquema público exportado y coincidió byte a byte con el archivo revisado. El análisis de patrones de secretos en los archivos modificados solo encontró una clave de ejemplo en `.env.example`; los archivos de conexión y los respaldos siguen ignorados por Git.
