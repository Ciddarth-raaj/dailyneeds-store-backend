/**
 * FULL & FINAL SETTLEMENT OVER REAL SQL - the migration, the production
 * repositories and usecases, end to end.
 *
 *   ATTENDANCE_TEST_MYSQL=mysql://user:pass@localhost/scratch_db \
 *     node --test repository/employee_exit.mysql.test.js
 *
 * SKIPPED unless `ATTENDANCE_TEST_MYSQL` names a SCRATCH database (it drops
 * and recreates every table it uses).
 *
 * Every payrun table is built from the MIGRATION FILES, including
 * 20261201120000-fnf-settlement under test. The shared stand-ins
 * (test_support/payrun_mysql_fixture.js) are used, and the two
 * `new_employee` columns and the EPFO ceiling migration that the current
 * calculation repository reads - which that shared fixture predates - are
 * added here, locally, with explicit column lists.
 *
 * August 2026, two employees:
 *   1  ACTIVE all month           -> an ordinary Salary Payslip
 *   2  last working day 16 Aug    -> the Full & Final Settlement, with an
 *                                    advance recovery (Adjustment) and two
 *                                    F&F items (Leave Encashment, Notice
 *                                    Period Recovery)
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
const buildExitRepo = require("./employee_exit");
const buildCalculation = require("../usecase/payrun_calculation");
const buildExit = require("../usecase/employee_exit");
const buildNotifier = require("../usecase/payslip_notification");
const buildMiniApp = require("../usecase/telegram_payslip");
const { isExitMonth } = require("../utils/fnf");
const { sha256 } = require("../utils/payslip_snapshot");
const { payslipHtml } = require("../services/payslip_pdf");
const { dayRowsSql, dayRowsFingerprint } = require("../utils/attendance_month_freshness");
const { SQLS, MIGRATIONS, TABLES, STAND_INS } = require("../test_support/payrun_mysql_fixture");

const YEAR = 2026;
const MONTH = 8;
const AUG = Array.from({ length: 31 }, (_, i) => `2026-08-${String(i + 1).padStart(2, "0")}`);
const ACTOR = { employeeId: 77, userId: 7 };
const FNF_UP = "20261201120000-fnf-settlement-up.sql";
const FNF_DOWN = "20261201120000-fnf-settlement-down.sql";
const EPFO_UP = "20261120120000-epfo-wage-ceiling-2026-up.sql";
const FEATURE_TABLES = [
  "employee_rehire_exception",
  "payrun_exit_reconcile_audit",
  "employee_rehire_assessment",
  "employee_exit_interview",
  "employee_fnf_settlement_event",
  "employee_fnf_settlement",
  "payrun_fnf_item_audit",
  "payrun_fnf_item",
  "employee_employment_period",
  "permissions",
];

/* Stands in for the business confirming a component's PF / ESI treatment. */
const { FNF_COMPONENT_BY_KEY } = require("../constants/fnf");
const confirmed = [];
const confirmTreatment = (keys) =>
  keys.forEach((k) => {
    FNF_COMPONENT_BY_KEY[k].statutory = "CONFIRMED";
    confirmed.push(k);
  });

const q = (pool, sql, params = []) =>
  new Promise((resolve, reject) => pool.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))));

describe("full & final settlement over real SQL", { skip: !URL && "ATTENDANCE_TEST_MYSQL is not set" }, () => {
  let pool;
  let calcUsecase;
  let calcRepo;
  let exitRepo;
  let exitUsecase;
  let payslipRepo;
  let notifier;
  let miniApp;
  const sent = [];
  let telegramDown = true;
  const act = (action, ids, reason = "Correction") =>
    calcUsecase.lifecycle({
      action, year: YEAR, month: MONTH, employee_ids: ids,
      reason: action === "PUBLISH" ? null : reason,
      mode: ids.length === 1 ? "INDIVIDUAL" : "BULK", actor: ACTOR,
    });

  const dropAll = async () => {
    await q(pool, "SET FOREIGN_KEY_CHECKS = 0");
    for (const t of [...FEATURE_TABLES, ...TABLES]) await q(pool, `DROP TABLE IF EXISTS \`${t}\``);
    await q(pool, "SET FOREIGN_KEY_CHECKS = 1");
  };

  const seedEmployee = async (id, { exit = null, presentDays, advance = null }) => {
    await q(pool,
      `INSERT INTO new_employee (employee_id, employee_name, store_id, pf_applicable, esi_applicable, previous_eps_member,
                                 previous_pf_member, dob, date_of_joining, resignation_date, uan, pf_number, esi_number,
                                 attendance_required, bank_name, account_no, pan_no, department_id)
       VALUES (?, ?, 2, 1, 1, 0, 0, '1998-06-15', '2026-02-02', ?, '100200300400', 'PY/PDY/1/2095', '3100000000', 1,
               'INDIAN BANK', ?, 'ABCDE1234F', 3)`,
      [id, `E${id}`, exit, `78953838${id}1`]);
    const s = await q(pool,
      `INSERT INTO employee_salary (employee_id, monthly_gross, daily_salary, basic, conveyance, hra, special_allowance, effective_from, status)
       VALUES (?, 10000, 384.62, 8000, 0, 0, 2000, '2026-02-02', 'APPROVED')`, [id]);
    const pe = await q(pool, `INSERT INTO payrun_employee
        (period_year, period_month, employee_id, employee_name, store_id, store_name, designation_name, date_of_joining, resignation_date,
         salary_id, salary_effective_from, monthly_gross, daily_salary, basic, conveyance, hra, special_allowance,
         pf_applicable, esi_applicable, uan, pf_number, esi_number, pay_type, pay_type_source)
        VALUES (?, ?, ?, ?, 2, 'Ecr', 'Customer Service Associate', '2026-02-02', ?, ?, '2026-02-02', 10000, 384.62, 8000, 0, 0, 2000,
                1, 1, '100200300400', 'PY/PDY/1/2095', '3100000000', 'BANK', 'EMPLOYEE_MASTER')`,
      [YEAR, MONTH, id, `E${id}`, exit, s.insertId]);
    if (advance) {
      await q(pool, `INSERT INTO payrun_employee_adjustment (payrun_employee_id, period_year, period_month, employee_id, component, amount)
                     VALUES (?, ?, ?, ?, 'ADVANCE_RECOVERY', ?)`, [pe.insertId, YEAR, MONTH, id, advance]);
    } else {
      await q(pool, `INSERT INTO payrun_employee_adjustment_state (payrun_employee_id, period_year, period_month, employee_id, confirmed_no_adjustment, confirmed_by)
                     VALUES (?, ?, ?, ?, 1, 9)`, [pe.insertId, YEAR, MONTH, id]);
    }
    const lastDay = exit ? Number(exit.slice(8, 10)) : 31;
    for (const [i, d] of AUG.slice(0, lastDay).entries()) {
      const present = i < presentDays;
      await q(pool, `INSERT INTO attendance_day_calculation
          (employee_id, attendance_date, nrm_minutes, break_allowance_source, is_final, approved_ot_minutes,
           status, attendance_day_count, base_nrm_minutes, worked_minutes)
        VALUES (?, ?, 480, 'SHIFT', 1, 0, ?, ?, 480, ?)`, [id, d, present ? "FINAL" : "ABSENT", present ? 1 : 0, present ? 480 : 0]);
    }
    const stored = await q(pool, dayRowsSql(), [id, AUG[0], AUG[30]]);
    const earn = Math.round(presentDays * 384.62 * 100) / 100;
    await q(pool, `INSERT INTO attendance_monthly_payroll
        (employee_id, period_year, period_month, is_final, payroll_version, salary_days, extra_days, base_days,
         monthly_gross, daily_rate, salary_day_earnings, extra_day_earnings, shortage_minutes, missing_minute_deduction,
         approved_ot_minutes, approved_ot_earnings, calculated_at, day_rows_fingerprint)
       VALUES (?, ?, ?, 1, 1, ?, 0, ?, 10000, 384.62, ?, 0, 0, 0, 0, 0, '2026-09-01 02:00:00.000', ?)`,
    [id, YEAR, MONTH, presentDays, lastDay, earn, dayRowsFingerprint(stored)]);
    return pe.insertId;
  };

  before(async () => {
    pool = require("mysql").createPool(`${URL}?connectionLimit=12&multipleStatements=true`);
    await dropAll();
    for (const ddl of STAND_INS) await q(pool, ddl);
    // What the current statutory read needs from new_employee (see header).
    await q(pool, "ALTER TABLE new_employee ADD COLUMN previous_pf_member TINYINT(1) NULL, ADD COLUMN pf_number VARCHAR(45) NULL");
    // What Publish reads from the priced salary record (the M2 salary engine's columns).
    await q(pool, `ALTER TABLE employee_salary
        ADD COLUMN pf_status VARCHAR(32) NULL, ADD COLUMN employee_pf DECIMAL(12,2) NULL, ADD COLUMN employer_pf_total DECIMAL(12,2) NULL,
        ADD COLUMN edli DECIMAL(12,2) NULL, ADD COLUMN pf_admin_charge DECIMAL(12,2) NULL, ADD COLUMN esi_status VARCHAR(32) NULL,
        ADD COLUMN esi_wage DECIMAL(12,2) NULL, ADD COLUMN employee_esi DECIMAL(12,2) NULL, ADD COLUMN employer_esi DECIMAL(12,2) NULL,
        ADD COLUMN monthly_ctc DECIMAL(12,2) NULL, ADD COLUMN ctc_status VARCHAR(32) NULL, ADD COLUMN unresolved_notes TEXT NULL,
        ADD COLUMN statutory_snapshot JSON NULL`);
    // The designation grants table the down migration cleans.
    await q(pool, "CREATE TABLE permissions (designation_id INT NOT NULL, permission_key VARCHAR(100) NOT NULL) ENGINE=InnoDB");
    // The shared list already ends with the feature migration; the EPFO
    // ceiling columns are added after it here (they are independent).
    for (const file of [...MIGRATIONS, EPFO_UP]) await q(pool, fs.readFileSync(path.join(SQLS, file), "utf8"));
    // The feature migration ran once in the shared list; run it AGAIN: every
    // statement is guarded.
    await q(pool, fs.readFileSync(path.join(SQLS, FNF_UP), "utf8"));
    await q(pool, "INSERT INTO department VALUES (3, 'Front Office', 1)");
    await q(pool, `INSERT INTO company_details (company_name, reg_address, contact_number, gst_number, pan_number, esi_number, tan_number, pf_number)
                   VALUES ('DAILY NEEDS DEPARTMENT STORE', '25 & 26, 45ft Road, Vallalar Salai Puducherry, 605011', '-', '-', '-', '51000123450001001', '-', 'PY/PDY/0012345')`);

    await seedEmployee(1, { presentDays: 26 });
    await seedEmployee(2, { exit: "2026-08-16", presentDays: 13, advance: 1000 });
    await q(pool, `INSERT INTO employee_employment_period (employee_id, period_no, period_state, joined_on, ended_on, end_reason_type)
                   VALUES (2, 1, 'closed', '2026-02-02', '2026-08-16', 'resignation'), (1, 1, 'open', '2026-02-02', NULL, NULL)`);

    calcRepo = buildCalculationRepo(pool);
    calcUsecase = buildCalculation(calcRepo, buildPayrunRepo(pool), buildAdjustmentRepo(pool));
    calcUsecase.today = () => "2026-09-03";
    payslipRepo = buildPayslipRepo(pool);
    notifier = buildNotifier({
      payslipRepo,
      identityRepo: { getActiveIdentityByEmployee: async (id) => ({ employee_telegram_id: 40 + id, employee_id: id, private_chat_id: 9000 + id }) },
      telegram: {
        sendMessage: async (chatId, text) => {
          if (chatId === 9002 && telegramDown) {
            const err = new Error("timeout");
            err.code = "ETIMEDOUT";
            throw err;
          }
          sent.push({ chatId, text });
          return { code: 200, message_id: 7000 + sent.length };
        },
      },
      intervalMs: 0,
    });
    notifier.kick = () => {};
    calcUsecase.setPayslipServices({ payslipRepo, notifier, companyEnv: () => ({}) });
    miniApp = buildMiniApp({ payslipRepo, renderPdf: async (s) => Buffer.from(payslipHtml(s, { logo: null })) });
    exitRepo = buildExitRepo(pool);
    exitUsecase = buildExit(exitRepo, { today: () => "2026-09-20" });
  });

  after(async () => {
    confirmed.forEach((k) => {
      FNF_COMPONENT_BY_KEY[k].statutory = "UNCONFIRMED";
    });
    if (!pool) return;
    await dropAll();
    pool.end();
  });

  it("the migration is additive: existing payroll tables keep working, permissions declared to nobody", async () => {
    const cols = await q(pool, "SHOW COLUMNS FROM payrun_payslip LIKE 'document_type'");
    assert.equal(cols[0].Default, "PAYSLIP");
    const keys = await q(pool, "SELECT permission_key FROM all_permissions WHERE permission_key LIKE '%fnf%' OR permission_key LIKE '%exit%' OR permission_key LIKE '%rehire%' ORDER BY 1");
    assert.deepEqual(keys.map((k) => k.permission_key), [
      "approve_rehire_exception", "manage_exit_interview", "manage_fnf_settlement", "override_rehire_eligibility", "view_exit_interview", "view_fnf_settlement",
    ]);
  });

  it("F&F items: refused for an active employee, saved and audited for the exit month", async () => {
    const active = await exitRepo.saveItems({ year: YEAR, month: MONTH, employee_id: 1, entries: [{ component: "GRATUITY", amount: 10 }], actor: 77, isExitMonth });
    assert.equal(active.outcome, "NOT_EXIT_MONTH");
    const saved = await exitUsecase.saveItems({
      year: YEAR, month: MONTH, employee_id: 2, actor: ACTOR,
      items: [
        { component: "LEAVE_ENCASHMENT", amount: 1500, remarks: "6 days EL" },
        { component: "NOTICE_PERIOD_RECOVERY", amount: 400.5 },
      ],
    });
    assert.equal(saved.set, 2);
    const audit = await q(pool, "SELECT action, component, old_amount, new_amount, changed_by FROM payrun_fnf_item_audit ORDER BY 1, component");
    assert.equal(audit.length, 2);
    assert.ok(audit.every((a) => a.action === "SET_AMOUNT" && a.changed_by === 77));
    assert.equal((await q(pool, "SELECT COUNT(*) n FROM payrun_fnf_item WHERE employee_id = 1"))[0].n, 0);
  });

  it("CALCULATE + APPROVE through the one payroll engine: F&F items and the advance recovery priced once; the active employee untouched", async () => {
    const calculated = await calcUsecase.calculate({ year: YEAR, month: MONTH, all_eligible: true, actor: ACTOR });
    assert.equal(calculated.calculated_count, 2, JSON.stringify(calculated.results));
    const rows = await q(pool, "SELECT * FROM payrun_employee_calculation ORDER BY employee_id");
    const [a, x] = rows;
    assert.equal(a.fnf_additions, null);
    assert.equal(a.fnf_deductions, null);
    assert.equal(a.fnf_items, null);
    assert.equal(Number(x.fnf_additions), 1500);
    assert.equal(Number(x.fnf_deductions), 400.5);
    assert.equal(Number(x.advance_recovery), 1000);
    assert.equal(x.salary_days, 13);
    const p = (v) => Math.round(Number(v) * 100);
    assert.equal(
      p(x.total_earnings),
      p(x.salary_earnings) + p(x.extra_day_amount) + p(x.ot_amount) + 150000,
      "earnings = salary + extra days + OT + F&F additions"
    );
    assert.equal(
      p(x.total_employee_deductions),
      p(x.missing_hours_deduction) + p(x.employee_pf) + p(x.employee_esi) + 100000 + 40050,
      "deductions = statutory + advance recovery (once) + F&F recovery"
    );
    assert.equal(p(x.total_earnings) - p(x.total_employee_deductions) + p(x.net_pay_rounding), p(x.net_pay));

    // The statutory treatment of Leave Encashment / Notice Recovery is NOT
    // confirmed by default: the leaver's month is calculated but cannot be approved.
    assert.equal(x.is_complete, 0);
    const held = await calcUsecase.approve({ year: YEAR, month: MONTH, employee_ids: [1, 2], actor: ACTOR });
    assert.equal(held.approved_count, 1, JSON.stringify(held.results));
    assert.ok(JSON.stringify(held.results).includes("CALCULATION_INCOMPLETE"), JSON.stringify(held.results));

    // The business confirms the treatment (a reviewed change to constants/fnf.js);
    // the recalculated month is complete and is approved.
    confirmTreatment(["LEAVE_ENCASHMENT", "NOTICE_PERIOD_RECOVERY", "GRATUITY", "NOTICE_PAY"]);
    await calcUsecase.calculate({ year: YEAR, month: MONTH, employee_ids: [2], mode: "RECALCULATE", actor: ACTOR });
    const approved = await calcUsecase.approve({ year: YEAR, month: MONTH, employee_ids: [2], actor: ACTOR });
    assert.equal(approved.approved_count, 1, JSON.stringify(approved.results));
  });

  it("an approved & locked month refuses F&F changes under the lock", async () => {
    const res = await exitRepo.saveItems({ year: YEAR, month: MONTH, employee_id: 2, entries: [{ component: "GRATUITY", amount: 10 }], actor: 77, isExitMonth });
    assert.equal(res.outcome, "APPROVED_LOCKED");
    await assert.rejects(
      exitUsecase.saveItems({ year: YEAR, month: MONTH, employee_id: 2, items: [{ component: "GRATUITY", amount: 10 }], actor: ACTOR }),
      { name: "ConflictError" }
    );
  });

  it("settling before publish is refused", async () => {
    await assert.rejects(
      exitUsecase.settle({ year: YEAR, month: MONTH, employee_id: 2, payment_mode: "CASH", paid_on: "2026-09-10", actor: ACTOR }),
      /published/
    );
  });

  it("PUBLISH: the active employee gets a Salary Payslip, the leaver an F&F statement matching the approved figures", async () => {
    const out = await calcUsecase.publishAllApproved({ year: YEAR, month: MONTH, actor: ACTOR });
    assert.equal(out.published_count, 2, JSON.stringify(out.results));
    const slips = await q(pool, "SELECT * FROM payrun_payslip ORDER BY employee_id");
    assert.deepEqual(slips.map((s) => [s.employee_id, s.document_type, s.template_version]), [
      [1, "PAYSLIP", "payslip-v3"],
      [2, "FNF", "fnf-v1"],
    ]);
    const calc = (await q(pool, "SELECT net_pay, total_earnings, total_employee_deductions, calculation_hash FROM payrun_employee_calculation WHERE employee_id = 2"))[0];
    const s = JSON.parse(slips[1].snapshot_json);
    assert.equal(slips[1].snapshot_sha256, sha256(slips[1].snapshot_json));
    assert.equal(s.final.net_pay, Number(calc.net_pay).toFixed(2));
    assert.equal(s.earnings.total, Number(calc.total_earnings).toFixed(2));
    assert.equal(s.deductions.total, Number(calc.total_employee_deductions).toFixed(2));
    assert.equal(s.source.calculation_hash, calc.calculation_hash);
    assert.equal(s.fnf.last_working_day, "2026-08-16");
    assert.ok(s.earnings.lines.some((l) => l.key === "fnf_leave_encashment" && l.amount === "1500.00"));
    assert.ok(s.deductions.lines.some((l) => l.key === "fnf_notice_period_recovery" && l.amount === "400.50"));
    assert.ok(s.deductions.lines.some((l) => l.key === "advance_recovery" && l.amount === "1000.00"));
    assert.equal(JSON.parse(slips[0].snapshot_json).fnf, null);
  });

  it("TELEGRAM: the F&F text is sent; a failed send is retried once and delivered once; concurrent retries queue ONE attempt", async () => {
    await notifier.processQueue();
    assert.deepEqual(sent.map((m) => m.chatId), [9001]);
    assert.equal(sent[0].text, "Your payslip for August 2026 is now available in My Payslips.");
    const failed = await q(pool, "SELECT result FROM payrun_payslip_notification WHERE employee_id = 2");
    assert.deepEqual(failed.map((r) => r.result), ["FAILED"]);

    telegramDown = false;
    const retries = await Promise.all(
      Array.from({ length: 6 }, () => calcUsecase.retryNotification({ year: YEAR, month: MONTH, employee_ids: [2], actor: ACTOR }))
    );
    assert.equal(retries.reduce((n, r) => n + r.queued_count, 0), 1, "the pending key admits one retry");
    await notifier.processQueue();
    await notifier.processQueue();
    const toLeaver = sent.filter((m) => m.chatId === 9002);
    assert.equal(toLeaver.length, 1, "delivered exactly once");
    assert.equal(toLeaver[0].text, "Your Full & Final Settlement statement for August 2026 is now available in My Payslips.");
    const again = await calcUsecase.retryNotification({ year: YEAR, month: MONTH, employee_ids: [2], actor: ACTOR });
    assert.equal(again.queued_count, 0, "already notified: a retry sends nothing");
  });

  it("MINI APP: the leaver sees the F&F statement under its own label; never another employee's", async () => {
    const list = await miniApp.list(2);
    assert.deepEqual(list.payslips.map((p) => [p.document_type, p.label]), [["FNF", "Full & Final Settlement — August 2026"]]);
    const detail = await miniApp.detail(2, list.payslips[0].payslip_ref);
    assert.equal(detail.payslip.snapshot.document_type, "FNF");
    assert.match(detail.payslip.filename, /^FnF_Settlement_Aug-2026_2_E2\.pdf$/);
    await assert.rejects(miniApp.detail(1, list.payslips[0].payslip_ref), { name: "NotFoundError" });
    const pdf = await miniApp.pdf(2, list.payslips[0].payslip_ref);
    assert.match(pdf.buffer.toString(), /Full &amp; Final Settlement/);
  });

  it("SETTLE: eight simultaneous Settle requests record ONE settlement and ONE event", async () => {
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        exitUsecase.settle({ year: YEAR, month: MONTH, employee_id: 2, payment_mode: "BANK", payment_reference: "UTR998877", paid_on: "2026-09-10", actor: ACTOR })
      )
    );
    assert.equal(attempts.filter((a) => a.status === "fulfilled").length, 1, JSON.stringify(attempts.map((a) => a.reason && a.reason.message)));
    assert.ok(attempts.filter((a) => a.status === "rejected").every((a) => /already/.test(a.reason.message)));
    const cases = await q(pool, "SELECT * FROM employee_fnf_settlement");
    assert.equal(cases.length, 1);
    assert.equal(cases[0].status, "SETTLED");
    assert.equal(Number(cases[0].period_id) > 0, true, "linked to the closed employment period");
    const calc = (await q(pool, "SELECT net_pay, payrun_employee_id FROM payrun_employee_calculation WHERE employee_id = 2"))[0];
    assert.equal(Number(cases[0].settled_net_amount), Number(calc.net_pay));
    assert.equal((await q(pool, "SELECT COUNT(*) n FROM employee_fnf_settlement_event WHERE event_type = 'SETTLED'"))[0].n, 1);
  });

  it("a SETTLED F&F month cannot be unpublished or unlocked; the active employee's month still can", async () => {
    const unpub = await act("UNPUBLISH", [2]);
    assert.equal(unpub.blocked_count, 1, JSON.stringify(unpub.results));
    assert.match(unpub.results[0].message, /settled/);
    const slip = (await q(pool, "SELECT status FROM payrun_payslip WHERE employee_id = 2"))[0];
    assert.equal(slip.status, "ACTIVE", "the paid document stays published");
    const other = await act("UNPUBLISH", [1]);
    assert.equal(other.unpublished_count, 1, JSON.stringify(other.results));
  });

  it("REOPEN (with a reason) is the one way back; a later settlement of the same exit is again single", async () => {
    await exitUsecase.reopen({ year: YEAR, month: MONTH, employee_id: 2, reason: "Wrong UTR recorded", actor: ACTOR });
    const unpub = await act("UNPUBLISH", [2]);
    assert.equal(unpub.unpublished_count, 1, JSON.stringify(unpub.results));
    const republish = await act("PUBLISH", [2]);
    assert.equal(republish.published_count, 1, JSON.stringify(republish.results));
    await exitUsecase.settle({ year: YEAR, month: MONTH, employee_id: 2, payment_mode: "BANK", payment_reference: "UTR111", paid_on: "2026-09-11", actor: ACTOR });
    const events = await q(pool, "SELECT event_type FROM employee_fnf_settlement_event ORDER BY fnf_settlement_event_id");
    assert.deepEqual(events.map((e) => e.event_type), ["SETTLED", "REOPENED", "SETTLED"]);
    const slips = await q(pool, "SELECT payslip_version, status FROM payrun_payslip WHERE employee_id = 2 ORDER BY payslip_version");
    assert.deepEqual(slips.map((s) => [s.payslip_version, s.status]), [[1, "ARCHIVED"], [2, "ACTIVE"]], "the earlier document is kept");
    const settled = (await q(pool, "SELECT settled_payslip_id FROM employee_fnf_settlement"))[0];
    const active = (await q(pool, "SELECT payslip_id FROM payrun_payslip WHERE employee_id = 2 AND status = 'ACTIVE'"))[0];
    assert.equal(settled.settled_payslip_id, active.payslip_id, "the settlement names the document actually paid");
  });

  it("the month list shows each exit's stage; the active employee is not listed", async () => {
    const m = await exitUsecase.getMonth({ year: YEAR, month: MONTH });
    assert.deepEqual(m.rows.map((r) => [r.employee_id, r.stage, r.document_type]), [[2, "SETTLED", "FNF"]]);
  });

  it("an exit recorded AFTER the month was initialized is listed with a warning, never dropped", async () => {
    // Employee 4: initialized for August with no exit, then resigned on 20 Aug.
    await q(pool, `INSERT INTO new_employee (employee_id, employee_name, store_id, resignation_date) VALUES (4, 'E4', 2, '2026-08-20')`);
    await q(pool, `INSERT INTO payrun_employee (period_year, period_month, employee_id, employee_name, store_id, store_name,
                     monthly_gross, pay_type, pay_type_source)
                   VALUES (?, ?, 4, 'E4', 2, 'Ecr', 10000, 'BANK', 'EMPLOYEE_MASTER')`, [YEAR, MONTH]);
    await q(pool, `INSERT INTO employee_employment_period (employee_id, period_no, period_state, joined_on, ended_on, end_reason_type)
                   VALUES (4, 1, 'closed', '2026-02-02', '2026-08-20', 'resignation')`);
    const m = await exitUsecase.getMonth({ year: YEAR, month: MONTH });
    const row = m.rows.find((r) => r.employee_id === 4);
    assert.ok(row, "listed");
    assert.equal(row.stage, "NOT_IN_PAYROLL");
    assert.match(row.warning, /initialized before the resignation was recorded/);
    assert.equal(m.rows.find((r) => r.employee_id === 2).warning, null);
  });

  it("REJOIN: a second exit is a separate case; the first settlement, interview and rehire history are untouched", async () => {
    const first = (await q(pool, "SELECT fnf_settlement_id FROM employee_fnf_settlement"))[0].fnf_settlement_id;
    await exitUsecase.saveInterview(2, { exit_date: "2026-08-16", interview_date: "2026-08-16", primary_reason: "RELOCATION", rating_job_satisfaction: 4 }, ACTOR);
    await exitUsecase.assessRehire(2, { exit_date: "2026-08-16", eligibility: "YES" }, { canManage: true, canOverride: false }, ACTOR);

    // Rejoined 1 Oct, resigned 20 Dec: a new employment period and a new exit.
    await q(pool, `INSERT INTO employee_employment_period (employee_id, period_no, period_state, joined_on, ended_on, end_reason_type)
                   VALUES (2, 2, 'closed', '2026-10-01', '2026-12-20', 'resignation')`);
    const ids = await Promise.all(Array.from({ length: 10 }, () => exitRepo.ensureCase({ employee_id: 2, exit_date: "2026-12-20" })));
    assert.equal(new Set(ids).size, 1, "concurrent creation of one exit's case yields one row");
    assert.notEqual(ids[0], first);
    exitUsecase = buildExit(exitRepo, { today: () => "2027-01-05" });
    await exitUsecase.assessRehire(2, { exit_date: "2026-12-20", eligibility: "CONDITIONAL", conditions: "Different outlet only" }, { canManage: true, canOverride: false }, ACTOR);
    await exitUsecase.assessRehire(2, { exit_date: "2026-12-20", eligibility: "NO", override_reason: "Shortage found" }, { canManage: false, canOverride: true }, ACTOR);

    const exits = await exitUsecase.employeeExits(2);
    assert.deepEqual(exits.exits.map((e) => [e.exit_date, e.settlement_status, e.has_interview, e.rehire && e.rehire.eligibility, e.rehire_history_count]), [
      ["2026-12-20", "PENDING", false, "NO", 2],
      ["2026-08-16", "SETTLED", true, "YES", 1],
    ]);
    const hist = await q(pool, "SELECT eligibility, is_override, override_reason FROM employee_rehire_assessment WHERE fnf_settlement_id = ? ORDER BY 1", [ids[0]]);
    assert.equal(hist.length, 2, "an override is a new row; the earlier assessment is kept");
    assert.equal((await exitUsecase.rehireStatus(2)).rehire.eligibility, "NO");
  });

  it("REPORTS: the payroll register's F&F columns execute over real SQL and show earnings, recoveries and settlement", async () => {
    const rq = require("../utils/payroll_report_query");
    const ADMIN = { userId: 5, employeeId: 50, isAdmin: true, permissions: [] };
    const keys = ["employee_id", "last_working_day", "fnf_additions", "fnf_deductions", "gross_salary", "net_pay",
      "fnf_month", "fnf_settlement_status", "fnf_paid_on", "fnf_payment_mode", "fnf_payment_reference", "fnf_settled_amount"];
    const { fields } = rq.resolveFields(keys, ADMIN);
    const built = rq.buildQuery({ reportType: "PAYROLL_REGISTER", fields, filters: rq.resolveFilters({}), period: rq.periodOf(YEAR, MONTH), store_ids: null });
    const rows = await q(pool, built.sql, built.params);
    const byId = new Map(rows.map((r) => rq.presentRow(r, fields)).map((r) => [Number(r.employee_id), r]));
    const leaver = byId.get(2);
    assert.equal(leaver.fnf_month, "Yes");
    assert.equal(leaver.fnf_additions, 1500);
    assert.equal(leaver.fnf_deductions, 400.5);
    assert.equal(leaver.fnf_settlement_status, "Settled");
    assert.equal(leaver.fnf_payment_reference, "UTR111");
    const net = (await q(pool, "SELECT net_pay FROM payrun_employee_calculation WHERE employee_id = 2"))[0].net_pay;
    assert.equal(leaver.fnf_settled_amount, Number(net));
    const active = byId.get(1);
    assert.equal(active.fnf_month, "No");
    assert.equal(active.fnf_settlement_status, null);
    assert.equal(active.fnf_additions, null);
  });

  it("REHIRE GATE SQL: reads the NEWEST assessment of the exit being rejoined from; records the approved exception", async () => {
    const tx = (fn) => exitRepo.withTransaction((conn) => fn({ query: (sql, params) => new Promise((r, j) => conn.query(sql, params, (e, rows) => (e ? j(e) : r(rows)))) }));
    // Exit 2026-12-20: CONDITIONAL, then overridden to NO -> the gate sees NO.
    const dec = await tx((t) => exitRepo.rehireForExitTx(t, 2, "2026-12-20"));
    assert.equal(dec.eligibility, "NO");
    // Exit 2026-08-16: YES.
    assert.equal((await tx((t) => exitRepo.rehireForExitTx(t, 2, "2026-08-16"))).eligibility, "YES");
    // No assessment / no exit date: null (the ordinary rejoin).
    assert.equal(await tx((t) => exitRepo.rehireForExitTx(t, 1, "2026-08-31")), null);
    assert.equal(await tx((t) => exitRepo.rehireForExitTx(t, 2, null)), null);
    await tx((t) => exitRepo.recordRehireExceptionTx(t, {
      fnf_settlement_id: dec.fnf_settlement_id, rehire_assessment_id: dec.rehire_assessment_id, employee_id: 2,
      eligibility: "NO", conditions: null, reason: "Shortage repaid in full; GM approved", rejoin_date: "2027-02-01", approved_by: 55,
    }));
    const audit = await exitRepo.listRehireExceptions(2);
    assert.deepEqual(audit.map((a) => [a.eligibility, a.rejoin_date, a.approved_by]), [["NO", "2027-02-01", 55]]);
  });

  it("the database refuses a second case for the same exit, and one payroll month settling two exits", async () => {
    await assert.rejects(q(pool, "INSERT INTO employee_fnf_settlement (employee_id, exit_date) VALUES (2, '2026-08-16')"), /ER_DUP_ENTRY/);
    const pe = (await q(pool, "SELECT payrun_employee_id FROM employee_fnf_settlement WHERE status = 'SETTLED'"))[0].payrun_employee_id;
    await assert.rejects(
      q(pool, "UPDATE employee_fnf_settlement SET payrun_employee_id = ? WHERE exit_date = '2026-12-20'", [pe]),
      /ER_DUP_ENTRY/
    );
  });

  it("P0 LATE EXIT: a resignation recorded after initialization blocks approval and publish until reconciled; the month then publishes an F&F", async () => {
    // Employee 5: initialized and approved for August with NO exit...
    await seedEmployee(5, { presentDays: 26 });
    assert.equal((await calcUsecase.calculate({ year: YEAR, month: MONTH, employee_ids: [5], actor: ACTOR })).calculated_count, 1);
    assert.equal((await calcUsecase.approve({ year: YEAR, month: MONTH, employee_ids: [5], actor: ACTOR })).approved_count, 1);
    // ...then HR records the resignation, last working day 25 Aug.
    await q(pool, "UPDATE new_employee SET resignation_date = '2026-08-25' WHERE employee_id = 5");
    await q(pool, `INSERT INTO employee_employment_period (employee_id, period_no, period_state, joined_on, ended_on, end_reason_type)
                   VALUES (5, 1, 'closed', '2026-02-02', '2026-08-25', 'resignation')`);

    // Publish refuses: the approved month is the wrong document.
    const pub = await act("PUBLISH", [5]);
    assert.equal(pub.blocked_count, 1, JSON.stringify(pub.results));
    assert.match(pub.results[0].message, /exit was recorded or changed after this month was initialized/);
    assert.equal((await q(pool, "SELECT COUNT(*) n FROM payrun_payslip WHERE employee_id = 5"))[0].n, 0, "no regular payslip released");

    // The F&F list flags it; reconcile is refused while a calculation exists.
    const listed = (await exitUsecase.getMonth({ year: YEAR, month: MONTH })).rows.find((r) => r.employee_id === 5);
    assert.equal(listed.needs_reconcile, true);
    await assert.rejects(exitUsecase.reconcileExit({ year: YEAR, month: MONTH, employee_id: 5, actor: ACTOR }), /Unlock it and reset/);

    // The explicit correction: Unlock -> (blocked from re-approval) -> Reset -> Reconcile -> Calculate -> Approve -> Publish.
    assert.equal((await act("UNLOCK", [5])).unlocked_count, 1);
    const row = (await calcUsecase.getMonth({ year: YEAR, month: MONTH })).rows.find((r) => r.employee_id === 5);
    assert.ok(row.blockers.some((b) => b.code === "EXIT_NOT_RECONCILED"), JSON.stringify(row.blockers));
    assert.notEqual(row.status, "READY_FOR_APPROVAL");
    assert.equal((await calcUsecase.approve({ year: YEAR, month: MONTH, employee_ids: [5], actor: ACTOR })).approved_count, 0);
    await assert.rejects(exitUsecase.reconcileExit({ year: YEAR, month: MONTH, employee_id: 5, actor: ACTOR }), /Reset the calculation first/);
    await calcUsecase.reset({ year: YEAR, month: MONTH, employee_ids: [5], reason: "OTHER", remark: "exit recorded late", mode: "INDIVIDUAL", actor: ACTOR });
    const rec = await exitUsecase.reconcileExit({ year: YEAR, month: MONTH, employee_id: 5, actor: ACTOR });
    assert.equal(rec.outcome, "RECONCILED");
    assert.deepEqual([rec.old_exit_date, rec.new_exit_date], [null, "2026-08-25"]);
    const audit = await q(pool, "SELECT DATE_FORMAT(new_resignation_date, '%Y-%m-%d') d, actor_employee_id FROM payrun_exit_reconcile_audit WHERE employee_id = 5");
    assert.deepEqual(audit.map((a) => [a.d, a.actor_employee_id]), [["2026-08-25", 77]]);
    await assert.rejects(exitUsecase.reconcileExit({ year: YEAR, month: MONTH, employee_id: 5, actor: ACTOR }), /already carries/);

    assert.equal((await calcUsecase.calculate({ year: YEAR, month: MONTH, employee_ids: [5], actor: ACTOR })).calculated_count, 1);
    const fresh = (await calcUsecase.getMonth({ year: YEAR, month: MONTH })).rows.find((r) => r.employee_id === 5);
    assert.equal(fresh.is_fnf, true);
    assert.equal(fresh.exit_reconcile, null);
    assert.equal((await calcUsecase.approve({ year: YEAR, month: MONTH, employee_ids: [5], actor: ACTOR })).approved_count, 1);
    assert.equal((await act("PUBLISH", [5])).published_count, 1);
    const slip = (await q(pool, "SELECT document_type FROM payrun_payslip WHERE employee_id = 5 AND status = 'ACTIVE'"))[0];
    assert.equal(slip.document_type, "FNF");
  });

  it("P0 OUTSTANDING OT: approved OT pending settlement blocks the F&F publish and settle; unlock + recalculate pays it exactly once; cancelled/rejected OT is never paid", async () => {
    // Employee 6 leaves on 20 Aug; the F&F month is approved & locked.
    await seedEmployee(6, { exit: "2026-08-20", presentDays: 15 });
    await q(pool, `INSERT INTO employee_employment_period (employee_id, period_no, period_state, joined_on, ended_on, end_reason_type)
                   VALUES (6, 1, 'closed', '2026-02-02', '2026-08-20', 'resignation')`);
    await calcUsecase.calculate({ year: YEAR, month: MONTH, employee_ids: [6], actor: ACTOR });
    assert.equal((await calcUsecase.approve({ year: YEAR, month: MONTH, employee_ids: [6], actor: ACTOR })).approved_count, 1);
    // OT for 12 Aug is then APPROVED (after the lock) -> a PENDING settlement row, priced at approval.
    const approvedReq = await q(pool, `INSERT INTO attendance_approval_request (request_type, requested_for_employee_id, attendance_date, status, approved_ot_minutes)
                                       VALUES ('OT', 6, '2026-08-12', 'APPROVED', 120)`);
    await q(pool, `INSERT INTO attendance_ot_late_settlement (attendance_approval_request_id, employee_id, attendance_date, source_year, source_month,
                     eligible_ot_minutes, approved_ot_minutes, source_daily_rate, nrm_minutes, ot_hourly_rate, amount)
                   VALUES (?, 6, '2026-08-12', 2026, 8, 120, 120, 384.62, 480, 48.08, 96.16)`, [approvedReq.insertId]);
    // A REJECTED request never gets a settlement row; a CANCELLED one must never be paid.
    await q(pool, `INSERT INTO attendance_approval_request (request_type, requested_for_employee_id, attendance_date, status, approved_ot_minutes)
                   VALUES ('OT', 6, '2026-08-13', 'REJECTED', NULL)`);
    const cancelledReq = await q(pool, `INSERT INTO attendance_approval_request (request_type, requested_for_employee_id, attendance_date, status, approved_ot_minutes)
                                        VALUES ('OT', 6, '2026-08-14', 'APPROVED', 60)`);
    await q(pool, `INSERT INTO attendance_ot_late_settlement (attendance_approval_request_id, employee_id, attendance_date, source_year, source_month,
                     eligible_ot_minutes, approved_ot_minutes, source_daily_rate, nrm_minutes, ot_hourly_rate, amount, settlement_status)
                   VALUES (?, 6, '2026-08-14', 2026, 8, 60, 60, 384.62, 480, 48.08, 48.08, 'CANCELLED')`, [cancelledReq.insertId]);

    const listed = (await exitUsecase.getMonth({ year: YEAR, month: MONTH })).rows.find((r) => r.employee_id === 6);
    assert.deepEqual(listed.outstanding_ot, { items: 1, minutes: 120, amount: 96.16 });
    const pub = await act("PUBLISH", [6]);
    assert.equal(pub.blocked_count, 1, JSON.stringify(pub.results));
    assert.match(pub.results[0].message, /approved OT is still pending settlement/);

    // Unlock -> Recalculate claims the item into the F&F -> Approve -> Publish -> Settle.
    assert.equal((await act("UNLOCK", [6])).unlocked_count, 1);
    const recalc = await calcUsecase.calculate({ year: YEAR, month: MONTH, employee_ids: [6], mode: "RECALCULATE", actor: ACTOR });
    assert.equal(recalc.results[0].result, "RECALCULATED", JSON.stringify(recalc.results));
    const calcRow = (await q(pool, "SELECT payrun_calculation_id, prior_month_ot_amount, prior_month_ot FROM payrun_employee_calculation WHERE employee_id = 6"))[0];
    assert.equal(Number(calcRow.prior_month_ot_amount), 96.16);
    const paid = JSON.parse(typeof calcRow.prior_month_ot === "string" ? calcRow.prior_month_ot : JSON.stringify(calcRow.prior_month_ot));
    assert.deepEqual(paid.map((i) => i.attendance_date), ["2026-08-12"], "the cancelled item is not paid");
    assert.equal((await calcUsecase.approve({ year: YEAR, month: MONTH, employee_ids: [6], actor: ACTOR })).approved_count, 1);
    assert.equal((await act("PUBLISH", [6])).published_count, 1);
    const snap = JSON.parse((await q(pool, "SELECT snapshot_json FROM payrun_payslip WHERE employee_id = 6 AND status = 'ACTIVE'"))[0].snapshot_json);
    assert.ok(snap.earnings.lines.some((l) => /OT Approved After Lock/.test(l.label) && l.amount === "96.16"), JSON.stringify(snap.earnings.lines));
    const items = await q(pool, "SELECT attendance_date, settlement_status, settlement_payrun_calculation_id FROM attendance_ot_late_settlement WHERE employee_id = 6 ORDER BY attendance_date");
    assert.deepEqual(items.map((i) => [i.settlement_status, i.settlement_payrun_calculation_id]), [
      ["SETTLED", calcRow.payrun_calculation_id],
      ["CANCELLED", null],
    ]);
    assert.equal((await exitUsecase.settle({ year: YEAR, month: MONTH, employee_id: 6, payment_mode: "CASH", paid_on: "2026-09-10", actor: ACTOR })).outcome, "SETTLED");
    assert.equal((await exitUsecase.getMonth({ year: YEAR, month: MONTH })).rows.find((r) => r.employee_id === 6).outstanding_ot, null);
  });

  it("P0 OUTSTANDING OT AFTER SETTLEMENT: Settle refuses while approved OT is pending; the settled month needs reopen to pay it", async () => {
    // OT for 18 Aug approved AFTER employee 6's F&F was settled.
    const req = await q(pool, `INSERT INTO attendance_approval_request (request_type, requested_for_employee_id, attendance_date, status, approved_ot_minutes)
                               VALUES ('OT', 6, '2026-08-18', 'APPROVED', 60)`);
    await q(pool, `INSERT INTO attendance_ot_late_settlement (attendance_approval_request_id, employee_id, attendance_date, source_year, source_month,
                     eligible_ot_minutes, approved_ot_minutes, source_daily_rate, nrm_minutes, ot_hourly_rate, amount)
                   VALUES (?, 6, '2026-08-18', 2026, 8, 60, 60, 384.62, 480, 48.08, 48.08)`, [req.insertId]);
    const row = (await exitUsecase.getMonth({ year: YEAR, month: MONTH })).rows.find((r) => r.employee_id === 6);
    assert.equal(row.stage, "SETTLED");
    assert.equal(row.outstanding_ot.items, 1, "visible on the settled row");
    // Reopen, and a re-settle is refused until it is paid.
    await exitUsecase.reopen({ year: YEAR, month: MONTH, employee_id: 6, reason: "late OT", actor: ACTOR });
    await assert.rejects(
      exitUsecase.settle({ year: YEAR, month: MONTH, employee_id: 6, payment_mode: "CASH", paid_on: "2026-09-12", actor: ACTOR }),
      /pending settlement/
    );
  });

  it("MIGRATION down -> up: removes only this feature's schema; every payroll figure and payslip survives", async () => {
    const before = await q(pool, "SELECT employee_id, net_pay, calculation_hash, status FROM payrun_employee_calculation ORDER BY employee_id");
    const slipsBefore = await q(pool, "SELECT payslip_id, snapshot_sha256, status FROM payrun_payslip ORDER BY payslip_id");
    await q(pool, fs.readFileSync(path.join(SQLS, FNF_DOWN), "utf8"));
    for (const t of ["payrun_fnf_item", "employee_fnf_settlement", "employee_exit_interview", "employee_rehire_assessment"]) {
      assert.equal((await q(pool, "SHOW TABLES LIKE ?", [t])).length, 0, t);
    }
    assert.equal((await q(pool, "SHOW COLUMNS FROM payrun_payslip LIKE 'document_type'")).length, 0);
    assert.deepEqual(await q(pool, "SELECT employee_id, net_pay, calculation_hash, status FROM payrun_employee_calculation ORDER BY employee_id"), before);
    assert.deepEqual(await q(pool, "SELECT payslip_id, snapshot_sha256, status FROM payrun_payslip ORDER BY payslip_id"), slipsBefore);
    await q(pool, fs.readFileSync(path.join(SQLS, FNF_UP), "utf8"));
    const types = await q(pool, "SELECT DISTINCT document_type FROM payrun_payslip");
    assert.deepEqual(types.map((t) => t.document_type), ["PAYSLIP"], "re-added with its default; nothing else written");
  });
});
