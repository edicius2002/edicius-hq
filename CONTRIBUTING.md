# Contributing to Edicius HQ

## Flujo obligatorio

1. Abre o asigna un **GitHub Issue** (bug, feature o migration).
2. Crea una branch desde `main`:
   - `chore/...` — gobierno, tooling, setup
   - `feat/...` — funcionalidad
   - `fix/...` — correcciones
   - `docs/...` — documentacion
3. Commits con [Conventional Commits](https://www.conventionalcommits.org/):
   - `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`
4. Abre un **Pull Request** enlazando el issue (`Closes #N`).
5. Preferir **squash merge** a `main`.
6. Cierra el issue con el enlace al PR si no se cerro automaticamente.

## Reglas

- Un issue = un PR con scope acotado.
- No mezclar migracion de modulos con features nuevas.
- Nunca commitear `.local-data/`, CSV reales, backups (`*backup*.json`), `.env`, ni `js/config.js` con secretos.
- Antes de `git add`, revisar `git status` y el diff.

## Migracion desde ediciuscorp

La secuencia de issues de migracion esta documentada en el kit local:

`d:\Work\research\edicius-hq-migration\MIGRATION_PLAN.md`

Orden: `#1 setup` → Finanzas/Greenlight → backend → Investing → Dashboard → Status → Supabase opcional → archive del repo legado.
