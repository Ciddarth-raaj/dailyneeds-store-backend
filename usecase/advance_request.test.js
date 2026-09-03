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

describe("advance request: no previous balance", () => {
  it("raises a request as submitted and logs the opening status", async () => {
    const repo = at("submitted");
    const usecase = buildUsecase(repo);

    const id = await usecase.create({
      invoice_number: "26-27GPTC1085",
      distributor_code: 12,
      amount: 175919,
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

  it("goes straight to the admin when accounts enter 0", async () => {
    const repo = at("submitted");
    const usecase = buildUsecase(repo);

    await usecase.balanceCheck(
      7,
      { previous_advance_balance: 0, balance_remarks: "nothing outstanding" },
      9
    );

    assert.equal(repo.state.status, "pending_approval");
    assert.equal(repo.state.balance_checked_by, 9);
  });

  it("runs submitted -> pending_approval -> approved -> paid", async () => {
    const repo = at("submitted");
    const usecase = buildUsecase(repo);

    await usecase.balanceCheck(7, { previous_advance_balance: 0 }, 9);
    await usecase.approval(7, { decision: "approve", approval_note: "ok" }, 3);
    assert.equal(repo.state.status, "approved");
    assert.equal(repo.state.approved_by, 3);

    await usecase.payment(
      7,
      {
        paid_amount: 175919,
        utr: "UTR99001",
        bank_id: 41,
        payment_date: "2026-09-02",
      },
      5
    );

    assert.equal(repo.state.status, "paid");
    assert.equal(repo.state.utr, "UTR99001");
    assert.deepEqual(
      repo.activity.map((a) => a.new_value),
      ["pending_approval", "approved", "paid"]
    );
  });
});

describe("advance request: a previous balance goes back to purchase", () => {
  it("sends it back to purchase when accounts enter a balance", async () => {
    const repo = at("submitted");
    const usecase = buildUsecase(repo);

    await usecase.balanceCheck(
      7,
      { previous_advance_balance: 40000, balance_remarks: "two advances open" },
      9
    );

    assert.equal(repo.state.status, "pending_purchase_decision");
    assert.equal(repo.state.previous_advance_balance, 40000);
  });

  for (const action of ["less_and_pay", "defer"]) {
    it(`records "${action}" and sends it to the admin`, async () => {
      const repo = at("pending_purchase_decision");
      const usecase = buildUsecase(repo);

      await usecase.balanceAction(
        7,
        { balance_action: action, balance_action_note: "spoke to supplier" },
        4
      );

      assert.equal(repo.state.status, "pending_approval");
      assert.equal(repo.state.balance_action, action);
      assert.equal(repo.state.balance_action_by, 4);
      assert.ok(repo.state.balance_action_at, "records when it was decided");
    });
  }

  it("runs the whole chain with a balance in the way", async () => {
    const repo = at("submitted");
    const usecase = buildUsecase(repo);

    await usecase.balanceCheck(7, { previous_advance_balance: 40000 }, 9);
    await usecase.balanceAction(7, { balance_action: "less_and_pay" }, 4);
    await usecase.approval(7, { decision: "approve" }, 3);
    await usecase.payment(
      7,
      { paid_amount: 135919, utr: "U", bank_id: 41, payment_date: "2026-09-02" },
      5
    );

    assert.equal(repo.state.status, "paid");
    assert.deepEqual(
      repo.activity.map((a) => a.new_value),
      ["pending_purchase_decision", "pending_approval", "approved", "paid"]
    );
  });
});

describe("advance request: the admin decides", () => {
  const outcomes = [
    ["approve", "approved"],
    ["hold", "on_hold"],
    ["reject", "rejected"],
  ];

  for (const [decision, expected] of outcomes) {
    it(`"${decision}" leaves the request ${expected}`, async () => {
      const repo = at("pending_approval");
      const usecase = buildUsecase(repo);

      await usecase.approval(7, { decision, approval_note: "n" }, 3);
      assert.equal(repo.state.status, expected);
    });
  }

  it("refuses a decision it does not recognise", async () => {
    const repo = at("pending_approval");
    const usecase = buildUsecase(repo);

    await rejectsWith("ConflictError", () =>
      usecase.approval(7, { decision: "maybe" }, 3)
    );
    assert.equal(repo.state.status, "pending_approval");
  });

  it("decides the balance and approves in one step off a hold", async () => {
    const repo = at("on_hold");
    const usecase = buildUsecase(repo);

    await usecase.approval(
      7,
      {
        decision: "approve",
        approval_note: "clarified with the supplier",
        balance_action: "defer",
        balance_action_note: "will less next time",
      },
      3
    );

    assert.equal(repo.state.status, "approved");
    assert.equal(repo.state.balance_action, "defer");
    assert.equal(repo.state.balance_action_by, 3);
  });

  it("can hold, then approve later", async () => {
    const repo = at("pending_approval");
    const usecase = buildUsecase(repo);

    await usecase.approval(7, { decision: "hold" }, 3);
    assert.equal(repo.state.status, "on_hold");

    await usecase.approval(7, { decision: "approve" }, 3);
    assert.equal(repo.state.status, "approved");
  });
});

describe("advance request: a stage may only act on its own status", () => {
  const balance = (u) =>
    u.balanceCheck(7, { previous_advance_balance: 1 }, 1);
  const action = (u) =>
    u.balanceAction(7, { balance_action: "defer" }, 1);
  const approve = (u) => u.approval(7, { decision: "approve" }, 1);
  const pay = (u) =>
    u.payment(7, {
      paid_amount: 1,
      utr: "U",
      bank_id: 1,
      payment_date: "2026-09-02",
    }, 1);

  const cases = [
    ["balanceCheck", "pending_approval", balance],
    ["balanceCheck", "on_hold", balance],
    ["balanceCheck", "paid", balance],
    ["balanceAction", "submitted", action],
    ["balanceAction", "pending_approval", action],
    ["balanceAction", "paid", action],
    ["approval", "submitted", approve],
    ["approval", "pending_purchase_decision", approve],
    ["approval", "paid", approve],
    ["approval", "rejected", approve],
    ["payment", "pending_approval", pay],
    ["payment", "on_hold", pay],
    ["payment", "rejected", pay],
    ["payment", "paid", pay],
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
    const repo = at("pending_approval");
    repo.state.deleted = true;
    const usecase = buildUsecase(repo);

    await rejectsWith("NotFoundError", () =>
      usecase.approval(7, { decision: "approve" }, 1)
    );
  });

  for (const status of ["pending_approval", "on_hold", "pending_purchase_decision"]) {
    it(`turns a lost race from ${status} into a conflict`, async () => {
      const repo = at(status);
      const usecase = buildUsecase(repo);

      // Someone else moves it between this caller's read and its write.
      const realUpdate = repo.updateStage;
      repo.updateStage = (...args) => {
        repo.state.status = "approved";
        return realUpdate.call(repo, ...args);
      };

      const call =
        status === "pending_purchase_decision"
          ? () => action(usecase)
          : () => approve(usecase);

      await rejectsWith("ConflictError", call);
      assert.equal(repo.state.status, "approved", "the first write stands");
    });
  }
});

describe("advance request: editing corrects, it does not advance", () => {
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
    assert.equal(repo.state.status, "submitted");
    assert.deepEqual(repo.activity, [
      {
        field: "invoice_number",
        old_value: "26-27GPTC1085",
        new_value: "26-27GPTC1086",
      },
    ]);
  });

  it("leaves a held request on hold — releasing it is the admin's call", async () => {
    const repo = at("on_hold");
    repo.state.amount = "5000.00";
    const usecase = buildUsecase(repo);

    await usecase.updateDetails(7, { amount: 4000 }, 4);

    assert.equal(repo.state.status, "on_hold", "the edit does not release it");
    assert.equal(repo.state.amount, 4000);
    assert.deepEqual(
      repo.activity.map((a) => a.field),
      ["amount"],
      "no status entry, because nothing moved"
    );
  });

  it("edits a request sitting with purchase", async () => {
    const repo = at("pending_purchase_decision");
    const usecase = buildUsecase(repo);

    await usecase.updateDetails(7, { amount: 999 }, 4);
    assert.equal(repo.state.status, "pending_purchase_decision");
  });

  it("refuses an edit once the admin or accounts have acted", async () => {
    for (const status of ["pending_approval", "approved", "rejected", "paid"]) {
      const repo = at(status);
      const usecase = buildUsecase(repo);

      await rejectsWith("ConflictError", () =>
        usecase.updateDetails(7, { reason: "too late" }, 4)
      );
      assert.equal(repo.state.status, status);
    }
  });

  it("is a no-op when the body carries no editable field", async () => {
    const repo = at("submitted");
    const usecase = buildUsecase(repo);

    await usecase.updateDetails(7, { status: "paid" }, 4);

    assert.equal(repo.state.status, "submitted", "status is not editable here");
    assert.equal(repo.activity.length, 0);
  });
});

describe("advance request: documents", () => {
  it("attaches a payment advice to a paid request", async () => {
    const repo = at("paid");
    const usecase = buildUsecase(repo);

    const docs = await usecase.addDocument(7, "a3", "https://s3/advice.pdf", 5);
    assert.equal(docs.length, 1);
    assert.equal(docs[0].stage, "a3");
  });

  it("refuses a payment advice before the request is approved", async () => {
    const repo = at("pending_approval");
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
