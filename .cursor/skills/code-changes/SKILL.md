---
name: code-changes
description: >-
  Keeps backend edits small, adds tests only when needed, and restricts
  database changes to db-migrate. Use when changing application code, fixing
  bugs, adding features, or touching the database. Same rules as AGENTS.md.
---

# Code changes

Same rules as [AGENTS.md](../../../AGENTS.md).

- Make the smallest change that solves the request. Do not edit unrelated files.
- Add or update tests only when the change needs them.
- Do not change the database unless the request cannot be done without a schema or data change.
- When a database change is required, add a db-migrate migration under `migrations/mysql` with `up` and `down`. Follow the existing SQL-file pattern in `migrations/mysql/migrations/` and `migrations/mysql/migrations/sqls/`. Do not change the schema by hand.
