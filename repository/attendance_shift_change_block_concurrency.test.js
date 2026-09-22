/**
 * THE CROSS-TABLE RACE: HR BLOCK vs EMPLOYEE SUBMIT.
 *
 *   node --test repository/attendance_shift_change_block_concurrency.test.js
 *
 * ================== WHY THIS TEST EXISTS AND WHAT IT PROVES ===============
 *
 * The unique key stops two blocks racing. It cannot stop a block racing the
 * employee's own submit, because they write DIFFERENT tables:
 *
 *   HR       checks "no open request" -> passes
 *   employee checks "no active block" -> passes
 *   employee INSERTs the request
 *   HR       INSERTs the block
 *   =        a PENDING request AND an active block. Forbidden.
 *
 * A sequential test over fake usecases can never catch that: it needs the two
 * transactions INTERLEAVED. So this file runs the REAL repository functions -
 * `attendance_shift_change_block#create` and
 * `attendance_regularization#createRequest` - against a connection pool that
 * implements the one database behaviour the fix depends on: `SELECT ... FOR
 * UPDATE` blocks a second transaction until the first commits or rolls back.
 *
 * ============== WHAT IS REAL HERE AND WHAT IS NOT, STATED PLAINLY =========
 *
 * REAL: both repository functions, their statement order, which row they lock,
 * when they lock it relative to their checks, and their commit/rollback paths.
 *
 * MODELLED: the lock itself. There is no MySQL in this suite, so the pool
 * below maintains a per-row lock with a real async wait queue. That is the
 * behaviour `FOR UPDATE` has on a single existing record row, which is
 * deliberately what both paths take - a record lock on `new_employee`, never a
 * range that could gap-lock.
 *
 * NOT PROVEN HERE: that MySQL grants the lock as modelled. That rests on
 * `FOR UPDATE` semantics plus the unique key as a second, independent
 * backstop, and would need an integration environment to demonstrate.
 *
 * THE DISCRIMINATOR: writes in this fake are visible as soon as they are
 * issued. With the lock working only one transaction is ever inside the
 * critical section, so that is harmless. REMOVE THE LOCK FROM EITHER PATH and
 * both transactions enter together, both read an empty table, and both insert
 * - which is the forbidden final state, and is what these tests then catch.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const buildBlockRepo = require("./attendance_shift_change_block");
const buildRegularizationRepo = require("./attendance_regularization");

const EMPLOYEE = 42;
const DATE = "2026-09-18";
const SHORT_SHIFT = 7;
const LONG_SHIFT = 8;

/* ------------------------------------------------------------------------ */
/* A POOL THAT HONOURS `FOR UPDATE`.                                        */
/* ------------------------------------------------------------------------ */

function lockingPool() {
  /** Committed rows. Shared by every connection, as one database is. */
  const db = { blocks: [], requests: [], steps: [], nextBlockId: 1, nextRequestId: 900 };

  /** Who holds each row lock, and who is queued behind them. */
  const locks = new Map();

  /** The order in which things actually happened, for the interleaving tests. */
  const trace = [];

  let txSeq = 0;

  /**
   * A BARRIER, so a test can pin the EXACT dangerous interleaving instead of
   * hoping the event loop produces it.
   *
   * `holdAfter(regex)` freezes the first query whose text matches - AFTER its
   * result is computed, BEFORE its callback fires - and hands back a release
   * function. The transaction is then suspended mid-flight, still holding
   * whatever it has locked, which is exactly what a real transaction does
   * while its next statement is in flight.
   */
  let barrier = null;
  const holdAfter = (regex) => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    barrier = { regex, gate, hit: false };
    return () => release();
  };

  const acquire = (key, txId) =>
    new Promise((resolve) => {
      const current = locks.get(key);
      if (!current) {
        locks.set(key, { holder: txId, waiters: [] });
        trace.push(`tx${txId} LOCK ${key}`);
        resolve();
        return;
      }
      trace.push(`tx${txId} WAIT ${key} (held by tx${current.holder})`);
      current.waiters.push({ txId, resolve });
    });

  const releaseAll = (txId) => {
    locks.forEach((entry, key) => {
      if (entry.holder !== txId) return;
      trace.push(`tx${txId} UNLOCK ${key}`);
      const next = entry.waiters.shift();
      if (next) {
        entry.holder = next.txId;
        trace.push(`tx${next.txId} LOCK ${key}`);
        next.resolve();
      } else {
        locks.delete(key);
      }
    });
  };

  const connection = (txId) => ({
    __txId: txId,
    beginTransaction(cb) {
      trace.push(`tx${txId} BEGIN`);
      cb(null);
    },
    commit(cb) {
      trace.push(`tx${txId} COMMIT`);
      releaseAll(txId);
      cb(null);
    },
    rollback(cb) {
      trace.push(`tx${txId} ROLLBACK`);
      releaseAll(txId);
      cb(null);
    },
    release() {
      releaseAll(txId);
    },
    query(sql, params, cb) {
      const rawCallback = typeof params === "function" ? params : cb;
      const args = typeof params === "function" ? [] : params || [];
      const text = String(sql).replace(/\s+/g, " ");

      // The barrier sits between the result and the callback, so the paused
      // transaction has already DONE the read and has not yet acted on it -
      // which is the precise instant the race turns on.
      const callback = (err, result) => {
        if (barrier && !barrier.hit && barrier.regex.test(text)) {
          barrier.hit = true;
          trace.push(`tx${txId} PAUSED after ${text.slice(0, 48)}...`);
          barrier.gate.then(() => {
            trace.push(`tx${txId} RESUMED`);
            rawCallback(err, result);
          });
          return;
        }
        rawCallback(err, result);
      };

      // ---- THE SHARED LOCK -------------------------------------------------
      if (/FROM new_employee/.test(text) && /FOR UPDATE/.test(text)) {
        acquire(`employee:${args[0]}`, txId).then(() =>
          callback(null, [{ employee_id: args[0] }])
        );
        return;
      }

      // ---- the block path's conflicting-request read ----------------------
      if (
        /FROM attendance_approval_request/.test(text) &&
        /request_type = 'SHIFT_CHANGE'/.test(text) &&
        /status IN \('PENDING', 'APPROVED'\)/.test(text)
      ) {
        const hit = db.requests.filter(
          (r) =>
            Number(r.employee_id) === Number(args[0]) &&
            r.attendance_date === args[1] &&
            r.request_type === "SHIFT_CHANGE" &&
            ["PENDING", "APPROVED"].includes(r.status)
        );
        trace.push(`tx${txId} READ requests -> ${hit.length}`);
        callback(null, hit.map((r) => ({
          attendance_approval_request_id: r.attendance_approval_request_id,
          status: r.status,
        })));
        return;
      }

      // ---- the request path's active-block read ---------------------------
      if (/FROM attendance_shift_change_block/.test(text) && /removed_at IS NULL/.test(text)) {
        const hit = db.blocks.filter(
          (b) =>
            Number(b.employee_id) === Number(args[0]) &&
            b.attendance_date === args[1] &&
            !b.removed_at
        );
        trace.push(`tx${txId} READ blocks -> ${hit.length}`);
        callback(
          null,
          hit.map((b) => ({
            attendance_shift_change_block_id: b.attendance_shift_change_block_id,
            reason: b.reason,
            attendance_date: b.attendance_date,
          }))
        );
        return;
      }

      // ---- the block insert, with the unique key as the backstop ----------
      if (/INSERT INTO attendance_shift_change_block/.test(text)) {
        const [employee_id, attendance_date, outlet_id, reason] = args;
        const clash = db.blocks.find(
          (b) =>
            Number(b.employee_id) === Number(employee_id) &&
            b.attendance_date === attendance_date &&
            !b.removed_at
        );
        if (clash) {
          const err = new Error("Duplicate entry");
          err.code = "ER_DUP_ENTRY";
          trace.push(`tx${txId} INSERT block -> ER_DUP_ENTRY`);
          callback(err);
          return;
        }
        const id = db.nextBlockId;
        db.nextBlockId += 1;
        db.blocks.push({
          attendance_shift_change_block_id: id,
          employee_id,
          attendance_date,
          outlet_id,
          reason,
          removed_at: null,
        });
        trace.push(`tx${txId} INSERT block #${id}`);
        callback(null, { insertId: id, affectedRows: 1 });
        return;
      }

      // ---- the request insert ---------------------------------------------
      if (/INSERT INTO attendance_approval_request/.test(text)) {
        const id = db.nextRequestId;
        db.nextRequestId += 1;
        db.requests.push({
          attendance_approval_request_id: id,
          request_type: args[0],
          employee_id: args[1],
          attendance_date: args[3],
          status: /'APPROVED'/.test(text) ? "APPROVED" : "PENDING",
        });
        trace.push(`tx${txId} INSERT request #${id}`);
        callback(null, { insertId: id, affectedRows: 1 });
        return;
      }

      // ---- everything else the request path does (steps, punches, reads) --
      // Not the subject of this test, so it is answered generically rather
      // than modelled. A SELECT gets no rows; a write gets an id.
      if (/^\s*SELECT/i.test(text)) {
        callback(null, []);
        return;
      }
      callback(null, { insertId: 1, affectedRows: 1 });
    },
  });

  return {
    db,
    trace,
    locks,
    holdAfter,
    getConnection(cb) {
      txSeq += 1;
      cb(null, connection(txSeq));
    },
    query(sql, params, cb) {
      // The non-transactional surface, for reads outside a transaction.
      txSeq += 1;
      connection(txSeq).query(sql, params, cb);
    },
  };
}

const blockArgs = (over = {}) => ({
  employee_id: EMPLOYEE,
  attendance_date: DATE,
  outlet_id: 1,
  reason: "Punch timing is incorrect",
  blocked_by_employee_id: 900,
  blocked_by_user_id: 7,
  ...over,
});

const requestArgs = (over = {}) => ({
  request: {
    request_type: "SHIFT_CHANGE",
    requested_for_employee_id: EMPLOYEE,
    requested_by_employee_id: EMPLOYEE,
    attendance_date: DATE,
    outlet_id: 1,
    requester_class: "STAFF",
    reason: "covering the late delivery",
    candidate_ot_minutes: 0,
    auto_created: false,
    chain_source: "ROLE_CHAIN",
    requested_work_shift_id: LONG_SHIFT,
    base_work_shift_id: SHORT_SHIFT,
    ...over,
  },
  chain: [{ stage_no: 1, approver_role: "STORE_MANAGER", outlet_id: 1 }],
  punch: null,
});

/** The forbidden final state, asserted the same way every time. */
const assertNotBoth = (pool) => {
  const activeBlocks = pool.db.blocks.filter((b) => !b.removed_at);
  const openRequests = pool.db.requests.filter(
    (r) => r.request_type === "SHIFT_CHANGE" && ["PENDING", "APPROVED"].includes(r.status)
  );
  assert.ok(
    !(activeBlocks.length > 0 && openRequests.length > 0),
    `FORBIDDEN STATE: ${activeBlocks.length} active block(s) AND ${openRequests.length} open request(s)\n` +
      pool.trace.join("\n")
  );
  return { activeBlocks, openRequests };
};

/* ===================================================================== */

describe("A. HR block vs employee submit, concurrently", () => {
  it("exactly one wins, and never both - block first", async () => {
    const pool = lockingPool();
    const blocks = buildBlockRepo(pool);
    const requests = buildRegularizationRepo(pool);

    // Both start before either finishes. The lock decides the order.
    const [blockResult, requestResult] = await Promise.all([
      blocks.create(blockArgs()),
      requests.createRequest(requestArgs()),
    ]);

    const { activeBlocks, openRequests } = assertNotBoth(pool);

    // Exactly one of the two produced something.
    const wonBlock = blockResult.created === true;
    const wonRequest = !requestResult.hr_blocked && requestResult.created !== false;
    assert.ok(wonBlock !== wonRequest, "exactly one path may succeed");

    if (wonBlock) {
      assert.equal(activeBlocks.length, 1);
      assert.equal(openRequests.length, 0);
      // THE EMPLOYEE IS TOLD WHY, with HR's own reason carried back.
      assert.equal(requestResult.hr_blocked, true);
      assert.equal(requestResult.block.reason, "Punch timing is incorrect");
    } else {
      assert.equal(openRequests.length, 1);
      assert.equal(activeBlocks.length, 0);
      // HR IS TOLD A REQUEST APPEARED, and which one.
      assert.equal(blockResult.created, false);
      assert.ok(blockResult.conflicting_request, "the refusal names the request");
      assert.equal(blockResult.conflicting_request.status, "PENDING");
    }
  });

  it("holds for both orderings - the request may equally win", async () => {
    // Run the pair in the other submission order, repeatedly, and assert the
    // invariant every time. Whichever wins is fine; both is not.
    for (let i = 0; i < 12; i += 1) {
      const pool = lockingPool();
      const blocks = buildBlockRepo(pool);
      const requests = buildRegularizationRepo(pool);
      /* eslint-disable no-await-in-loop */
      await Promise.all([
        requests.createRequest(requestArgs()),
        blocks.create(blockArgs()),
      ]);
      /* eslint-enable no-await-in-loop */
      const { activeBlocks, openRequests } = assertNotBoth(pool);
      assert.equal(activeBlocks.length + openRequests.length, 1, "exactly one artefact exists");
    }
  });

  it("the lock is taken BEFORE either side reads what it checks for", async () => {
    const pool = lockingPool();
    const blocks = buildBlockRepo(pool);
    const requests = buildRegularizationRepo(pool);

    await Promise.all([blocks.create(blockArgs()), requests.createRequest(requestArgs())]);

    // In each transaction, the LOCK line must precede that transaction's READ.
    const byTx = new Map();
    pool.trace.forEach((line) => {
      const tx = line.match(/^tx(\d+)/)[1];
      if (!byTx.has(tx)) byTx.set(tx, []);
      byTx.get(tx).push(line);
    });
    byTx.forEach((lines, tx) => {
      const lock = lines.findIndex((l) => /LOCK employee:/.test(l));
      const read = lines.findIndex((l) => /READ (requests|blocks)/.test(l));
      if (read === -1) return; // that transaction never got as far as a read
      assert.ok(lock !== -1, `tx${tx} read without ever locking:\n${lines.join("\n")}`);
      assert.ok(lock < read, `tx${tx} read BEFORE locking:\n${lines.join("\n")}`);
    });

    // And the second transaction genuinely waited for the first.
    assert.ok(
      pool.trace.some((l) => /WAIT employee:/.test(l)),
      `the two transactions did not serialize:\n${pool.trace.join("\n")}`
    );
  });

  it("both paths lock the SAME row, in the same order, so there is no deadlock", async () => {
    const pool = lockingPool();
    const blocks = buildBlockRepo(pool);
    const requests = buildRegularizationRepo(pool);
    await Promise.all([blocks.create(blockArgs()), requests.createRequest(requestArgs())]);

    const locked = pool.trace.filter((l) => /LOCK /.test(l)).map((l) => l.split("LOCK ")[1]);
    assert.deepEqual([...new Set(locked)], [`employee:${EMPLOYEE}`], "one lock target only");
    // Every transaction released what it took: nothing is left held.
    assert.equal(pool.locks.size, 0, "a lock outlived its transaction");
  });
});

describe("A2. THE PINNED INTERLEAVING - the exact window the race needs", () => {
  /**
   * THE DANGEROUS SEQUENCE, FORCED RATHER THAN HOPED FOR.
   *
   * The tests above run both transactions concurrently and assert the
   * invariant, but the event loop decides who gets there first - so they can
   * pass by luck even with the lock gone. This one pins the interleaving:
   *
   *   1. the employee's transaction runs until it has READ the block table and
   *      found nothing, and is then FROZEN before it acts on that
   *   2. HR's whole transaction is released to run to completion
   *   3. the employee's transaction is resumed
   *
   * Without the shared lock, step 2 completes and inserts a block while the
   * employee's transaction is holding a stale "no block" answer, and step 3
   * then inserts the request: BOTH exist. That is the forbidden state.
   *
   * With the lock, HR's transaction cannot get past its FIRST statement while
   * the employee's transaction holds the employee row - so step 2 blocks, the
   * employee commits, and HR then sees the request and refuses.
   */
  it("employee reads no-block, HR blocks, employee resumes -> never both", async () => {
    const pool = lockingPool();
    const blocks = buildBlockRepo(pool);
    const requests = buildRegularizationRepo(pool);

    // Freeze the employee's transaction the instant after it reads the blocks.
    const resume = pool.holdAfter(/FROM attendance_shift_change_block/);

    const requestPromise = requests.createRequest(requestArgs());

    // Let the employee's transaction reach the barrier.
    await new Promise((r) => setImmediate(r));

    // Now HR tries to block, while the employee is frozen mid-transaction.
    const blockPromise = blocks.create(blockArgs());

    // Give HR every opportunity to finish. With the lock it cannot: it is
    // waiting on the employee row.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const blockFinishedEarly = await Promise.race([
      blockPromise.then(() => true),
      new Promise((r) => setImmediate(() => r(false))),
    ]);
    assert.equal(
      blockFinishedEarly,
      false,
      `HR's transaction ran to completion while the employee held the lock:\n${pool.trace.join("\n")}`
    );

    resume();
    const [requestResult, blockResult] = await Promise.all([requestPromise, blockPromise]);

    assertNotBoth(pool);

    // The employee got there first, so the request exists and HR was refused
    // with the reason that is actually true: a request now exists.
    assert.equal(pool.db.requests.length, 1);
    assert.equal(pool.db.blocks.filter((b) => !b.removed_at).length, 0);
    assert.notEqual(requestResult.hr_blocked, true);
    assert.equal(blockResult.created, false);
    assert.ok(blockResult.conflicting_request, "HR is told a request appeared");
    assert.equal(blockResult.conflicting_request.status, "PENDING");
  });

  it("and the mirror image: HR reads no-request, employee submits, HR resumes", async () => {
    const pool = lockingPool();
    const blocks = buildBlockRepo(pool);
    const requests = buildRegularizationRepo(pool);

    // Freeze HR's transaction right after it reads the request table.
    const resume = pool.holdAfter(/status IN \('PENDING', 'APPROVED'\)/);

    const blockPromise = blocks.create(blockArgs());
    await new Promise((r) => setImmediate(r));

    const requestPromise = requests.createRequest(requestArgs());
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const requestFinishedEarly = await Promise.race([
      requestPromise.then(() => true),
      new Promise((r) => setImmediate(() => r(false))),
    ]);
    assert.equal(
      requestFinishedEarly,
      false,
      `the employee's transaction completed while HR held the lock:\n${pool.trace.join("\n")}`
    );

    resume();
    const [blockResult, requestResult] = await Promise.all([blockPromise, requestPromise]);

    assertNotBoth(pool);

    // HR got there first: the block exists, and the employee is refused with
    // HR's own reason.
    assert.equal(pool.db.blocks.filter((b) => !b.removed_at).length, 1);
    assert.equal(pool.db.requests.length, 0);
    assert.equal(blockResult.created, true);
    assert.equal(requestResult.hr_blocked, true);
    assert.equal(requestResult.block.reason, "Punch timing is incorrect");
  });
});

describe("B. HR unblock vs employee submit", () => {
  it("if the block is still active when the request is read, the submit fails normally", async () => {
    const pool = lockingPool();
    const blocks = buildBlockRepo(pool);
    const requests = buildRegularizationRepo(pool);

    await blocks.create(blockArgs());
    const result = await requests.createRequest(requestArgs());

    assert.equal(result.hr_blocked, true);
    assert.equal(result.created, false);
    assert.equal(pool.db.requests.length, 0, "no request was written");
    // The lifecycle is intact: one active block, unchanged.
    assert.equal(pool.db.blocks.filter((b) => !b.removed_at).length, 1);
    assert.equal(pool.db.blocks[0].removed_at, null);
  });

  it("once the block is removed, the request path proceeds", async () => {
    const pool = lockingPool();
    const blocks = buildBlockRepo(pool);
    const requests = buildRegularizationRepo(pool);

    await blocks.create(blockArgs());
    // Remove it the way the repository does - the row stays, gaining its
    // removal columns.
    pool.db.blocks[0].removed_at = "2026-09-19 12:00:00";

    const result = await requests.createRequest(requestArgs());
    assert.notEqual(result.hr_blocked, true, "a removed block is not a gate");
    assert.equal(pool.db.requests.length, 1);
    // ...and the removed block is still on record.
    assert.equal(pool.db.blocks.length, 1);
    assert.ok(pool.db.blocks[0].removed_at, "history survives");
  });
});

describe("C. a rejected request racing a fresh re-raise and a block", () => {
  it("exactly one of the new request and the block may win", async () => {
    const pool = lockingPool();
    // A previously REJECTED request does not occupy the date: production lets
    // it be re-raised, which is why HR needs to be able to block it.
    pool.db.requests.push({
      attendance_approval_request_id: 800,
      request_type: "SHIFT_CHANGE",
      employee_id: EMPLOYEE,
      attendance_date: DATE,
      status: "REJECTED",
    });

    const blocks = buildBlockRepo(pool);
    const requests = buildRegularizationRepo(pool);

    const [blockResult, requestResult] = await Promise.all([
      blocks.create(blockArgs()),
      requests.createRequest(requestArgs()),
    ]);

    const { activeBlocks, openRequests } = assertNotBoth(pool);
    assert.equal(activeBlocks.length + openRequests.length, 1);

    // THE REJECTED REQUEST IS UNTOUCHED, whichever won.
    const rejected = pool.db.requests.find((r) => r.attendance_approval_request_id === 800);
    assert.equal(rejected.status, "REJECTED");

    const wonBlock = blockResult.created === true;
    if (wonBlock) assert.equal(requestResult.hr_blocked, true);
    else assert.ok(blockResult.conflicting_request);
  });
});

describe("D. the other request types are left alone", () => {
  it("a REGULARIZATION request takes no lock and reads no block", async () => {
    const pool = lockingPool();
    const blocks = buildBlockRepo(pool);
    const requests = buildRegularizationRepo(pool);

    // A block on the date must not interfere with an unrelated request type.
    await blocks.create(blockArgs());
    pool.trace.length = 0;

    await requests.createRequest(requestArgs({ request_type: "REGULARIZATION" }));

    assert.ok(
      !pool.trace.some((l) => /LOCK employee:/.test(l)),
      `a REGULARIZATION request must not take the shift-change lock:\n${pool.trace.join("\n")}`
    );
    assert.ok(
      !pool.trace.some((l) => /READ blocks/.test(l)),
      "a REGULARIZATION request must not consult the HR block"
    );
    assert.equal(
      pool.db.requests.filter((r) => r.request_type === "REGULARIZATION").length,
      1,
      "and it is written as usual"
    );
  });
});
