# Purchase / LR Follow-up

Tracks every purchase whose goods are still to arrive, from the moment it is
paid for (Advance Request) or dispatched by a supplier on credit (**Create LR
Follow-up**, the manual entry) until the goods are **physically received**.

```
Advance Request ─ paid ──────┐
                             ├─► LR Follow-up: Dispatch / LR Pending ─► In Transit ─► Goods Received ─► Closed
Create LR Follow-up (manual) ┘
```

There is no separate "Credit Purchase" module any more. The manual entry
replaced it (migration `20261129120000-lr-followup-manual`): it asks only for
the **Supplier** and the **Transporter** (from the Transporter Master), with
optional **LR No.**, **Dispatch Date**, **Expected Delivery Date** and
**Remarks**. No bill / invoice reference, amount, bill date or receiving
outlet: every such delivery goes to the **Warehouse** (outlet 2,
`constants/outlets.js`), which the server records itself.

**Internal names kept.** The Credit Purchase entry had already been deployed
(`20261109120000-lr-followup` ran in production), so its database names stay:
the entry is a row in `credit_purchases`, its follow-up has
`source_type = 'CREDIT_PURCHASE'` and `credit_purchase_id`, and the create key
is still `create_credit_purchase`. The API and screens never show them: the
API source type is **`MANUAL`** (mapped in `utils/lr_followup.js`
`toApiSourceType` / `fromApiSourceType`), `credit_purchase_id` is not returned,
and a manual follow-up's reference is its own `LRF-n` (there is no `CP-n`).
`view_credit_purchase` is no longer used by any route.

Goods physically received is the only normal closing condition. An LR number,
a dispatch date, a supplier's word, an expected date passing or a completed
payment never close a follow-up.

## 1. Findings (source of truth, before implementation)

| Question | Finding |
|---|---|
| Advance Request payment hook | `PATCH /advance-request/:id/payment` → `AdvanceRequestUsecase.payment()` → `applyStage(id, "payment", "paid")` → `repository/advance_request.js#updateStage` (compare-and-set on `status = 'approved'`) + `advance_request_activity` row. `paid_at`/`paid_by` are stamped there. |
| Advance Request schema | `advance_requests` (stage-4 shape): `advance_request_id`, `distributor_code` → `product_distributor_master.mdm_dist_code`, `amount`, `invoice_number`, `outlet_id`, `status` (`submitted … paid`), `paid_at`. |
| Credit Purchase | **No internal record existed.** The `purchase` table is the store's MRC (goods-receipt) push from GoFrugal (`POST /purchase`, `/purchase/bulk`) - every row exists only after goods are received. `purchase_order` is packing-material POs. No table has a credit / payment-mode flag. With approval, a minimal `credit_purchases` entry was added (below). |
| Reliable goods-received signal | **None** for advance requests: nothing links an advance to a receipt. MRC / acknowledgement rows are GoFrugal-derived and could only be matched heuristically, which the rules forbid using for closure. Receipt is therefore recorded explicitly (Mark Goods Received) and legacy rows go to verification. |
| Permissions | `all_permissions` + `permissions(designation_id, permission_key)`; `middlewares/permissions.js` (`require` = any-of; admin `user_type 2` bypasses). |
| Branch scope | `middlewares/dashboard_scope.js#resolveDashboardScope` - `dashboard_scope_own_store` / `dashboard_scope_all_stores`, own store read live from `new_employee.store_id`. |
| Migrations | db-migrate, one `.js` wrapper + `-up.sql`/`-down.sql` per migration; permission keys inserted with `WHERE NOT EXISTS`, granted to nobody. |
| Audit pattern | Append-only `*_activity` tables (as `advance_request_activity`). |

## 2. Schema

Two migrations, both additive (no existing table altered, no existing row written):

**`20261109110000-transporter-master`**

* `transporter_master` - `transporter_name`, `transporter_name_key` (trimmed,
  collapsed, lower-cased; **unique**), `contact_no` (validated, normalised),
  `alternate_contact_no`, `contact_person`, `is_active`, `remarks`,
  `created_by/at`, `updated_by/at`.
* `transporter_master_audit` - one row per field per create/update.
* No delete anywhere; foreign keys from `credit_purchases` and `lr_followup`
  refuse to let a referenced transporter be removed. Inactive = kept on old
  records, not offered for new ones.

**`20261109120000-lr-followup`**

* `credit_purchases` - supplier, bill / invoice reference, amount, bill /
  invoice date, receiving outlet, `transporter_id` (FK, **NOT NULL**),
  optional LR No. / dispatch / expected date, remarks, created by/at.
  Duplicates: unique `(distributor_code, bill_reference_key)`, where the key
  is the reference upper-cased with spaces and `- / . _ \ #` removed
  (formerly `utils/credit_purchase.js`) - "KF/2026/101", "kf-2026-101" and
  "KF 2026 101" are one bill. Plus unique `request_key` for double clicks.
  **Since `20261129120000-lr-followup-manual`** the bill reference, its key,
  amount and bill date are NULL-able and a manual entry leaves them empty
  (outlet = Warehouse); `lr_followup.amount` is NULL-able too. Rows entered
  before keep their bill, and NULL keys never collide, so the old duplicate
  protection still holds for them. The manual entry's duplicate protection
  is its `request_key`.
* `lr_followup` - one row per source. `source_type`, `advance_request_id`
  (**unique**, FK) or `credit_purchase_id` (**unique**, FK), a CHECK that
  exactly one is set, copied supplier/outlet/amount/`source_date`
  (advance `paid_at`, or bill date), `lr_no`, `transporter_id` (FK),
  `dispatch_date`, `expected_delivery_date`, `status`, `closure_reason`,
  `closure_remark`,
  `goods_received_at/by`, `is_legacy`, `last_follow_up_at`,
  `next_follow_up_date`, `latest_remark`, `created/updated/closed_at`.
  Two CHECKs keep outcomes honest: `chk_lrf_closed` (CLOSED always has
  `closed_at`, `closed_by`, `closure_reason`; an open row has none) and
  `chk_lrf_outcome` (only `GOODS_RECEIVED` carries a receiver; `REFUNDED` /
  `ADJUSTED` / `CANCELLED` carry no receipt date or receiver and must have a
  `closure_remark`).

### Closure outcomes

The workflow status stays `CLOSED`; **`closure_reason` says how**:

| Outcome | Meaning | How |
|---|---|---|
| `CLOSED – GOODS_RECEIVED` | stock physically received | Mark Goods Received (`mark_lr_goods_received`), or a legacy "Goods Received" decision |
| `CLOSED – REFUNDED` / `ADJUSTED` / `CANCELLED` | resolved **without** stock | Close without receipt (`close_lr_followup_without_receipt`), or the same legacy decision; remark mandatory |

Every closure records user (`closed_by`) and time (`closed_at`) on the row
and an activity row (`CLOSED` or `CLOSED_WITHOUT_RECEIPT`). The dashboard
summary returns `closed_goods_received` separately from
`closed_refunded` / `closed_adjusted` / `closed_cancelled` /
`closed_without_receipt`, and the list filters on
`closure_reason=GOODS_RECEIVED|WITHOUT_RECEIPT|REFUNDED|ADJUSTED|CANCELLED`.
* `lr_followup_activity` - append-only history: `activity_type`, `remark`,
  `old_status`, `new_status`, `next_follow_up_date`, `details`,
  `request_key` (unique per follow-up), `created_by`, `created_at`. The
  application has no UPDATE/DELETE for it; the FK has no cascade.

Overdue (`expected_delivery_date < today` and not closed) and ageing are
derived on read, never stored. "Today" is the IST date from the app, passed
into SQL.

## 3. Behaviour

| Action | Endpoint | Key | Notes |
|---|---|---|---|
| Auto-create (advance) | inside `PATCH /advance-request/:id/payment` | `pay_advance_request` (unchanged) | Same transaction as `approved → paid`; a failure rolls the payment back. Locks the advance row, then a locking read for an existing follow-up - idempotent. |
| Create LR Follow-up (manual) | `POST /lr-followup/manual` | `create_credit_purchase` (labelled "Create LR Follow-up") | Body: `distributor_code`, `transporter_id` (both required), `lr_no`, `dispatch_date`, `expected_delivery_date`, `remarks`, `request_key`. One transaction; outlet = Warehouse, so the caller's LR scope must include it. Starts In Transit if an LR No. or dispatch date was entered; the transporter alone is not dispatch. Answers with the follow-up detail. |
| Dashboard / list / detail | `GET /lr-followup/summary`, `/`, `/:id`, `/by-source/:type/:id` | `view_lr_followup` | Default order: overdue first, most days overdue, oldest. |
| LR / dispatch update | `PATCH /lr-followup/:id/lr` | `update_lr_followup` | All fields optional; LR No. or dispatch date → In Transit; clearing them → back to pending. Transporter must be active unless unchanged. |
| Add follow-up | `POST /lr-followup/:id/follow-ups` | `update_lr_followup` | Remark required; always a new history row. |
| Mark goods received | `POST /lr-followup/:id/goods-received` | `mark_lr_goods_received` | Row lock + status guard; writes GOODS_RECEIVED then CLOSED; a second call is 409. |
| Legacy decision | `POST /lr-followup/:id/legacy-decision` | `manage_lr_legacy_verification` | Verification Required rows only. Received / still pending / refunded / adjusted / cancelled; remark required. |
| Close without receipt | `POST /lr-followup/:id/close-without-receipt` | `close_lr_followup_without_receipt` | Live rows only. Refunded / adjusted / cancelled; remark required; never readable as received. |
| Backfill | `POST /lr-followup/legacy/backfill` | `manage_lr_legacy_verification` + LR all-stores scope | Idempotent. |
| Transporter Master | `/transporter-master` (`GET`, `GET /:id`, `POST`, `PATCH /:id`, `GET /options`) | `view/create/edit_transporter_master` | `/options` (active only) is also open to `create_credit_purchase` (Create LR Follow-up) and `update_lr_followup`. |

Every mutation accepts a client `request_key`: a retried submission returns
the current state and writes nothing.

Branch scope - the module's OWN rule (`utils/lr_followup_scope.js`), not the
Dashboard Store Scope:

* administrator, or holder of **`lr_followup_all_stores`** → every branch
  (the company-wide follow-up desk; no branch of their own needed);
* anyone else → their own branch from Employee Master, read live;
* inactive employee, or no branch and no all-stores key → 403.

The `dashboard_scope_*` keys play no part: granting the follow-up desk
company-wide follow-ups widens no dashboard, and a dashboard All Stores key
widens no follow-up. A follow-up of another branch reads as 404. A 403 is
sent with the permission middleware's wording so the web app does not end
the session.

## 4. Go-live

1. Deploy backend; `db-migrate up` runs both migrations. The second prints how
   many paid advances await the backfill.
2. Grant keys on the designation permissions screen (nothing is granted by
   the migration). The follow-up desk needs **LR Follow-up: All Stores**
   (`lr_followup_all_stores`) to see every branch; without it a user sees
   their own branch only. Grant **Close LR Follow-up Without Receipt** only
   to whoever may record refunds / adjustments / cancellations.
3. As a holder of `manage_lr_legacy_verification` and `lr_followup_all_stores`, open
   **Purchase / LR Follow-up → Legacy Follow-up Verification** and press
   **Run Backfill**. Every paid advance without a follow-up comes in as
   *Verification Required*, keeping its `paid_at`. Re-running creates nothing.
4. Work the queue: each decision is recorded in the follow-up history;
   *Goods Still Pending* moves it to the live dashboard. The original advance
   request is never modified.
5. Add transporters in **Master → Transporters** before creating LR
   Follow-ups by hand.

## 5. Tests

* `utils/lr_followup.test.js`, `utils/transporter.test.js` - the rules.
* `routes/lr_followup.test.js` - every endpoint's key, server-side refusal
  without the key or without scope, Own-Store narrowing, body validation.
* `usecase/advance_request_lr_followup.test.js` - the payment hook joins the
  payment's transaction; other stages are untouched
  (`usecase/advance_request.test.js` still passes unchanged).
* `migrations/lr_followup.test.js` - migration text.
* `repository/lr_followup.mysql.test.js` - **real MariaDB**:
  `LR_TEST_MYSQL=mysql://user:pass@localhost/scratch node --test repository/lr_followup.mysql.test.js`.
  Runs the migration files, both triggers, duplicate events and simultaneous
  requests (payments, credit saves, goods received, backfills), overdue,
  backfill idempotency, legacy decisions, scope, transporter rules, FK
  protection, and an end-to-end HTTP flow.
