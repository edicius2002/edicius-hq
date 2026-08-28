# X scraper (Playwright)

Captura los posts y respuestas escritos por una cuenta desde la respuesta GraphQL
que la pestaña **Posts & replies** carga. No analiza el DOM ni implementa los
headers internos de X.

## Instalación

Usa Python 3 y Playwright del proyecto:

```bash
python3 -m pip install -r services/api/requirements.txt
python3 -m playwright install chromium
```

El perfil y los resultados viven fuera del repositorio por defecto:

```bash
export X_SCRAPER_PROFILE="$HOME/.local/share/x-scraper/profile"
export X_SCRAPER_OUTPUT="$HOME/.local/share/x-scraper/output"
```

No pongas el perfil en el repositorio: contiene cookies de sesión. Si necesitas
cambiar rutas, usa esas variables; nunca pases ni guardes usuario, contraseña o 2FA.

## Login único, manual

Con WSLg/`DISPLAY` disponible:

```bash
python3 tools/x-scraper/login.py
```

Inicia sesión exclusivamente en la ventana de Chromium y ciérrala al terminar.
El script no solicita ni lee credenciales de la terminal.

## Scrape y reanudación

```bash
python3 tools/x-scraper/scrape.py thsottiaux
```

Cada línea del JSONL contiene `id`, fecha, texto, relación de reply y URL. El
script carga los IDs ya escritos y sólo añade nuevos. Si no recibe tweets,
termina con código 3 para evitar resultados silenciosamente vacíos. Si falta o
expiró la sesión, termina con código 2 e indica ejecutar `login.py`.

El endpoint observado para esta pestaña es `UserRepliesTimeline` (con fallbacks para otras pestañas); X puede cambiarlo sin aviso. Por defecto la corrida incremental se detiene tras `--patience` (4) ventanas inactivas, pero `--full` ignora IDs ya guardados y sólo termina por cursor inferior agotado o `--max-scrolls`. Cada lote GraphQL se guarda inmediatamente y el progreso muestra scroll, nuevos y vistos.

## Refrescar textos largos

La deduplicación conserva filas existentes. Para volver a capturar el texto completo de posts largos, elimina el JSONL local y ejecuta `scrape.py HANDLE --full`; el scraper leerá `note_tweet.note_tweet_results.result.text` cuando X lo incluya.
