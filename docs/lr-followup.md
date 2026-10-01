# Purchase / LR Follow-up

Tracks every purchase whose goods are still to arrive, from the moment it is
paid for (Advance Request) or bought on credit (Credit Purchase) until the goods
are **physically received**.

```
Advance Request ─ paid ─┐
                        ├─► LR Follow-up: Dispatch / LR Pending ─► In Transit ─► Goods Received ─► Closed
Credit Purchase created ┘
```

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

* `credit_purchases` - supplier, bill reference, amount, bill date, receiving
  outlet, `transporter_id` (FK), optional LR No. / dispatch / expected date,
  remarks, created by/at. Unique `(distributor_code, bill_reference)` and
  unique `request_key`.
* `lr_followup` - one row per source. `source_type`, `advance_request_id`
  (**unique**, FK) or `credit_purchase_id` (**unique**, FK), a CHECK that
  exactly one is set, copied supplier/outlet/amount/`source_date`
  (advance `paid_at`, or bill date), `lr_no`, `transporter_id` (FK),
  `dispatch_date`, `expected_delivery_date`, `status`, `closure_reason`,
  `goods_received_at/by`, `is_legacy`, `last_follow_up_at`,
  `next_follow_up_date`, `latest_remark`, `created/updated/closed_at`.
  A CHECK makes `CLOSED` always carry `closed_at` and `closure_reason`.
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
| Create credit purchase (+ follow-up) | `POST /credit-purchase` | `create_credit_purchase` | One transaction. Starts In Transit if an LR No. or dispatch date was entered; the transporter alone is not dispatch. |
| Dashboard / list / detail | `GET /lr-followup/summary`, `/`, `/:id`, `/by-source/:type/:id` | `view_lr_followup` | Default order: overdue first, most days overdue, oldest. |
| LR / dispatch update | `PATCH /lr-followup/:id/lr` | `update_lr_followup` | All fields optional; LR No. or dispatch date → In Transit; clearing them → back to pending. Transporter must be active unless unchanged. |
| Add follow-up | `POST /lr-followup/:id/follow-ups` | `update_lr_followup` | Remark required; always a new history row. |
| Mark goods received | `POST /lr-followup/:id/goods-received` | `mark_lr_goods_received` | Row lock + status guard; writes GOODS_RECEIVED then CLOSED; a second call is 409. |
| Legacy decision / close without receipt | `POST /lr-followup/:id/resolve` | `manage_lr_legacy_verification` | Remark required. Legacy: received / still pending / refunded / adjusted / cancelled. Live: refunded / adjusted / cancelled only. |
| Backfill | `POST /lr-followup/legacy/backfill` | `manage_lr_legacy_verification` + All Stores | Idempotent. |
| Transporter Master | `/transporter-master` (`GET`, `GET /:id`, `POST`, `PATCH /:id`, `GET /options`) | `view/create/edit_transporter_master` | `/options` (active only) is also open to `create_credit_purchase` and `update_lr_followup`. |

Every mutation accepts a client `request_key`: a retried submission returns
the current state and writes nothing.

Branch scope: every LR Follow-up and Credit Purchase endpoint resolves the
Dashboard Store Scope. Own Store sees only its outlet; a follow-up of another
branch reads as 404. No scope granted → 403 (sent with the permission
middleware's wording so the web app does not end the session).

## 4. Go-live

1. Deploy backend; `db-migrate up` runs both migrations. The second prints how
   many paid advances await the backfill.
2. Grant keys on the designation permissions screen (nothing is granted by
   the migration). Each user also needs **Dashboard Store Scope: Own Store or
   All Stores**.
3. As an All Stores holder of `manage_lr_legacy_verification`, open
   **Purchase / LR Follow-up → Legacy Follow-up Verification** and press
   **Run Backfill**. Every paid advance without a follow-up comes in as
   *Verification Required*, keeping its `paid_at`. Re-running creates nothing.
4. Work the queue: each decision is recorded in the follow-up history;
   *Goods Still Pending* moves it to the live dashboard. The original advance
   request is never modified.
5. Add transporters in **Master → Transporters** before raising credit
   purchases.

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
