# Edicius HQ

Suite local de finanzas personales, analitica Greenlight, investing y monitoreo operativo.

> **Estado:** bootstrap del repositorio formal. El codigo de producto se importa por issues/PRs de migracion desde el legado `ediciuscorp`. Ver el kit de migracion en el filesystem local `edicius-hq-migration/MIGRATION_PLAN.md` (carpeta hermana al working tree legado).

## Que sera este repo

- **Finanzas** — diagrama interactivo de trabajos, cuentas, monedas y transferencias
- **Greenlight** — dashboard semanal desde CSV
- **Investing** — precios en vivo, chart, watchlist, heatmap
- **Dashboard** — Market Pulse y Sentiment
- **Status** — monitoreo local de internet de esta PC
- **Backend local** — `server.py` (sin nube obligatoria; Supabase opcional)

## Privacidad

Proyecto **privado**. Los datos financieros se quedan en el navegador / disco local (`.local-data/`). No commits de CSV reales, backups personales ni secretos.

## Desarrollo

Flujo obligatorio: **issue → branch → commits convencionales → PR → squash merge**.

Lee [CONTRIBUTING.md](./CONTRIBUTING.md).

## Licencia

Uso privado. Ver [NOTICE](./NOTICE).
