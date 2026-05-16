# GST Tally Purchase API

Integration guide for third-party systems syncing purchase vouchers with DailyNeeds.

---

## Server

| Setting           | Value                                            |
| ----------------- | ------------------------------------------------ |
| **Server domain** | `https://api.dnds.co.in`                         |
| **Endpoint**      | `POST https://api.dnds.co.in/tally/gst-purchase` |

Replace `api.dnds.co.in` with the host provided by DailyNeeds (e.g. `api.example.com`). Do not include a trailing slash on the domain.

---

## Authentication

Every request **requires** an access token (JWT, unlimited validity).

| Header           | Value                 |
| ---------------- | --------------------- |
| `x-access-token` | Your API access token |
| `Content-Type`   | `application/json`    |

DailyNeeds will issue a dedicated token for your integration. Store it securely; treat it like a password.

**Example headers**

```http
POST /tally/gst-purchase HTTP/1.1
Host: api.dnds.co.in
x-access-token: YOUR_ACCESS_TOKEN
Content-Type: application/json
```

**Auth errors**

| HTTP status | Body                                      | Meaning                  |
| ----------- | ----------------------------------------- | ------------------------ |
| 403         | `{ "code": 403, "msg": "Access Denied" }` | Missing or invalid token |

---

## POST /tally/gst-purchase

Sync a single Tally purchase (or journal) voucher: **create**, **update**, or **delete**.

### Request body

```json
{
  "action": "create",
  "data": {}
}
```

| Field    | Type   | Required | Description                             |
| -------- | ------ | -------- | --------------------------------------- |
| `action` | string | Yes      | `create`, `update`, or `delete`         |
| `data`   | object | Yes      | Tally voucher object (see schema below) |

### Required fields in `data`

| Field           | Description                                                    |
| --------------- | -------------------------------------------------------------- |
| `MasterID`      | Unique identifier for this Tally entry (stable across updates) |
| `VoucherNumber` | Purchase reference number (`mmh_mrc_refno` in DailyNeeds)      |

Send as much detail as available, especially `ledgerentries` for tax breakdown.

---

## Actions

### `create`

Inserts a new record in `gst_tally_purchase` (and `gst_tally_purchase_internal`).

- Does **not** modify the main `purchase` table.
- If `MasterID` already exists, the row is updated (upsert on `master_id`).

**Success response (200)**

```json
{
  "code": 200,
  "action": "create",
  "source": "gst_tally_purchase",
  "mmh_mrc_refno": "MRC12345",
  "master_id": "your-master-id"
}
```

---

### `update`

Updates data based on whether `VoucherNumber` exists in the main `purchase` table.

| Condition                            | Behaviour                                                      |
| ------------------------------------ | -------------------------------------------------------------- |
| `VoucherNumber` exists in `purchase` | Updates `purchase` and `purchase_internal`                     |
| `VoucherNumber` not in `purchase`    | Updates `gst_tally_purchase` and `gst_tally_purchase_internal` |

**Success response (200) — updated in main purchase table**

```json
{
  "code": 200,
  "action": "update",
  "source": "purchase",
  "mmh_mrc_refno": "MRC12345",
  "master_id": "your-master-id"
}
```

**Success response (200) — updated in GST tally table only**

```json
{
  "code": 200,
  "action": "update",
  "source": "gst_tally_purchase",
  "mmh_mrc_refno": "MRC12345",
  "master_id": "your-master-id"
}
```

---

### `delete`

Deletes the row from `gst_tally_purchase` (internal row removed via cascade).

- Identified by `data.MasterID`.
- Does **not** delete rows from the main `purchase` table.

**Success response (200)**

```json
{
  "code": 200,
  "msg": "Deleted"
}
```

**Not found (404)**

```json
{
  "code": 404,
  "msg": "GST tally purchase entry not found"
}
```

---

## `data` object schema

### Example voucher

```json
{
  "MasterID": "ext-001-purchase",
  "VoucherNumber": "MRC12345",
  "VoucherDate": "20260115",
  "Reference": "DIST-BILL-001",
  "ReferenceDate": "20260115",
  "PartyName": "Supplier Name Pvt Ltd",
  "PartyCode": "SUP001",
  "BuyerName": "Supplier Name Pvt Ltd",
  "BuyerGSTIN": "34AAAAA0000A1Z5",
  "BuyerGSTRegistrationType": "Regular",
  "VoucherType": "PurchaseDN1",
  "VoucherCostCentre": "Outlet Name",
  "Voucher_Total": "15000.00",
  "Narration": "Purchase narration",
  "PlaceOfSupply": "Puducherry",
  "IsInvoice": "Yes",
  "ledgerentries": [
    {
      "LedgerName": "Supplier Name Pvt Ltd",
      "LedgerAmount": "15000.00",
      "IsDeemedPositive": "No",
      "BillsAllocation": [
        {
          "AgstType": "New Ref",
          "Reference": "DIST-BILL-001",
          "CreditPeriod": 0,
          "Amount": "15000.00"
        }
      ]
    },
    {
      "LedgerName": "LOCAL PURCHASE 12%",
      "LedgerAmount": "12000.00",
      "IsDeemedPositive": "Yes",
      "GSTClassification": "Purchase Taxable",
      "IGSTRate": 12
    }
  ]
}
```

### Voucher header fields

| Field                      | Type            | Description                                  |
| -------------------------- | --------------- | -------------------------------------------- |
| `MasterID`                 | string          | **Required.** Unique Tally master id         |
| `VoucherNumber`            | string          | **Required.** MRC reference / voucher number |
| `VoucherDate`              | string          | `YYYYMMDD` or `YYYY-MM-DD`                   |
| `Reference`                | string          | Distributor bill number                      |
| `ReferenceDate`            | string          | Bill date                                    |
| `PartyName`                | string          | Supplier name                                |
| `PartyCode`                | string          | Supplier code                                |
| `BuyerName`                | string          | Buyer display name                           |
| `BuyerGSTIN`               | string          | Supplier GSTIN                               |
| `BuyerGSTRegistrationType` | string          | e.g. `Regular`                               |
| `VoucherType`              | string          | See outlet table below                       |
| `VoucherCostCentre`        | string          | Outlet / cost centre name                    |
| `Voucher_Total`            | string / number | Total voucher amount                         |
| `Narration`                | string          | Narration text                               |
| `PlaceOfSupply`            | string          | e.g. `Puducherry`                            |
| `IsInvoice`                | string          | e.g. `Yes`                                   |
| `IsDeleted`                | string          |                                              |
| `ConsigneeName`            | string          |                                              |
| `ConsigneeGSTIN`           | string          |                                              |
| `ledgerentries`            | array           | Ledger lines (see below)                     |

Additional header fields are accepted if present.

### `VoucherType` values (outlet mapping)

| `VoucherType` | Outlet   |
| ------------- | -------- |
| `Purchase`    | Outlet 2 |
| `PurchaseDN2` | Outlet 3 |
| `PurchaseDN1` | Outlet 4 |
| `PurchaseDN3` | Outlet 5 |
| `PurchaseDN4` | Outlet 6 |
| `PurchaseDN5` | Outlet 7 |

### `ledgerentries[]` item

| Field                | Type            | Description                      |
| -------------------- | --------------- | -------------------------------- |
| `LedgerName`         | string          | Ledger name                      |
| `LedgerGroup`        | string          |                                  |
| `GroupName`          | string          | Used on journal lines            |
| `LedgerAmount`       | string / number | Amount                           |
| `IsDeemedPositive`   | string          | `Yes` / `No`                     |
| `IsPartyLedger`      | string          |                                  |
| `GSTClassification`  | string          |                                  |
| `IGSTRate`           | string / number |                                  |
| `BillsAllocation`    | array           | Bill references                  |
| `CategoryAllocation` | array           | Cost centre allocation (journal) |

**Typical purchase ledger names**

- Supplier line: `PartyName` as `LedgerName`
- Local purchase: `LOCAL PURCHASE {rate}%`, `CGST {rate}% INPUT`, `SGST {rate}% INPUT`
- IGST purchase: `IGST PURCHASE {rate}%`, `IGST {rate}% INPUT`
- Adjustments: `Cash Discount`, `Scheme Difference`, `Cost Difference`, `Due`, `Freight Charges`, `Supplier Credit Note`, `Discount on Purchase`, `Round Off`, `TCS @ 0.1%`, `CESS 12% INPUT`

### Journal entry variant

When `VoucherType` is `Journal`, use the same top-level shape; journal-specific ledgers use `GroupName`, `CategoryAllocation`, etc.

---

## Example requests

### Create

```bash
curl -X POST "https://api.dnds.co.in/tally/gst-purchase" \
  -H "x-access-token: YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "create",
    "data": {
      "MasterID": "ext-001-purchase",
      "VoucherNumber": "MRC99901",
      "VoucherDate": "20260115",
      "Reference": "BILL-9001",
      "PartyName": "ABC Distributors",
      "PartyCode": "ABC01",
      "BuyerGSTIN": "34AAAAA0000A1Z5",
      "VoucherType": "PurchaseDN1",
      "VoucherCostCentre": "Dailyneeds 1",
      "Voucher_Total": "10000.00",
      "Narration": "GST purchase sync",
      "ledgerentries": [
        {
          "LedgerName": "ABC Distributors",
          "LedgerAmount": "10000.00",
          "IsDeemedPositive": "No",
          "BillsAllocation": [
            {
              "AgstType": "New Ref",
              "Reference": "BILL-9001",
              "Amount": "10000.00"
            }
          ]
        }
      ]
    }
  }'
```

### Update

```bash
curl -X POST "https://api.dnds.co.in/tally/gst-purchase" \
  -H "x-access-token: YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "update",
    "data": {
      "MasterID": "ext-001-purchase",
      "VoucherNumber": "MRC99901",
      "Voucher_Total": "10500.00",
      "Narration": "Updated total",
      "ledgerentries": []
    }
  }'
```

### Delete

```bash
curl -X POST "https://api.dnds.co.in/tally/gst-purchase" \
  -H "x-access-token: YOUR_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "action": "delete",
    "data": {
      "MasterID": "ext-001-purchase",
      "VoucherNumber": "MRC99901"
    }
  }'
```

---

## HTTP status codes

| Status | When                                                      |
| ------ | --------------------------------------------------------- |
| 200    | Success                                                   |
| 400    | Missing `VoucherNumber` / `MasterID`, or invalid `action` |
| 403    | Authentication failed                                     |
| 404    | Delete: no row for `MasterID`                             |
| 422    | Request body validation failed                            |
| 500    | Server error                                              |

**Validation error (422)**

```json
{
  "code": 422,
  "msg": "ValidationError: ..."
}
```

---

## Integration notes

1. **Stable `MasterID`** — Use a fixed id per Tally voucher so updates and deletes target the same row.
2. **`VoucherNumber`** — Maps to `mmh_mrc_refno`; drives update routing between `purchase` and `gst_tally_purchase`.
3. **Tax lines** — Include `ledgerentries` on create/update so SGST/CGST/IGST amounts are stored correctly.
4. **Token** — The issued token does not expire; rotate only if compromised (contact DailyNeeds).

---

## Support

For server domain, token issuance, or access, contact your DailyNeeds technical contact.
