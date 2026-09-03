const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const buildUsecase = require("./advance_request");

/**
 * Stands in for the repository, and in particular reproduces the one thing
 * the stage guards depend on: updateStage only touches a row that still
 * holds the status the caller acted on, so a stale call reports zero
 * affected rows rather than overwriting someone else's transition.
 */
function fakeRepo(row) {
  const state = { ...row };
  const activity = [];
  const documents = [];

  return {
    state,
    activity,
    documents,

    create(request) {
      Object.assign(state, request, { status: "submitted" });
      return Promise.resolve({ id: 7 });
    },

    getById(id) {
      return Promise.resolve(state.deleted ? null : { ...state });
    },

    updateStage(id, expectedStatus, nextStatus, fields) {
      if (state.status !== expectedStatus) {
        return Promise.resolve({ affectedRows: 0 });
      }
      Object.assign(state, fields, { status: nextStatus });
      return Promise.resolve({ affectedRows: 1 });
    },

    createActivity(requestId, employeeId, field, oldValue, newValue) {
      activity.push({ field, old_value: oldValue, new_value: newValue });
      return Promise.resolve({ id: activity.length });
    },

    createDocument(requestId, stage, fileUrl) {
      documents.push({ stage, file_url: fileUrl });
      return Promise.resolve({ id: documents.length });
    },

    getDocumentsByRequestId: () => Promise.resolve(documents),
    getActivityByRequestId: () => Promise.resolve(activity),
  };
}

const at = (status) =>
  fakeRepo({ advance_request_id: 7, status, amount: "5000.00" });

/** Asserts the call rejects with the given error name. */
async function rejectsWith(name, fn) {
  await assert.rejects(fn, (err) => {
    assert.equal(err.name, name);
    return true;
  });
}

describe("advance request: the happy path", () => {
  it("raises a request as submitted and logs the opening status", async () => {
    const repo = at("submitted");
    const usecase = buildUsecase(repo);

    const id = await usecase.create({
      invoice_number: "26-27GPTC1085",
      distributor_code: 12,
      amount: 5320,
      reason: "advance against PO",
      created_by: 4,
    });

    assert.equal(id, 7);
    assert.equal(repo.state.status, "submitted");
    assert.deepEqual(repo.activity[0], {
      field: "status",
      old_value: null,
      new_value: "submitted",
    });
  });

  it("runs submitted -> verified -> approved -> paid", async () => {
    const repo = at("submitted");
    const usecase = buildUsecase(repo);

    await usecase.balanceCheck(
      7,
      {
        pending_bills: 3,
        previous_advance_balance: 1200,
        balance_remarks: "two bills outstanding",
      },
      9
    );
    assert.equal(repo.state.status, "verified");
    assert.equal(repo.state.balance_checked_by, 9);

    await usecase.approval(7, { approval_status: 1, approval_note: "ok" }, 3);
    assert.equal(repo.state.status, "approved");
    assert.equal(repo.state.approved_by, 3);

    await usecase.payment(
      7,
      {
        paid_amount: 5320,
        utr: "UTR99001",
        bank_id: 41,
        payment_date: "2026-09-02",
      },
      5
    );
    assert.equal(repo.state.status, "paid");
    assert.equal(repo.state.utr, "UTR99001");
    assert.equal(repo.state.paid_by, 5);

    assert.deepEqual(
      repo.activity.map((a) => a.new_value),
      ["verified", "approved", "paid"]
    );
  });

  it("holds a request at A1.1 instead of passing it to the approver", async () => {
    const repo = at("submitted");
    const usecase = buildUsecase(repo);

    await usecase.balanceCheck(
      7,
      {
        pending_bills: 9,
        previous_advance_balance: 40000,
        balance_remarks: "balance too high",
        on_hold: true,
      },
      9
    );

    assert.equal(repo.state.status, "on_hold");
  });

  it("rejects at A2, which is terminal", async () => {
    const repo = at("verified");
    const usecase = buildUsecase(repo);

    await usecase.approval(7, { approval_status: 0, approval_note: "no" }, 3);
    assert.equal(repo.state.status, "rejected");
    assert.equal(repo.state.approval_status, 0);
  });

  it("keeps the paid amount separate from the approved amount", async () => {
    const repo = at("approved");
    const usecase = buildUsecase(repo);

    await usecase.payment(
      7,
      {
        paid_amount: 4000,
        utr: "UTR2",
        bank_id: 41,
        payment_date: "2026-09-02",
      },
      5
    );

    assert.equal(repo.state.paid_amount, 4000);
    assert.equal(repo.state.amount, "5000.00", "approved amount is preserved");
  });
});

describe("advance request: a stage may only act on its own status", () => {
  const cases = [
    ["balanceCheck", "verified", (u) =>
      u.balanceCheck(7, {
        pending_bills: 1,
        previous_advance_balance: 1,
        balance_remarks: "x",
      }, 1)],
    ["approval", "submitted", (u) => u.approval(7, { approval_status: 1 }, 1)],
    ["approval", "paid", (u) => u.approval(7, { approval_status: 1 }, 1)],
    ["payment", "verified", (u) =>
      u.payment(7, {
        paid_amount: 1,
        utr: "U",
        bank_id: 1,
        payment_date: "2026-09-02",
      }, 1)],
    ["payment", "rejected", (u) =>
      u.payment(7, {
        paid_amount: 1,
        utr: "U",
        bank_id: 1,
        payment_date: "2026-09-02",
      }, 1)],
    ["payment", "paid", (u) =>
      u.payment(7, {
        paid_amount: 1,
        utr: "U",
        bank_id: 1,
        payment_date: "2026-09-02",
      }, 1)],
  ];

  for (const [stage, status, call] of cases) {
    it(`refuses ${stage} on a ${status} request`, async () => {
      const repo = at(status);
      const usecase = buildUsecase(repo);

      await rejectsWith("ConflictError", () => call(usecase));
      assert.equal(repo.state.status, status, "status is left alone");
    });
  }

  it("reports a missing request as not found, not a conflict", async () => {
    const repo = at("submitted");
    repo.state.deleted = true;
    const usecase = buildUsecase(repo);

    await rejectsWith("NotFoundError", () =>
      usecase.approval(7, { approval_status: 1 }, 1)
    );
  });

  it("turns a lost race into a conflict rather than a silent overwrite", async () => {
    const repo = at("verified");
    const usecase = buildUsecase(repo);

    // Someone else approves between this caller's read and its write.
    const realUpdate = repo.updateStage;
    repo.updateStage = (...args) => {
      repo.state.status = "approved";
      return realUpdate.call(repo, ...args);
    };

    await rejectsWith("ConflictError", () =>
      usecase.approval(7, { approval_status: 0 }, 1)
    );
    assert.equal(repo.state.status, "approved", "the first write stands");
  });
});

describe("advance request: editing the A1 fields", () => {
  it("edits a submitted request and logs only what changed", async () => {
    const repo = at("submitted");
    repo.state.invoice_number = "26-27GPTC1085";
    repo.state.reason = "same";
    const usecase = buildUsecase(repo);

    await usecase.updateDetails(
      7,
      { invoice_number: "26-27GPTC1086", reason: "same" },
      4
    );

    assert.equal(repo.state.invoice_number, "26-27GPTC1086");
    assert.deepEqual(repo.activity, [
      { field: "invoice_number", old_value: "26-27GPTC1085", new_value: "26-27GPTC1086" },
    ]);
  });

  it("refuses an edit once accounts has checked the balance", async () => {
    const repo = at("verified");
    const usecase = buildUsecase(repo);

    await rejectsWith("ConflictError", () =>
      usecase.updateDetails(7, { amount: 999999 }, 4)
    );
    assert.equal(repo.state.amount, "5000.00");
  });

  it("is a no-op when the body carries no editable field", async () => {
    const repo = at("submitted");
    const usecase = buildUsecase(repo);

    await usecase.updateDetails(7, { status: "paid" }, 4);

    assert.equal(repo.state.status, "submitted", "status is not editable here");
    assert.equal(repo.activity.length, 0);
  });
});

describe("advance request: getting out of a hold", () => {
  it("lets accounts re-check a held request and release it", async () => {
    const repo = at("on_hold");
    const usecase = buildUsecase(repo);

    await usecase.balanceCheck(
      7,
      {
        pending_bills: 0,
        previous_advance_balance: 0,
        balance_remarks: "supplier cleared their bills",
      },
      9
    );

    assert.equal(repo.state.status, "verified");
    assert.deepEqual(repo.activity, [
      { field: "status", old_value: "on_hold", new_value: "verified" },
    ]);
  });

  it("lets accounts re-check and keep holding it", async () => {
    const repo = at("on_hold");
    const usecase = buildUsecase(repo);

    await usecase.balanceCheck(
      7,
      {
        pending_bills: 4,
        previous_advance_balance: 30000,
        balance_remarks: "still too high",
        on_hold: true,
      },
      9
    );

    assert.equal(repo.state.status, "on_hold");
  });

  it("releases the hold when the team edits and clarifies it", async () => {
    const repo = at("on_hold");
    repo.state.reason = "advance";
    const usecase = buildUsecase(repo);

    await usecase.updateDetails(7, { reason: "advance against PO-991, part 2" }, 4);

    assert.equal(repo.state.status, "verified", "goes straight to the approver");
    assert.equal(repo.state.reason, "advance against PO-991, part 2");
    assert.deepEqual(repo.activity, [
      { field: "reason", old_value: "advance", new_value: "advance against PO-991, part 2" },
      { field: "status", old_value: "on_hold", new_value: "verified" },
    ]);
  });

  it("does not promote a submitted request that is merely edited", async () => {
    const repo = at("submitted");
    repo.state.reason = "advance";
    const usecase = buildUsecase(repo);

    await usecase.updateDetails(7, { reason: "clearer wording" }, 4);

    assert.equal(repo.state.status, "submitted");
    assert.deepEqual(
      repo.activity.map((a) => a.field),
      ["reason"],
      "no status entry, because nothing moved"
    );
  });

  it("still refuses to release a request nobody is holding", async () => {
    for (const status of ["verified", "approved", "rejected", "paid"]) {
      const repo = at(status);
      const usecase = buildUsecase(repo);

      await rejectsWith("ConflictError", () =>
        usecase.updateDetails(7, { reason: "too late" }, 4)
      );
      assert.equal(repo.state.status, status);
    }
  });

  it("keeps the race guard when starting from a hold", async () => {
    const repo = at("on_hold");
    const usecase = buildUsecase(repo);

    // Accounts release it between this caller's read and its write.
    const realUpdate = repo.updateStage;
    repo.updateStage = (...args) => {
      repo.state.status = "verified";
      return realUpdate.call(repo, ...args);
    };

    await rejectsWith("ConflictError", () =>
      usecase.balanceCheck(
        7,
        { pending_bills: 1, previous_advance_balance: 1, balance_remarks: "x" },
        9
      )
    );
    assert.equal(repo.state.status, "verified", "the first write stands");
  });
});

describe("advance request: documents", () => {
  it("attaches a proof of payment to a paid request", async () => {
    const repo = at("paid");
    const usecase = buildUsecase(repo);

    const docs = await usecase.addDocument(7, "a3", "https://s3/proof.pdf", 5);
    assert.equal(docs.length, 1);
    assert.equal(docs[0].stage, "a3");
  });

  it("refuses a payment proof before the request is approved", async () => {
    const repo = at("verified");
    const usecase = buildUsecase(repo);

    await rejectsWith("ConflictError", () =>
      usecase.addDocument(7, "a3", "https://s3/early.pdf", 5)
    );
    assert.equal(repo.documents.length, 0);
  });

  it("refuses a new A1 doc on a request that is already settled", async () => {
    const repo = at("rejected");
    const usecase = buildUsecase(repo);

    await rejectsWith("ConflictError", () =>
      usecase.addDocument(7, "a1", "https://s3/late.pdf", 5)
    );
  });
});
