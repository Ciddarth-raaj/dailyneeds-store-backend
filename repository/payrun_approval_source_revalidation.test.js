/**
 * THE REVERSE RACE: an approval may not be granted against attendance that
 * moved after the approval was prepared.
 *
 *   node --test repository/payrun_approval_source_revalidation.test.js
 *
 * Attendance writers take the `payrun_employee_calculation` row `FOR UPDATE`
 * before they modify attendance, and the approval takes the same row. That
 * settles one ordering - approval first, attendance refused - and leaves the
 * other to this file:
 *
 *   1  the usecase assembles the month and finds the employee READY
 *   2  an attendance write takes the payrun row, rewrites attendance, commits
 *   3  the approval wakes, takes the row lock, and finds `calculation_hash`
 *      unchanged - because nothing recalculated the PAYRUN
 *   4  without a source re-read it would approve stale figures
 *
 * So the attendance markers are read again after the lock and compared with
 * the ones the stored calculation carries. The fake below is the whole point:
 * the attendance source it returns can CHANGE between the pre-approval read
 * and the locked revalidation, which is precisely the window.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const buildRepo = require("./payrun_calculation");
const { SOURCE_KEYS, ATTENDANCE_SOURCE_KEYS } = require("../utils/payrun_calculation");

const EMP = 42;
const YEAR = 2026;
const MONTH = 8;

/** What the stored payrun calculation says attendance was when it ran. */
const STORED = {
  payrun_calculation_id: 900,
  payrun_employee_id: 500,
  employee_id: EMP,
  status: "CALCULATED",
  calculation_hash: "hash-of-the-figures",
  calculation_version: 1,
  calculation_revision: 3,
  source_hash: "source-hash",
  net_pay: "26000.00",
  attendance_monthly_payroll_id: 77,
  attendance_payroll_version: 2,
  attendance_calculated_at: "2026-09-01 10:00:00.000",
  approved_ot_minutes: 120,
  effective_nrm_minutes: 660,
  effective_nrm_source: "SHIFT",
  ot_groups: JSON.stringify([{ nrm_minutes: 660, nrm_source: "SHIFT", approved_ot_minutes: 120 }]),
};

/** The attendance the database would answer with NOW. */
const CURRENT_ATTENDANCE = {
  attendance_monthly_payroll_id: 77,
  employee_id: EMP,
  payroll_version: 2,
  calculated_at: "2026-09-01 10:00:00.000",
  approved_ot_minutes: 120,
};

const CURRENT_NRM = [
  {
    employee_id: EMP,
    nrm_minutes: 660,
    break_allowance_source: "SHIFT",
    day_count: 26,
    approved_ot_minutes: 120,
  },
];

/**
 * A pool that records statements and answers each table from the state the
 * test hands it. `attendance` and `nrm` may be REPLACED mid-run to stand in
 * for an attendance write that commits while the approval waits.
 */
function fakePool({ row = { ...STORED }, attendance = { ...CURRENT_ATTENDANCE }, nrm = CURRENT_NRM } = {}) {
  const state = { row, attendance, nrm };
  const log = [];
  const connection = {
    query(sql, params, cb) {
      const text = String(sql).replace(/\s+/g, " ").trim();
      log.push({ sql: text, params });

      if (/FROM payrun_employee_calculation/i.test(text)) {
        cb(null, state.row ? [state.row] : []);
        return;
      }
      if (/FROM attendance_monthly_payroll/i.test(text)) {
        cb(null, state.attendance ? [state.attendance] : []);
        return;
      }
      if (/FROM attendance_day_calculation/i.test(text)) {
        cb(null, state.nrm || []);
        return;
      }
      cb(null, { affectedRows: 1, insertId: 1 });
    },
    beginTransaction: (cb) => { log.push({ sql: "BEGIN" }); cb(null); },
    commit: (cb) => { log.push({ sql: "COMMIT" }); cb(null); },
    rollback: (cb) => { log.push({ sql: "ROLLBACK" }); cb(); },
    release: () => { log.push({ sql: "RELEASE" }); },
  };
  return {
    state,
    log,
    getConnection: (cb) => cb(null, connection),
    query: (sql, params, cb) => connection.query(sql, params, cb),
  };
}

const approve = (pool, entry = { employee_id: EMP, calculation_hash: STORED.calculation_hash }) =>
  buildRepo(pool).approve({ year: YEAR, month: MONTH, employees: [entry], approved_by: 9 });

const statements = (log) => log.map((e) => (/^[A-Z]+$/.test(e.sql) ? e.sql : e.sql.split(" ")[0]));
const approvalUpdates = (log) =>
  log.filter((e) => /^UPDATE payrun_employee_calculation/i.test(e.sql));
const auditInserts = (log) =>
  log.filter((e) => /INSERT INTO payrun_employee_calculation_audit/i.test(e.sql));

/* ============================================ where the check happens ===== */

describe("the approval locks the row, THEN reads the sources", () => {
  it("takes the payrun row FOR UPDATE", async () => {
    const pool = fakePool();
    await approve(pool);
    const [lock] = pool.log.filter((e) => /FROM payrun_employee_calculation/i.test(e.sql));
    assert.match(lock.sql, /FOR UPDATE$/);
    assert.deepEqual(lock.params, [YEAR, MONTH, EMP]);
  });

  it("re-reads the ATTENDANCE sources AFTER that lock and BEFORE the status changes", async () => {
    const pool = fakePool();
    await approve(pool);

    const at = (pattern) => pool.log.findIndex((e) => pattern.test(e.sql));
    const lockAt = at(/FROM payrun_employee_calculation.*FOR UPDATE/i);
    const monthlyAt = at(/FROM attendance_monthly_payroll/i);
    const nrmAt = at(/FROM attendance_day_calculation/i);
    const updateAt = at(/^UPDATE payrun_employee_calculation/i);

    assert.ok(lockAt >= 0 && monthlyAt > lockAt, "the monthly attendance row is read after the lock");
    assert.ok(nrmAt > lockAt, "and so is the NRM evidence");
    assert.ok(updateAt > monthlyAt && updateAt > nrmAt, "and both before the approval is written");
  });

  it("reads them on the SAME connection, inside the same transaction", async () => {
    const pool = fakePool();
    await approve(pool);
    const order = statements(pool.log);
    assert.equal(order[0], "BEGIN");
    assert.ok(order.indexOf("COMMIT") > order.lastIndexOf("SELECT"));
    // Nothing is read before the transaction opens.
    assert.ok(!pool.log.slice(0, 1).some((e) => /^SELECT/i.test(e.sql)));
  });

  it("does not rely on calculation_hash alone", async () => {
    // The hash is unchanged and matches - and the approval is still refused,
    // because what moved is attendance, which the hash cannot see.
    const pool = fakePool({
      attendance: { ...CURRENT_ATTENDANCE, payroll_version: 3 },
    });
    const [result] = await approve(pool);
    assert.equal(result.outcome, "SOURCE_MOVED");
    assert.equal(pool.state.row.calculation_hash, STORED.calculation_hash, "the hash never moved");
  });
});

/* ================================================= what it decides ======== */

describe("unchanged attendance approves; moved attendance does not", () => {
  it("approves when the sources still match", async () => {
    const pool = fakePool();
    const [result] = await approve(pool);
    assert.equal(result.outcome, "APPROVED");
    assert.equal(approvalUpdates(pool.log).length, 1);
    assert.equal(auditInserts(pool.log).length, 1);
    assert.ok(pool.log.some((e) => e.sql === "COMMIT"));
  });

  for (const [what, change] of [
    ["the monthly roll-up was rewritten", { payroll_version: 3 }],
    ["the roll-up was recalculated at a new time", { calculated_at: "2026-09-20 08:00:00.000" }],
    ["a different monthly row now answers", { attendance_monthly_payroll_id: 78 }],
    ["approved OT changed", { approved_ot_minutes: 180 }],
  ]) {
    it(`refuses when ${what}`, async () => {
      const pool = fakePool({ attendance: { ...CURRENT_ATTENDANCE, ...change } });
      const [result] = await approve(pool);
      assert.equal(result.outcome, "SOURCE_MOVED");
      assert.ok(result.changed.length > 0, "and says which marker moved");
    });
  }

  it("refuses when the effective NRM moved - a break override or Extra Break Hours", async () => {
    // Exactly the Extra Break Hours case: the day rows were recalculated, the
    // NRM came down, and the OT rate the payrun priced is no longer right.
    const pool = fakePool({
      nrm: [{ ...CURRENT_NRM[0], nrm_minutes: 630, break_allowance_source: "EMPLOYEE_OVERRIDE" }],
    });
    const [result] = await approve(pool);
    assert.equal(result.outcome, "SOURCE_MOVED");
    assert.ok(result.changed.includes("effective_nrm_minutes"));
  });

  it("refuses when the OT SPLIT moved even though the totals did not", async () => {
    const pool = fakePool({
      nrm: [
        { employee_id: EMP, nrm_minutes: 660, break_allowance_source: "SHIFT", day_count: 20, approved_ot_minutes: 60 },
        { employee_id: EMP, nrm_minutes: 480, break_allowance_source: "SHIFT", day_count: 6, approved_ot_minutes: 60 },
      ],
    });
    const [result] = await approve(pool);
    assert.equal(result.outcome, "SOURCE_MOVED");
    assert.ok(result.changed.includes("ot_groups"));
  });

  it("A STALE SOURCE NEVER BECOMES APPROVED_LOCKED, and leaves no audit row", async () => {
    const pool = fakePool({ attendance: { ...CURRENT_ATTENDANCE, payroll_version: 9 } });
    const [result] = await approve(pool);

    assert.equal(result.outcome, "SOURCE_MOVED");
    assert.equal(approvalUpdates(pool.log).length, 0, "no status was changed");
    assert.equal(auditInserts(pool.log).length, 0, "and nothing was recorded as approved");
    assert.ok(!pool.log.some((e) => /APPROVED_LOCKED/.test(String(e.sql))));
  });
});

/* ===================================== the race, reproduced in the harness  */

describe("READY before the lock, attendance changes, BLOCKED after the lock", () => {
  it("reproduces the ordering the row lock forces", async () => {
    const pool = fakePool();
    const repo = buildRepo(pool);

    // 1. THE PRE-APPROVAL READ: what `_assemble`/`_present` saw. The sources
    //    match the stored calculation, so the employee is READY.
    const { attendanceSourceChanges, sourceMarkers, resolveEffectiveNrm } = require("../utils/payrun_calculation");
    const before = attendanceSourceChanges(
      STORED,
      sourceMarkers({ attendance: pool.state.attendance, nrm: resolveEffectiveNrm(CURRENT_NRM) })
    );
    assert.deepEqual(before, [], "READY: nothing had moved when the approval was prepared");

    // 2. AN ATTENDANCE WRITE COMMITS while the approval waits for the row -
    //    it took this same payrun row FOR UPDATE, rewrote the month and
    //    committed. Nothing about the PAYRUN row changed.
    pool.state.attendance = { ...CURRENT_ATTENDANCE, payroll_version: 3, calculated_at: "2026-09-21 09:00:00.000" };
    pool.state.nrm = [{ ...CURRENT_NRM[0], nrm_minutes: 630, break_allowance_source: "EMPLOYEE_OVERRIDE" }];

    // 3. THE APPROVAL NOW WAKES, takes the lock and revalidates.
    const [result] = await repo.approve({
      year: YEAR,
      month: MONTH,
      employees: [{ employee_id: EMP, calculation_hash: STORED.calculation_hash }],
      approved_by: 9,
    });

    assert.equal(result.outcome, "SOURCE_MOVED", "BLOCKED, not approved");
    assert.equal(approvalUpdates(pool.log).length, 0);
    assert.equal(auditInserts(pool.log).length, 0);
  });
});

/* ============================================= what must not regress ====== */

describe("the existing outcomes are unchanged", () => {
  it("an already locked row is ALREADY_LOCKED, and no source read is wasted on it", async () => {
    const pool = fakePool({ row: { ...STORED, status: "APPROVED_LOCKED" } });
    const [result] = await approve(pool);
    assert.equal(result.outcome, "ALREADY_LOCKED");
    assert.equal(approvalUpdates(pool.log).length, 0);
    assert.ok(!pool.log.some((e) => /FROM attendance_monthly_payroll/i.test(e.sql)));
  });

  it("no row at all is NO_CALCULATION", async () => {
    const pool = fakePool({ row: null });
    const [result] = await approve(pool);
    assert.equal(result.outcome, "NO_CALCULATION");
  });

  it("a recalculated payrun row is still CALCULATION_MOVED, checked before the sources", async () => {
    const pool = fakePool();
    const [result] = await approve(pool, { employee_id: EMP, calculation_hash: "what-the-screen-showed" });
    assert.equal(result.outcome, "CALCULATION_MOVED");
    assert.equal(approvalUpdates(pool.log).length, 0);
  });
});

describe("the attendance marker subset is the source set's, not a second one", () => {
  it("every attendance key is a SOURCE_KEYS key", () => {
    for (const key of ATTENDANCE_SOURCE_KEYS) assert.ok(SOURCE_KEYS.includes(key), key);
  });

  it("it covers every attendance-derived marker the source set has", () => {
    // If a new attendance source is marked and not listed, the approval would
    // stop watching it at the one moment it matters most.
    const attendanceish = SOURCE_KEYS.filter(
      (k) => /^attendance_|^approved_ot_minutes$|^effective_nrm_|^ot_groups$/.test(k)
    );
    assert.deepEqual([...ATTENDANCE_SOURCE_KEYS].sort(), attendanceish.sort());
  });

  it("the repository builds them with the shared sourceMarkers, not by hand", () => {
    const source = fs.readFileSync(path.join(__dirname, "payrun_calculation.js"), "utf8");
    assert.match(source, /sourceMarkers\(\{ attendance, nrm \}\)/);
    assert.match(source, /attendanceSourceChanges\(stored, current\)/);
  });
});

/* ============ Close for Payroll does NOT reach this gate ================= */

/**
 * THE TWO FEATURES MEET HERE, AND THIS IS WHERE IT MATTERS MOST.
 *
 * "Close Attendance for Payroll" lets payroll accept UNSETTLED attendance as
 * the basis for a month - it satisfies the readiness blocker that would
 * otherwise stop an approval. The obvious fear is that it becomes a way to
 * approve a month whose attendance has since MOVED, which is precisely what
 * this revalidation exists to refuse.
 *
 * IT CANNOT, AND THE REASON IS STRUCTURAL RATHER THAN CAREFUL. The close is
 * stored on `payrun_employee`; this transaction reads
 * `payrun_employee_calculation`, `attendance_monthly_payroll` and
 * `attendance_day_calculation`, and nothing else. There is no statement in
 * `approve` that reads a close column, so no close can be consulted by it,
 * let alone honoured.
 *
 * THE TWO ANSWER DIFFERENT QUESTIONS, which is why both can be true at once:
 *
 *   the close says  "we accept the attendance AS IT WAS when we looked"
 *   this gate says  "and it is still what it was when you pressed Approve"
 *
 * An employee who was closed and whose attendance then moved is refused here,
 * exactly like anybody else, and must be recalculated first.
 */
describe("an accepted attendance basis is still revalidated", () => {
  it("refuses a closed employee whose attendance moved after the close", async () => {
    const pool = fakePool({ attendance: { ...CURRENT_ATTENDANCE, payroll_version: 4 } });
    const [result] = await approve(pool);

    assert.equal(result.outcome, "SOURCE_MOVED");
    assert.ok(result.changed.length > 0);
    assert.equal(approvalUpdates(pool.log).length, 0, "no status was changed");
    assert.equal(auditInserts(pool.log).length, 0);
  });

  it("never reads a close column, so a close cannot influence it", () => {
    const pool = fakePool();
    return approve(pool).then(() => {
      const everything = pool.log.map((e) => String(e.sql)).join(" ");
      assert.ok(
        !/attendance_closed_for_payroll/i.test(everything),
        "the approval transaction consults the close"
      );
      assert.ok(
        !/FROM payrun_employee\b(?!_)/i.test(everything),
        "the approval transaction reads the snapshot the close lives on"
      );
    });
  });

  it("still approves a closed employee whose sources have NOT moved", async () => {
    /* The close is not a licence to approve a stale month - and equally it is
       not a curse: unchanged sources approve exactly as they always did. */
    const pool = fakePool();
    const [result] = await approve(pool);
    assert.equal(result.outcome, "APPROVED");
  });
});
