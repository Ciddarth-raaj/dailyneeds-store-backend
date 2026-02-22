# Gofrugal Synker API – Usage Plan

## Overview

This API lets an external tool (e.g. on a server with SQL Server) sync table definitions and data into this backend’s **separate** MySQL database (`dailyneeds_gofrugal_sync`). Tables are created once; subsequent calls upsert rows so there are no duplicates.

---

## 1. Flow

1. **In your other tool (SQL Server side)**  
   You choose which tables to sync.

2. **Your tool sends to this backend**  
   For each table:
   - Table name
   - Column definitions (`table_config`)
   - Which column(s) form the unique key (`unique_keys`)
   - Rows to sync (`table_items`)

3. **This backend**  
   - Creates the table in the gofrugal sync DB **only if it does not exist**.  
   - Inserts/updates rows in batches using **INSERT … ON DUPLICATE KEY UPDATE** so duplicates are avoided.

4. **Repeat**  
   Your tool can call the same endpoint at a fixed interval with new/changed rows; existing rows are updated, new rows inserted.

---

## 2. Endpoint

| Method | Path | Auth |
|--------|------|------|
| POST   | `/gofrugal-synker/sync` | Unprotected (add API key or auth in front if needed) |

**Base URL:** `http://<this-server>:<PORT>/gofrugal-synker/sync`  
Example: `http://localhost:8080/gofrugal-synker/sync`

---

## 3. Request Body (JSON)

| Field          | Type     | Required | Description |
|----------------|----------|----------|-------------|
| `table_name`   | string   | Yes      | Table name (alphanumeric + underscore only). |
| `table_config` | array    | Yes      | Column definitions (see below). |
| `unique_keys`  | string[] | Yes      | Column names that form the unique key (must be a subset of `table_config` names). Used for “create if not exists” and for ON DUPLICATE KEY UPDATE. |
| `table_items`  | array    | No       | Rows to insert/update. Default: `[]`. Can be empty to only ensure table exists. |

### 3.1 `table_config` item

| Field          | Type    | Required | Description |
|----------------|---------|----------|-------------|
| `name`         | string  | Yes      | Column name. |
| `type`         | string  | No       | SQL type, e.g. `INT`, `VARCHAR(255)`, `TEXT`, `DECIMAL(10,2)`, `DATETIME`. Default: `VARCHAR(255)`. |
| `primaryKey`   | boolean | No       | Add PRIMARY KEY for this column. |
| `autoIncrement`| boolean | No       | Add AUTO_INCREMENT. |
| `nullable`     | boolean | No       | If `false`, column is NOT NULL. |

### 3.2 `table_items` item

Each element is an object whose keys are column names (matching `table_config`) and values are the cell values. Missing keys are sent as `NULL`.

---

## 4. Example payloads

### 4.1 Create table and sync rows

```json
{
  "table_name": "items",
  "table_config": [
    { "name": "id", "type": "INT", "primaryKey": true, "autoIncrement": true, "nullable": false },
    { "name": "code", "type": "VARCHAR(100)", "nullable": false },
    { "name": "name", "type": "VARCHAR(500)" },
    { "name": "updated_at", "type": "DATETIME" }
  ],
  "unique_keys": ["code"],
  "table_items": [
    { "id": 1, "code": "ITM001", "name": "Product A", "updated_at": "2025-02-22 10:00:00" },
    { "id": 2, "code": "ITM002", "name": "Product B", "updated_at": "2025-02-22 10:00:00" }
  ]
}
```

### 4.2 Schema-only (create table if not exists, no rows)

```json
{
  "table_name": "categories",
  "table_config": [
    { "name": "category_id", "type": "INT", "nullable": false },
    { "name": "category_name", "type": "VARCHAR(255)" }
  ],
  "unique_keys": ["category_id"],
  "table_items": []
}
```

### 4.3 Subsequent sync (same table, more/updated rows)

Send the same `table_name`, `table_config`, and `unique_keys`; only `table_items` change. Rows matching `unique_keys` are updated; others are inserted. No duplicate rows for the same unique key.

---

## 5. Response

- **Success (200):**
  ```json
  { "code": 200, "msg": "Synced", "table": "<table_name>", "rows": <number of table_items> }
  ```
- **Validation error (400):**  
  `msg` describes the error (e.g. invalid `table_name`, `unique_keys` not in `table_config`).
- **Server error (500):**  
  `msg` contains error details in development.

---

## 6. Behaviour and guarantees

- **Create once:** Table is created only if it does not exist. Later requests do not alter the schema.
- **No duplicate rows:** Rows are upserted using a **UNIQUE** key on `unique_keys`. Same key → update; new key → insert. Batch size is 1000 rows per query for efficiency.
- **Idempotent sync:** Sending the same rows again only updates; no extra copies.
- **Database:** All synced data is stored in the **gofrugal sync** MySQL database (config: `config.json` → `db.mysql_gofrugal`), not in the main app database.

---

## 7. Suggested usage from your other tool

1. **One-time (or when adding a new table):**  
   Call `/gofrugal-synker/sync` with `table_name`, `table_config`, `unique_keys`, and optionally `table_items` to create the table and optionally load initial data.

2. **Periodic sync (e.g. every N minutes):**  
   For each table you want to keep in sync:
   - Read from your SQL Server (full or incremental).
   - Build `table_config` and `unique_keys` (same as when you first created the table).
   - Put the batch of rows into `table_items`.
   - POST to `/gofrugal-synker/sync`.

3. **Large tables (10k+ rows):**  
   Split into multiple requests (e.g. 5000–10000 rows per request) to avoid timeouts and keep payloads manageable. The backend already batches inserts internally (1000 rows per query).

4. **Security:**  
   The sync endpoint is currently unprotected. For production, put it behind auth (e.g. API key header or firewall) or add a shared secret/API key check in this backend.

---

## 8. Config

- **Gofrugal DB:** `config.json` → `db.mysql_gofrugal.[environment]`.
- Same host/port/user/password as main DB; **database** is `dailyneeds_gofrugal_sync` (by default). Create this database on your MySQL server before the first sync.

---

## 9. File reference

| Purpose              | File |
|----------------------|------|
| Sync DB connector    | `drivers/mysql_gofrugal.js` |
| Table create + upsert| `repository/gofrugal_synker.js` |
| Use case             | `usecase/gofrugal_synker.js` |
| Route + validation   | `routes/gofrugal_synker.js` |
| Mount + driver/repos | `server.js` |
| Unprotected route   | `middlewares/auth.js` → `/gofrugal-synker/sync` |
