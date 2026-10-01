/**
 * The Advance Request payment step and the LR Follow-up trigger.
 *
 *   node --test usecase/advance_request_lr_followup.test.js
 *
 * The workflow itself is pinned by advance_request.test.js, which runs
 * without a follow-up usecase and is unchanged. This pins the join: only
 * the payment opens a follow-up, inside the payment's own transaction, and
 * a failure there undoes the payment. The real-SQL version of the same is
 * in repository/lr_followup.mysql.test.js.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const buildUsecase = require("./advance_request");

/** A repository whose transaction is a journal that commits or discards. */
function fakeRepo(status) {
  const state = { advance_request_id: 7, status };
  const log = [];
  let txOpen = false;

  return {
    state,
    log,
    getById: () => Promise.resolve({ ...state }),
    getDocumentsByRequestId: () => Promise.resolve([]),
    getActivityByRequestId: () => Promise.resolve([]),
    updateStage(id, expected, next, fields, conn) {
      log.push({ op: "updateStage", conn, txOpen });
      if (state.status !== expected) return Promise.resolve({ affectedRows: 0 });
      conn ? conn.pending.push(() => Object.assign(state, fields, { status: next })) : Object.assign(state, fields, { status: next });
      return Promise.resolve({ affectedRows: 1 });
    },
    createActivity(id, emp, field, from, to, conn) {
      log.push({ op: "createActivity", conn, to });
      return Promise.resolve({ id: 1 });
    },
    async transaction(work) {
      const conn = { pending: [], id: "tx-1" };
      txOpen = true;
      try {
        const out = await work(conn);
        conn.pending.forEach((apply) => apply());
        return out;
      } finally {
        txOpen = false;
      }
    },
  };
}

describe("payment opens the LR Follow-up", () => {
  it("in the same transaction as the status change", async () => {
    const repo = fakeRepo("approved");
    const seen = [];
    const usecase = buildUsecase(repo, {
      lrFollowup: {
        createForPaidAdvance: (id, emp, conn) => {
          seen.push({ id, emp, conn });
          return Promise.resolve({ created: true, lr_followup_id: 1 });
        },
      },
    });

    await usecase.payment(7, {}, 502);

    assert.equal(repo.state.status, "paid");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].id, 7);
    assert.equal(seen[0].emp, 502);
    assert.equal(seen[0].conn.id, "tx-1");
    assert.ok(repo.log.every((entry) => entry.conn && entry.conn.id === "tx-1"));
  });

  it("a failed follow-up leaves the request approved", async () => {
    const repo = fakeRepo("approved");
    const usecase = buildUsecase(repo, {
      lrFollowup: { createForPaidAdvance: () => Promise.reject(new Error("boom")) },
    });
    await assert.rejects(usecase.payment(7, {}, 502), /boom/);
    assert.equal(repo.state.status, "approved");
  });

  it("no other stage opens one", async () => {
    let calls = 0;
    const lrFollowup = { createForPaidAdvance: () => { calls += 1; } };
    const repo = fakeRepo("pending_approval");
    const usecase = buildUsecase(repo, { lrFollowup });
    await usecase.approval(7, { decision: "approve" }, 1);
    assert.equal(repo.state.status, "approved");
    assert.equal(calls, 0);
    // ...and those stages run outside any transaction, exactly as before.
    assert.ok(repo.log.every((entry) => entry.conn === null));
  });

  it("a stale payment (already paid) opens nothing", async () => {
    let calls = 0;
    const usecase = buildUsecase(fakeRepo("paid"), {
      lrFollowup: { createForPaidAdvance: () => { calls += 1; } },
    });
    await assert.rejects(usecase.payment(7, {}, 502), (e) => e.name === "ConflictError");
    assert.equal(calls, 0);
  });
});
