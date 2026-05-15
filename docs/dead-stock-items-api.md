# Dead stock items API

Persisted dead-stock rows keyed by product, outlet, and age bucket (`type` in MySQL). Use **`GET`** to read a pivoted view (four buckets per product/outlet). Use **`POST /bulk`** to replace the entire table from an import payload (`MID_ITEM_CODE` is the numeric `product_id`, same convention as product sales).

---

## 1. List (pivoted)

| Property | Value |
|----------|--------|
| **Method** | `GET` |
| **Path** | `{API_BASE}/dead-stock-items` |
| **Auth** | Same as other authenticated routes (e.g. `x-access-token` if your deployment uses it). |

### Success — **200**

```json
{
  "code": 200,
  "data": [
    {
      "product_id": 1,
      "outlet_id": 1,
      "outlet_name": "Outlet 1",
      "thirty_days": { "stock": 10, "stock_value": 100 },
      "ninety_days": { "stock": 10, "stock_value": 100 },
      "one_twenty_days": { "stock": 10, "stock_value": 100 },
      "more_thanone_twenty_days": { "stock": 10, "stock_value": 100 }
    }
  ]
}
```

### Behaviour

- Rows in `dead_stock_items` are grouped by **`product_id`**, **`outlet_id`**, and **`type`**, with **`stock`** and **`stock_value`** summed for each group.
- The response merges those groups into **one object per `(product_id, outlet_id)`** with four fixed keys:
  - `thirty_days` ← DB `thirty-days` (MSA **30 Days**)
  - `ninety_days` ← DB `ninety-days` (MSA **90 Days**)
  - `one_twenty_days` ← DB `one-twenty-days` (MSA **120 Days**)
  - `more_thanone_twenty_days` ← DB `more-than-one-twenty-days` (MSA **More than 120 Days**)
- If a bucket has no rows, it is returned as **`{ "stock": 0, "stock_value": 0 }`**.
- `outlet_name` comes from **`outlets.outlet_name`** (may be `null` if missing).

---

## 2. Bulk replace (truncate + insert)

| Property | Value |
|----------|--------|
| **Method** | `POST` |
| **Path** | `{API_BASE}/dead-stock-items/bulk` |
| **Body** | JSON **array** of objects (minimum one element). |
| **Auth** | Same as other authenticated routes. |

### Request body — each object

| Field | Type | Required | Notes |
|-------|------|----------|--------|
| `MID_ITEM_CODE` | string or number | yes | Numeric **`product_id`** (same as `ITEM_CODE` on product sales). |
| `STOCK` | number | yes | Quantity; aggregated with other rows sharing product, outlet, and resolved `type`. |
| `STOCK_VALUE` | number | yes | Value; aggregated the same way. |
| `MSA_NAME` | string | yes | Maps to stored `type` (case-insensitive after trim). Allowed values: **`30 Days`**, **`90 Days`**, **`120 Days`**, **`More than 120 Days`**. |
| `RETAIL_OUTLET_ID` | integer | yes | Must exist in **`outlets.outlet_id`**. |

### Example

```json
[
  {
    "MID_ITEM_CODE": 101,
    "STOCK": 5,
    "STOCK_VALUE": 250.5,
    "MSA_NAME": "30 Days",
    "RETAIL_OUTLET_ID": 1
  },
  {
    "MID_ITEM_CODE": 101,
    "STOCK": 2,
    "STOCK_VALUE": 80,
    "MSA_NAME": "90 Days",
    "RETAIL_OUTLET_ID": 1
  }
]
```

### Processing order

1. Validate each row (types, numeric codes, MSA text).
2. **Aggregate** in memory by `(product_id, outlet_id, type)` so duplicate lines sum into one insert row.
3. Verify all **`product_id`** and **`outlet_id`** values exist.
4. **`TRUNCATE TABLE dead_stock_items`** (full wipe).
5. **Bulk insert** aggregated rows.

### Success — **200**

```json
{ "code": 200, "inserted": 2 }
```

`inserted` is the number of **rows written** after aggregation (not necessarily the number of input lines).

### Errors — **400**

| Cause | Example body |
|--------|----------------|
| Joi validation failure | `{ "code": 400, "msg": "..." }` |
| Bad `MID_ITEM_CODE` | `Invalid MID_ITEM_CODE: must be numeric product id` |
| Unknown product | `Unknown product_id(s) for MID_ITEM_CODE: ...` |
| Unknown outlet | `Unknown RETAIL_OUTLET_ID(s): ...` |
| Bad `MSA_NAME` | `Invalid MSA_NAME: ... (expected 30 Days, 90 Days, 120 Days, More than 120 Days)` |
| Non-numeric stock fields | `STOCK and STOCK_VALUE must be numbers` |

---

## Database (`dead_stock_items`)

| Column | Notes |
|--------|--------|
| `id` | BIGINT, auto-increment, primary key. |
| `product_id` | FK → `product_table.product_id`. |
| `outlet_id` | FK → `outlets.outlet_id`. |
| `stock` | `DECIMAL(14,4)`. |
| `stock_value` | `DECIMAL(16,2)`. |
| `type` | `ENUM`: `thirty-days`, `ninety-days`, `one-twenty-days`, `more-than-one-twenty-days`. |
| `created_at` | `DATETIME`, default current timestamp. |

Migration: `20260516001000-dead-stock-items`.
