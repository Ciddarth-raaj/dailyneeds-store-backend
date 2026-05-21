# GST Tally Purchase API — Changes

Summary of breaking and non-breaking updates to **`POST /tally/gst-purchase`**. For the full current contract, see [gst-tally-purchase-api.md](./gst-tally-purchase-api.md).

**Endpoint:** `POST https://YOUR_SERVER_DOMAIN/tally/gst-purchase`  
**Auth:** `x-access-token` header (unchanged)

---

## 1. Request shape — batch + `Action` per item

### Before

```json
{
  "action": "create",
  "data": {
    "MasterID": "ext-001",
    "VoucherNumber": "MRC99901"
  }
}
```

### After

```json
{
  "data": [
    {
      "Action": "create",
      "MasterID": "ext-001",
      "VoucherNumber": "MRC99901"
    }
  ]
}
```

| Change | Detail |
|--------|--------|
| Top-level `action` | **Removed** |
| `Action` on each voucher | **Required** on every element of `data` (`create`, `update`, `delete`; case-insensitive) |
| `data` type | **Array** of voucher objects (minimum length 1) |
| Mixed operations | One request may combine create / update / delete items |

---

## 2. Response shape — per-item `results`

### Before

Single outcome for the whole request:

```json
{
  "code": 200,
  "action": "create",
  "source": "gst_tally_purchase",
  "mmh_mrc_refno": "MRC99901",
  "master_id": "ext-001"
}
```

### After

Batch outcome; HTTP **200** when the body validates. Check each item in `results`:

```json
{
  "code": 200,
  "results": [
    {
      "index": 0,
      "code": 200,
      "Action": "create",
      "source": "gst_tally_purchase",
      "mmh_mrc_refno": "MRC99901",
      "master_id": "ext-001"
    },
    {
      "index": 1,
      "code": 404,
      "Action": "delete",
      "msg": "GST tally purchase entry not found",
      "master_id": "ext-002",
      "mmh_mrc_refno": "MRC99902"
    }
  ]
}
```

| Field | Meaning |
|-------|---------|
| `results[].index` | Index in the request `data` array |
| `results[].code` | `200`, `400`, `404`, or `500` for that item |
| `results[].Action` | Echo of the item’s `Action` |

**Integrator note:** Do not rely on HTTP 404/400 at the top level for a single failed item in a batch. Inspect `results[i].code` instead.

---

## 3. `BuyerAddress` — two accepted formats

### Before

String only:

```json
"BuyerAddress": "123 Main St, City"
```

### After

String **or** Tally array form (both valid; neither is persisted to DB today):

```json
"BuyerAddress": [
  { "BuyerAddress": "123 Main St" },
  { "BuyerAddress": "City, PIN" }
]
```

---

## 4. New optional fields (validation only)

These fields are **accepted** on each voucher in `data` but **not stored** or used in sync logic:

| Field | Type | Notes |
|-------|------|--------|
| `AlterID` | number or string | Tally alter id |
| `ConsigneeGSTRegistrationType` | string | Distinct from `Consignee_Registration_Type` (journal) |

---

## 5. Behaviour unchanged

| Topic | Still the same |
|-------|----------------|
| **Create** | Upserts `gst_tally_purchase` by `master_id` |
| **Update** | Always upserts `gst_tally_purchase` only; never modifies `purchase` |
| **Push to Tally** | `POST /purchase-tally` copies `purchase` → `gst_tally_purchase` with `MasterID` from `purchase_tally_response` |
| **Delete** | Deletes `gst_tally_purchase` by `MasterID` only |
| **Required per item** | `Action`, `MasterID`, `VoucherNumber` |
| **Tax lines** | `ledgerentries` still drive SGST/CGST/IGST mapping on create/update |

---

## Migration checklist (Tally / third-party)

1. Remove top-level `"action"`.
2. Wrap each voucher in a `data` array.
3. Add `"Action": "create"` (or `update` / `delete`) on **each** object.
4. Parse `results[]` instead of a single top-level `code` / `action`.
5. Send `BuyerAddress` as string or `[{ "BuyerAddress": "..." }]` if Tally exports the array form.
6. Optionally include `AlterID` and `ConsigneeGSTRegistrationType` when present in Tally XML/JSON.

### Minimal batch example

```json
{
  "data": [
    {
      "Action": "create",
      "MasterID": "tally-master-1",
      "VoucherNumber": "MRC10001",
      "VoucherDate": "20260115",
      "PartyName": "Supplier A",
      "VoucherType": "PurchaseDN1",
      "Voucher_Total": "5000.00",
      "BuyerAddress": [{ "BuyerAddress": "Supplier address line" }],
      "AlterID": 42,
      "ConsigneeGSTRegistrationType": "Regular",
      "ledgerentries": []
    }
  ]
}
```

---

## 6. Data split — `purchase` vs `gst_tally_purchase`

- **`purchase` / `purchase_internal`**: Source of truth for store purchases; updated only via purchase APIs.
- **`purchase_tally_response`**: Written on push to Tally; links `purchase_id` + `MasterID`.
- **`gst_tally_purchase`**: Snapshot at push + all Tally sync (`create` / `update` / `delete` on `POST /tally/gst-purchase`).
- **`updated_purchase` tables**: Removed; use `gst_tally_purchase` instead.

---

## Related APIs (unchanged by this document)

| API | Notes |
|-----|--------|
| `GET /purchase` | Separate list API; optional `dist_bill_from_date` / `dist_bill_to_date` filters on `mmh_dist_bill_dt` |
| `GET /purchase-gst` | Same dist-bill date filters on GST tally rows |
| `GET/POST/DELETE /purchase-gst-match` | Purchase ↔ GST B2B matching (not Tally sync) |

---

## Support

For tokens, host URL, or questions about this migration, contact your DailyNeeds technical contact.
