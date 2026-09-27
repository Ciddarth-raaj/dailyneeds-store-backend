# Agent instructions

This repository uses **`main-autodeploy`** as the integration branch for all agent/LLM work. GitHub Actions deploys when `main-autodeploy` is pushed.

## Hard rules

- Treat **`main-autodeploy`** as the primary branch for development and merges.
- **Never** commit to, merge into, or push **`master`** unless the user explicitly asks.
- Never start feature work from `master`.
- Pushing `main-autodeploy` triggers production deploy — only push there when intending to ship.
- On merge conflicts: stop and report. Never force-push.

## Workflow for every change request

```text
1. git fetch origin
2. git checkout main-autodeploy && git pull origin main-autodeploy
3. git checkout -b <feature-branch>
4. Implement and commit
5. git push -u origin <feature-branch>
6. git checkout main-autodeploy && git pull
7. git merge <feature-branch>
8. git push origin main-autodeploy
```

## Feature branch names

Use short kebab-case names derived from the request, for example:

- `feat/price-checker`
- `fix/migration-timeout`
- `chore/autodeploy-agents`

## Code changes

- Make the smallest change that solves the request. Do not edit unrelated files.
- Add or update tests only when the change needs them.
- Do not change the database unless the request cannot be done without a schema or data change.
- When a database change is required, add a db-migrate migration under `migrations/mysql` with `up` and `down`. Follow the existing SQL-file pattern in `migrations/mysql/migrations/` and `migrations/mysql/migrations/sqls/`. Do not change the schema by hand.
