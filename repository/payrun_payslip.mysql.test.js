/**
 * PAYSLIP PUBLISH + MY PAYSLIPS, AS REAL SQL.
 *
 *   ATTENDANCE_TEST_MYSQL=mysql://user:pass@localhost/scratch_db \
 *     node --test repository/payrun_payslip.mysql.test.js
 *
 * SKIPPED unless `ATTENDANCE_TEST_MYSQL` names a SCRATCH database.
 *
 * Every payrun table - including the payslip migration under test - is built
 * from the migration files, and the production usecases and repositories do
 * the work: real Calculate, Approve & Lock, Publish (snapshot inserted in the
 * same transaction), Unpublish (archived), and the Mini App reads through
 * `usecase/telegram_payslip.js` over the real `repository/payrun_payslip.js`.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const URL = process.env.ATTENDANCE_TEST_MYSQL;
const buildCalculationRepo = require("./payrun_calculation");
const buildPayrunRepo = require("./payrun");
const buildAdjustmentRepo = require("./payrun_adjustment");
const buildPayslipRepo = require("./payrun_payslip");
const buildCalculation = require("../usecase/payrun_calculation");
const buildNotifier = require("../usecase/payslip_notification");
const buildMiniApp = require("../usecase/telegram_payslip");
const { sha256 } = require("../utils/payslip_snapshot");
const { dayRowsSql, dayRowsFingerprint } = require("../utils/attendance_month_freshness");
const { SQLS, MIGRATIONS, TABLES, STAND_INS, SOURCES } = require("../test_support/payrun_mysql_fixture");

const YEAR = 2026;
const MONTH = 9;
const SEPT = Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`);
const ACTOR = { employeeId: 77, userId: 7 };
const IDS = [1, 2, 3];
const PAYSLIP_UP = "20261112120000-payrun-payslip-up.sql";
const PAYSLIP_DOWN = "20261112120000-payrun-payslip-down.sql";

const q = (pool, sql, params = []) =>
  new Promise((resolve, reject) => pool.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));

describe("payslip publish over real SQL", { skip: !URL && "ATTENDANCE_TEST_MYSQL is not set" }, () => {
  let pool;
  let usecase;
  let payslipRepo;
  let miniApp;
  let notifier;
  const drain = () => notifier.processQueue();
  const sent = [];
  const rendered = [];
  const act = (action, ids) =>
    usecase.lifecycle({
      action, year: YEAR, month: MONTH, employee_ids: ids,
      reason: action === "PUBLISH" ? null : "Correction after review",
      mode: ids.length === 1 ? "INDIVIDUAL" : "BULK", actor: ACTOR,
    });
  const fingerprints = async () => {
    const out = {};
    for (const t of SOURCES) out[t] = JSON.stringify(await q(pool, `SELECT * FROM \`${t}\` ORDER BY 1, 2`));
    return out;
  };

  before(async () => {
    pool = require("mysql").createPool(`${URL}?connectionLimit=6&multipleStatements=true`);
    await q(pool, "SET FOREIGN_KEY_CHECKS = 0");
    for (const t of TABLES) await q(pool, `DROP TABLE IF EXISTS \`${t}\``);
    await q(pool, "SET FOREIGN_KEY_CHECKS = 1");
    for (const ddl of STAND_INS) await q(pool, ddl);
    for (const file of MIGRATIONS) await q(pool, fs.readFileSync(path.join(SQLS, file), "utf8"));
    await q(pool, "INSERT INTO department VALUES (3, 'Grocery', 1)");

    for (const id of IDS) {
      await q(pool, "INSERT INTO new_employee VALUES (?, ?, 1, 1, 1, 0, '1990-06-15', '2018-04-01', NULL, '100200300400', '3100000000', 1, 'State Bank', ?, 'ABCDE1234F', 3)", [id, `E${id}`, `12345678${id}012`]);
      const s = await q(pool, "INSERT INTO employee_salary (employee_id, monthly_gross, daily_salary, basic, conveyance, hra, special_allowance, effective_from, status) VALUES (?, 26013.37, 1000.51, 13006.69, 2500, 5000, 5506.68, '2026-04-01', 'APPROVED')", [id]);
      const pe = await q(pool, `INSERT INTO payrun_employee
        (period_year, period_month, employee_id, employee_name, store_id, store_name, designation_name, date_of_joining,
         salary_id, salary_effective_from, monthly_gross, daily_salary, basic, conveyance, hra, special_allowance,
         pf_applicable, esi_applicable, uan, esi_number, pay_type, pay_type_source)
        VALUES (?, ?, ?, ?, 1, 'Moolakulam', 'Billing', '2018-04-01', ?, '2026-04-01', 26013.37, 1000.51, 13006.69, 2500, 5000, 5506.68,
                1, 1, '100200300400', '3100000000', 'BANK', 'EMPLOYEE_MASTER')`, [YEAR, MONTH, id, `E${id}`, s.insertId]);
      await q(pool, "INSERT INTO payrun_employee_adjustment_state (payrun_employee_id, period_year, period_month, employee_id, confirmed_no_adjustment, confirmed_by) VALUES (?, ?, ?, ?, 1, 9)", [pe.insertId, YEAR, MONTH, id]);
      for (const [i, d] of SEPT.entries()) {
        await q(pool, `INSERT INTO attendance_day_calculation
            (employee_id, attendance_date, nrm_minutes, break_allowance_source, is_final, approved_ot_minutes,
             status, attendance_day_count, base_nrm_minutes, worked_minutes)
          VALUES (?, ?, 480, 'SHIFT', 1, 0, ?, ?, 480, ?)`, [id, d, i < 26 ? "FINAL" : "ABSENT", i < 26 ? 1 : 0, i < 26 ? 480 : 0]);
      }
      const stored = await q(pool, dayRowsSql(), [id, SEPT[0], SEPT[29]]);
      await q(pool, `INSERT INTO attendance_monthly_payroll
          (employee_id, period_year, period_month, is_final, payroll_version, salary_days, extra_days, base_days,
           monthly_gross, daily_rate, salary_day_earnings, extra_day_earnings, shortage_minutes, missing_minute_deduction,
           approved_ot_minutes, approved_ot_earnings, calculated_at, day_rows_fingerprint)
         VALUES (?, ?, ?, 1, 1, 26, 0, 26, 26013.37, 1000.51, 26013.37, 0, 0, 0, 0, 0, '2026-10-01 02:00:00.000', ?)`,
      [id, YEAR, MONTH, dayRowsFingerprint(stored)]);
    }

    usecase = buildCalculation(buildCalculationRepo(pool), buildPayrunRepo(pool), buildAdjustmentRepo(pool));
    usecase.today = () => "2026-10-03";
    payslipRepo = buildPayslipRepo(pool);
    await q(pool, `INSERT INTO company_details (company_name, reg_address, contact_number, gst_number, pan_number, esi_number, tan_number, pf_number)
                   VALUES ('Daily Needs Departmental Store', '188/1 Iyyanar Koil Street, Muthirapalayam', '-', '-', '-', '51000123450001001', '-', 'TN/MAS/0012345')`);
    notifier = buildNotifier({
        payslipRepo,
        // Employee 1 is linked; 2 is linked but Telegram refuses; 3 has no link.
        identityRepo: {
          getActiveIdentityByEmployee: async (id) =>
            id === 3 ? null : { employee_telegram_id: 40 + id, employee_id: id, private_chat_id: 9000 + id },
        },
        telegram: {
          sendMessage: async (chatId, text) => {
            if (chatId === 9002) {
              const err = new Error("blocked");
              err.response = { status: 403, data: { error_code: 403, description: "Forbidden: bot was blocked by the user" } };
              throw err;
            }
            sent.push({ chatId, text });
            return { code: 200, message_id: 5000 + sent.length };
          },
        },
        intervalMs: 0,
      });
    // The worker runs only when a test drains it, so no pass started by one
    // test can claim rows in the middle of the next. (That Publish and Retry
    // kick it is proven in usecase/payrun_calculation.test.js.)
    notifier.kick = () => {};
    usecase.setPayslipServices({ payslipRepo, notifier, companyEnv: () => ({}) });
    miniApp = buildMiniApp({
      payslipRepo,
      renderPdf: async (snapshot) => {
        rendered.push(snapshot);
        return Buffer.from(`%PDF ${snapshot.final.net_pay}`);
      },
    });

    const calculated = await usecase.calculate({ year: YEAR, month: MONTH, all_eligible: true, actor: ACTOR });
    assert.equal(calculated.calculated_count, IDS.length, JSON.stringify(calculated.results));
    const approved = await usecase.approve({ year: YEAR, month: MONTH, employee_ids: IDS, actor: ACTOR });
    assert.equal(approved.approved_count, IDS.length, JSON.stringify(approved.results));
  });

  after(async () => {
    if (!pool) return;
    await q(pool, "SET FOREIGN_KEY_CHECKS = 0");
    for (const t of TABLES) await q(pool, `DROP TABLE IF EXISTS \`${t}\``);
    await q(pool, "SET FOREIGN_KEY_CHECKS = 1");
    pool.end();
  });

  it("before Publish the Mini App shows nothing", async () => {
    assert.deepEqual((await miniApp.list(1)).payslips, []);
  });

  it("PUBLISH ALL: one payslip per employee + its QUEUED notification, in the same transaction; the worker then records SENT / FAILED / NO_TELEGRAM_LINK; sources untouched", async () => {
    const before = await fingerprints();
    const calcBefore = await q(pool, "SELECT employee_id, net_pay, calculation_hash, calculation_revision, status FROM payrun_employee_calculation ORDER BY employee_id");
    const out = await usecase.publishAllApproved({ year: YEAR, month: MONTH, actor: ACTOR });
    assert.equal(out.published_count, 3, JSON.stringify(out.results));
    assert.deepEqual(out.notification, { queued: 3 });
    assert.ok(out.results.every((r) => r.notification_status === "QUEUED"));

    const slips = await q(pool, "SELECT * FROM payrun_payslip ORDER BY employee_id");
    assert.equal(slips.length, 3);
    for (const [i, slip] of slips.entries()) {
      assert.equal(slip.status, "ACTIVE");
      assert.equal(slip.payslip_version, 1);
      assert.equal(slip.snapshot_sha256, sha256(slip.snapshot_json), "SHA-256 over the exact stored text");
      assert.match(slip.payslip_ref, /^[0-9a-f]{32}$/);
      assert.equal(slip.calculation_hash, calcBefore[i].calculation_hash);
      const snap = JSON.parse(slip.snapshot_json);
      assert.equal(snap.final.net_pay, Number(calcBefore[i].net_pay).toFixed(2));
      assert.equal(snap.employee.department_name, "Grocery");
      assert.equal(snap.company.name, "Daily Needs Departmental Store");
      assert.equal(snap.company.source, "company_details:1");
      assert.equal(snap.statutory.uan_masked, "XXXXXXXX0400");
      assert.ok(!slip.snapshot_json.includes("100200300400"), "full UAN never stored on the payslip");
      const comps = snap.earnings.lines.filter((l) => ["basic", "hra", "conveyance", "special_allowance"].includes(l.key));
      assert.equal(comps.reduce((t, l) => t + Math.round(Number(l.amount) * 100), 0), Math.round(Number(snap.earnings.salary_earnings) * 100));
      assert.equal(comps.find((l) => l.key === "hra").amount, "5000.00");
      assert.equal(snap.employee.bank_account_masked, `XXXXXX${calcBefore[i].employee_id}012`);
      assert.ok(!slip.snapshot_json.includes("ABCDE1234F"), "full PAN never stored");
      assert.ok(!slip.snapshot_json.includes(`12345678${calcBefore[i].employee_id}012`), "full account never stored");
    }
    const calcAfter = await q(pool, "SELECT employee_id, net_pay, calculation_hash, calculation_revision, status FROM payrun_employee_calculation ORDER BY employee_id");
    assert.deepEqual(calcAfter, calcBefore, "no recalculation, status stays APPROVED_LOCKED");
    assert.deepEqual(await fingerprints(), before);

    const published = await q(pool, "SELECT p.published_at = c.published_at AS same FROM payrun_payslip p JOIN payrun_employee_calculation c USING (payrun_calculation_id)");
    assert.ok(published.every((r) => r.same === 1), "payslip published_at is the calculation's own");
    const lc = await q(pool, "SELECT employee_id, payslip_id FROM payrun_employee_lifecycle_audit WHERE action = 'PUBLISH' ORDER BY employee_id");
    assert.deepEqual(lc.map((r) => r.payslip_id), slips.map((s) => s.payslip_id));

    const queued = await q(pool, "SELECT employee_id, result, attempt_no, trigger_type, requested_by FROM payrun_payslip_notification ORDER BY employee_id");
    assert.deepEqual(queued.map((n) => [n.employee_id, n.result, n.attempt_no, n.trigger_type, n.requested_by]), [
      [1, "QUEUED", 1, "PUBLISH", 77], [2, "QUEUED", 1, "PUBLISH", 77], [3, "QUEUED", 1, "PUBLISH", 77],
    ], "queued in the publishing transaction; nothing sent by the request");
    assert.equal(sent.length, 0);
    await drain();
    const notes = await q(pool, "SELECT employee_id, result, attempt_no, trigger_type, private_chat_id, telegram_message_id, failure_code, attempted_at, completed_at FROM payrun_payslip_notification ORDER BY employee_id");
    assert.ok(notes.every((n) => n.attempted_at && n.completed_at));
    assert.deepEqual(notes.map((n) => [n.employee_id, n.result, n.attempt_no, n.trigger_type, n.failure_code]), [
      [1, "SENT", 1, "PUBLISH", null],
      [2, "FAILED", 1, "PUBLISH", "TELEGRAM_403"],
      [3, "NO_TELEGRAM_LINK", 1, "PUBLISH", "NO_TELEGRAM_LINK"],
    ]);
    assert.equal(sent[0].text, "Your payslip for September 2026 is now available in My Payslips.");
  });

  it("the payroll screen shows publication, notification and view state per employee", async () => {
    const rows = (await usecase.getMonth({ year: YEAR, month: MONTH })).rows;
    assert.deepEqual(rows.map((r) => [r.status, r.payslip.notification_status, r.payslip.viewed]), [
      ["PUBLISHED", "SENT", false],
      ["PUBLISHED", "FAILED", false],
      ["PUBLISHED", "NO_TELEGRAM_LINK", false],
    ]);
  });

  it("MINI APP: own payslip listed and opened; A cannot reach B's ref; the first view is recorded once", async () => {
    const list = await miniApp.list(1);
    assert.deepEqual(list.payslips.map((p) => p.label), ["September 2026"]);
    const ref1 = list.payslips[0].payslip_ref;
    const ref2 = (await miniApp.list(2)).payslips[0].payslip_ref;

    await assert.rejects(miniApp.detail(1, ref2), (e) => e.name === "NotFoundError");
    await assert.rejects(miniApp.pdf(1, ref2), (e) => e.name === "NotFoundError");
    const b = (await q(pool, "SELECT first_viewed_at FROM payrun_payslip WHERE employee_id = 2"))[0];
    assert.equal(b.first_viewed_at, null, "a refused attempt is not a view");

    const d = await miniApp.detail(1, ref1);
    const first = (await q(pool, "SELECT first_viewed_at, last_viewed_at, view_count FROM payrun_payslip WHERE employee_id = 1"))[0];
    assert.ok(first.first_viewed_at);
    await new Promise((r) => setTimeout(r, 1100));
    await miniApp.detail(1, ref1);
    const again = (await q(pool, "SELECT first_viewed_at, last_viewed_at, view_count FROM payrun_payslip WHERE employee_id = 1"))[0];
    assert.equal(String(again.first_viewed_at), String(first.first_viewed_at), "first view never moves");
    assert.ok(again.last_viewed_at > first.last_viewed_at, "last view moves");
    assert.equal(again.view_count, 2);

    const pdf = await miniApp.pdf(1, ref1);
    assert.equal(pdf.buffer.toString(), `%PDF ${d.payslip.snapshot.final.net_pay}`, "the PDF and the detail read one snapshot");
    assert.equal(pdf.filename, "Payslip_Sep-2026_1_E1.pdf");
    const row = (await usecase.getMonth({ year: YEAR, month: MONTH })).rows.find((r) => r.employee_id === 1);
    assert.equal(row.payslip.viewed, true);
  });

  it("RETRY: queues a new attempt for the failed one, the worker sends it; nothing republished", async () => {
    const slipsBefore = JSON.stringify(await q(pool, "SELECT payslip_id, status, snapshot_sha256, payslip_version FROM payrun_payslip"));
    const out = await usecase.retryNotification({ year: YEAR, month: MONTH, employee_ids: [1, 2], actor: ACTOR });
    assert.deepEqual(out.results.map((r) => r.result), ["SKIPPED", "QUEUED"]);
    await drain();
    const attempts = await q(pool, "SELECT attempt_no, trigger_type, result FROM payrun_payslip_notification WHERE employee_id = 2 ORDER BY attempt_no");
    assert.deepEqual(attempts.map((a) => [a.attempt_no, a.trigger_type, a.result]), [[1, "PUBLISH", "FAILED"], [2, "RETRY", "FAILED"]]);
    assert.equal(JSON.stringify(await q(pool, "SELECT payslip_id, status, snapshot_sha256, payslip_version FROM payrun_payslip")), slipsBefore);
  });

  it("the snapshot stays frozen when the Salary Master and attendance change after Publish", async () => {
    const before = (await q(pool, "SELECT snapshot_json FROM payrun_payslip WHERE employee_id = 1"))[0].snapshot_json;
    const ref1 = (await miniApp.list(1)).payslips[0].payslip_ref;
    const shown = (await miniApp.detail(1, ref1)).payslip.snapshot;
    await q(pool, "UPDATE employee_salary SET monthly_gross = 99999, basic = 50000 WHERE employee_id = 1");
    await q(pool, "UPDATE attendance_monthly_payroll SET salary_days = 3 WHERE employee_id = 1");
    assert.equal((await q(pool, "SELECT snapshot_json FROM payrun_payslip WHERE employee_id = 1"))[0].snapshot_json, before);
    assert.deepEqual((await miniApp.detail(1, ref1)).payslip.snapshot, shown);
    await q(pool, "UPDATE employee_salary SET monthly_gross = 26013.37, basic = 13006.69 WHERE employee_id = 1");
    await q(pool, "UPDATE attendance_monthly_payroll SET salary_days = 26 WHERE employee_id = 1");
  });

  it("UNPUBLISH: archived in the same transaction, gone from the Mini App at once, payroll still locked, history kept", async () => {
    const ref3 = (await miniApp.list(3)).payslips[0].payslip_ref;
    const out = await act("UNPUBLISH", [3]);
    assert.equal(out.unpublished_count, 1, JSON.stringify(out.results));
    assert.deepEqual((await miniApp.list(3)).payslips, []);
    await assert.rejects(miniApp.detail(3, ref3), (e) => e.name === "NotFoundError");
    await assert.rejects(miniApp.pdf(3, ref3), (e) => e.name === "NotFoundError");
    const slip = (await q(pool, "SELECT status, archived_by, archived_by_user, archive_reason, archived_at FROM payrun_payslip WHERE employee_id = 3"))[0];
    assert.deepEqual([slip.status, slip.archived_by, slip.archived_by_user, slip.archive_reason], ["ARCHIVED", 77, 7, "Correction after review"]);
    assert.ok(slip.archived_at);
    const calc = (await q(pool, "SELECT status, published_at FROM payrun_employee_calculation WHERE employee_id = 3"))[0];
    assert.deepEqual([calc.status, calc.published_at], ["APPROVED_LOCKED", null]);
    const lc = (await q(pool, "SELECT payslip_id FROM payrun_employee_lifecycle_audit WHERE action = 'UNPUBLISH' AND employee_id = 3"))[0];
    assert.ok(lc.payslip_id);
  });

  it("REPUBLISH after Unpublish -> Unlock -> Recalculate -> Approve: version 2 ACTIVE; version 1 kept ARCHIVED", async () => {
    const v1 = (await q(pool, "SELECT snapshot_json FROM payrun_payslip WHERE employee_id = 3"))[0].snapshot_json;
    assert.equal((await act("UNLOCK", [3])).unlocked_count, 1);
    await q(pool, "UPDATE payrun_employee_adjustment_state SET confirmed_no_adjustment = 0 WHERE employee_id = 3");
    const pe = (await q(pool, "SELECT payrun_employee_id FROM payrun_employee WHERE employee_id = 3"))[0].payrun_employee_id;
    await q(pool, "INSERT INTO payrun_employee_adjustment (payrun_employee_id, period_year, period_month, employee_id, component, amount, created_by) VALUES (?, ?, ?, 3, 'INCENTIVE', 750, 9)", [pe, YEAR, MONTH]);
    const recalc = await usecase.calculate({ year: YEAR, month: MONTH, employee_ids: [3], mode: "RECALCULATE", actor: ACTOR });
    assert.equal(recalc.recalculated_count, 1, JSON.stringify(recalc.results));
    assert.equal((await usecase.approve({ year: YEAR, month: MONTH, employee_ids: [3], actor: ACTOR })).approved_count, 1);
    const out = await act("PUBLISH", [3]);
    assert.equal(out.published_count, 1, JSON.stringify(out.results));
    const versions = await q(pool, "SELECT payslip_version, status, snapshot_json FROM payrun_payslip WHERE employee_id = 3 ORDER BY payslip_version");
    assert.deepEqual(versions.map((v) => [v.payslip_version, v.status]), [[1, "ARCHIVED"], [2, "ACTIVE"]]);
    assert.equal(versions[0].snapshot_json, v1, "the archived snapshot is never overwritten");
    assert.equal(JSON.parse(versions[1].snapshot_json).earnings.lines.find((l) => l.key === "incentive").amount, "750.00");
    const list = (await miniApp.list(3)).payslips;
    assert.equal(list.length, 1, "the employee sees only the newest ACTIVE payslip");
  });

  it("CONCURRENCY: simultaneous retries of one payslip queue ONE attempt (the pending key); claims never overlap", async () => {
    await drain(); // start from an empty queue
    const [{ payslip_id }] = await q(pool, "SELECT payslip_id FROM payrun_payslip WHERE employee_id = 2 AND status = 'ACTIVE'");
    const outcomes = await Promise.all([1, 2, 3, 4].map(() =>
      payslipRepo.enqueueRetry({ payslip_id, employee_id: 2, requested_by: 77 })));
    assert.equal(outcomes.filter((o) => o.queued).length, 1, JSON.stringify(outcomes));
    assert.ok(outcomes.filter((o) => !o.queued).every((o) => o.reason === "ALREADY_PENDING"));
    const pending = await q(pool, "SELECT COUNT(*) AS n FROM payrun_payslip_notification WHERE payslip_id = ? AND result IN ('QUEUED','SENDING')", [payslip_id]);
    assert.equal(pending[0].n, 1);

    // Two passes claiming at once take disjoint rows.
    const [{ payslip_id: p1 }] = await q(pool, "SELECT payslip_id FROM payrun_payslip WHERE employee_id = 1 AND status = 'ACTIVE'");
    await payslipRepo.enqueueRetry({ payslip_id: p1, employee_id: 1, requested_by: 77 });
    const [a, b] = await Promise.all([
      payslipRepo.claimQueued({ limit: 1, token: "a".repeat(32) }),
      payslipRepo.claimQueued({ limit: 1, token: "b".repeat(32) }),
    ]);
    const ids = [...a, ...b].map((r) => r.notification_id);
    assert.equal(ids.length, 2);
    assert.equal(new Set(ids).size, 2, "no attempt claimed twice");
    // Only the claiming pass may record the outcome.
    assert.equal(await payslipRepo.completeNotification({ notification_id: a[0].notification_id, claim_token: "c".repeat(32), result: "SENT" }), false);
    assert.equal(await payslipRepo.completeNotification({ notification_id: a[0].notification_id, claim_token: "a".repeat(32), result: "FAILED", failure_code: "TEST" }), true);
  });

  it("STRESS: 20 rounds of concurrent queue / claim / complete across payslips - no error escapes, every attempt finishes once", async () => {
    await drain();
    const slips = await q(pool, "SELECT payslip_id, employee_id FROM payrun_payslip WHERE status = 'ACTIVE'");
    // Close anything still pending so every payslip can take a new attempt.
    await q(pool, "UPDATE payrun_payslip_notification SET result = 'FAILED', failure_code = 'TEST' WHERE result IN ('QUEUED','SENDING') AND claim_token <> ?", ["b".repeat(32)]);
    for (let round = 0; round < 20; round += 1) {
      await Promise.all(slips.map((sl) => payslipRepo.enqueueRetry({ payslip_id: sl.payslip_id, employee_id: sl.employee_id })));
      const claims = await Promise.all(slips.map((_, i) =>
        payslipRepo.claimQueued({ limit: 1, token: `${round}`.padStart(2, "0") + String(i).repeat(30) })));
      const claimed = claims.flatMap((c, i) => c.map((r) => ({ r, token: `${round}`.padStart(2, "0") + String(i).repeat(30) })));
      assert.equal(new Set(claimed.map((c) => c.r.notification_id)).size, claimed.length);
      const done = await Promise.all(claimed.map(({ r, token }) =>
        payslipRepo.completeNotification({ notification_id: r.notification_id, claim_token: token, result: "FAILED", failure_code: "TEST" })));
      assert.ok(done.every(Boolean));
    }
    const pending = await q(pool, "SELECT COUNT(*) AS n FROM payrun_payslip_notification WHERE result = 'QUEUED'");
    assert.equal(pending[0].n, 0);
  });

  it("RECOVERY: a SENDING attempt left by a dead process is closed INTERRUPTED (not re-sent); a fresh one is untouched", async () => {
    await q(pool, "UPDATE payrun_payslip_notification SET attempted_at = CURRENT_TIMESTAMP(3) - INTERVAL 10 MINUTE WHERE result = 'SENDING' AND claim_token = ?", ["b".repeat(32)]);
    const fixed = await payslipRepo.recoverInterrupted({ olderThanSeconds: 120 });
    assert.equal(fixed, 1);
    const row = (await q(pool, "SELECT result, failure_code FROM payrun_payslip_notification WHERE claim_token = ?", ["b".repeat(32)]))[0];
    assert.deepEqual([row.result, row.failure_code], ["FAILED", "INTERRUPTED"]);
    const before = sent.length;
    await drain();
    assert.equal(sent.length, before, "an interrupted attempt is never re-sent automatically");
  });

  it("UNPUBLISH withdraws a still-QUEUED notification in the same transaction", async () => {
    const [{ payslip_id }] = await q(pool, "SELECT payslip_id FROM payrun_payslip WHERE employee_id = 1 AND status = 'ACTIVE'");
    // Leave one QUEUED attempt without running the worker.
    await q(pool, "UPDATE payrun_payslip_notification SET result = 'FAILED' WHERE payslip_id = ? AND result IN ('QUEUED','SENDING')", [payslip_id]);
    await payslipRepo.enqueueRetry({ payslip_id, employee_id: 1, requested_by: 77 });
    const out = await act("UNPUBLISH", [1]);
    assert.equal(out.unpublished_count, 1, JSON.stringify(out.results));
    const last = (await q(pool, "SELECT result, failure_code FROM payrun_payslip_notification WHERE payslip_id = ? ORDER BY attempt_no DESC LIMIT 1", [payslip_id]))[0];
    assert.deepEqual([last.result, last.failure_code], ["FAILED", "PAYSLIP_UNPUBLISHED"]);
    // Publish employee 1 again for the tests after this one.
    assert.equal((await act("PUBLISH", [1])).published_count, 1);
    await drain();
  });

  it("the database refuses a second ACTIVE payslip for one employee month", async () => {
    const row = (await q(pool, "SELECT * FROM payrun_payslip WHERE employee_id = 1 AND status = 'ACTIVE'"))[0];
    await assert.rejects(
      q(pool, `INSERT INTO payrun_payslip (payslip_ref, payrun_employee_id, payrun_calculation_id, employee_id, period_year, period_month,
                 payslip_version, calculation_version, calculation_revision, calculation_hash, source_hash, inputs_hash,
                 snapshot_schema_version, template_version, snapshot_json, snapshot_sha256)
               VALUES (?, ?, ?, 1, 2026, 9, 99, 2, 1, ?, ?, ?, 1, 'payslip-v1', '{}', ?)`,
      ["f".repeat(32), row.payrun_employee_id, row.payrun_calculation_id, row.calculation_hash, row.source_hash, row.inputs_hash, "0".repeat(64)]),
      /ER_DUP_ENTRY/
    );
  });

  it("admin View Payslip: integrity-checked snapshot, versions and attempts; branch scope refuses another outlet", async () => {
    const view = await usecase.getPayslip({ year: YEAR, month: MONTH, employee_id: 2 });
    assert.equal(view.payslip.payslip_version, 1);
    assert.ok(view.notifications.length >= 2);
    assert.ok(!JSON.stringify(view.notifications).includes("private_chat_id"));
    await assert.rejects(usecase.getPayslip({ year: YEAR, month: MONTH, employee_id: 2, store_ids: [99] }), (e) => e.name === "NotFoundError");
  });

  it("MIGRATION up -> down -> up: re-runnable; down removes only this feature's schema; nothing published, no figure moved", async () => {
    const payroll = async () => JSON.stringify(await q(pool,
      "SELECT payrun_calculation_id, employee_id, status, net_pay, net_pay_rounding, total_earnings, calculation_hash, approved_at FROM payrun_employee_calculation ORDER BY 1"));
    const sourcesBefore = await fingerprints();
    const before = await payroll();
    const publishedBefore = (await q(pool, "SELECT COUNT(*) AS n FROM payrun_employee_calculation WHERE published_at IS NOT NULL"))[0].n;

    await q(pool, fs.readFileSync(path.join(SQLS, PAYSLIP_UP), "utf8"));       // up (again): a no-op
    await q(pool, fs.readFileSync(path.join(SQLS, PAYSLIP_DOWN), "utf8"));     // down
    assert.equal((await q(pool, "SHOW TABLES LIKE 'payrun_payslip%'")).length, 0);
    assert.equal((await q(pool, "SHOW COLUMNS FROM payrun_employee_lifecycle_audit LIKE 'payslip_id'")).length, 0);
    assert.equal(await payroll(), before, "down touches no payroll row");
    await q(pool, fs.readFileSync(path.join(SQLS, PAYSLIP_UP), "utf8"));       // up
    assert.deepEqual((await q(pool, "SHOW TABLES LIKE 'payrun_payslip%'")).map((r) => Object.values(r)[0]).sort(),
      ["payrun_payslip", "payrun_payslip_notification"]);
    assert.equal((await q(pool, "SHOW COLUMNS FROM payrun_employee_lifecycle_audit LIKE 'payslip_id'")).length, 1);
    const keys = (await q(pool, "SHOW INDEX FROM payrun_payslip_notification")).map((r) => r.Key_name);
    assert.ok(keys.includes("uq_payslip_notification_pending") && keys.includes("uq_payslip_notification_attempt"));
    assert.ok((await q(pool, "SHOW INDEX FROM payrun_payslip")).some((r) => r.Key_name === "uq_payrun_payslip_active"));

    assert.equal(await payroll(), before, "up touches no payroll row");
    assert.equal((await q(pool, "SELECT COUNT(*) AS n FROM payrun_employee_calculation WHERE published_at IS NOT NULL"))[0].n, publishedBefore);
    assert.equal((await q(pool, "SELECT COUNT(*) AS n FROM payrun_payslip"))[0].n, 0, "the migration creates no payslip");
    assert.equal((await q(pool, "SELECT COUNT(*) AS n FROM payrun_payslip_notification"))[0].n, 0, "the migration queues no notification");
    assert.deepEqual(await fingerprints(), sourcesBefore, "attendance, salary, OT/regularisation sources untouched");
  });
});

describe("the snapshot is never updated anywhere in the codebase", () => {
  it("no UPDATE of payrun_payslip names a snapshot or figure column", () => {
    const root = path.join(__dirname, "..");
    const files = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (["node_modules", ".git", "migrations"].includes(e.name)) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".js") && !e.name.endsWith(".test.js")) files.push(p);
      }
    };
    walk(root);
    const updates = [];
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      const re = /UPDATE\s+payrun_payslip\b([\s\S]*?)WHERE/g;
      let m;
      while ((m = re.exec(src))) updates.push([path.relative(root, f), m[1]]);
    }
    assert.equal(updates.length, 2, JSON.stringify(updates.map((u) => u[0])));
    for (const [, set] of updates) {
      assert.ok(!/snapshot_json|snapshot_sha256|template_version|calculation_hash|payslip_version|employee_id\s*=/.test(set), set);
    }
  });
});
