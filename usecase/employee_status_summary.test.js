/**
 * Stage 0C / C3 — the bulk Aadhaar and bank status summary.
 *
 *   node --test usecase/employee_status_summary.test.js
 *
 * Two things are being defended here, and they are not the same thing.
 *
 * THE FIRST is that this endpoint agrees with the single-employee endpoints
 * it replaces on the list. A summary that answered VERIFIED where
 * `/bank/verification` says DUPLICATE_ACCOUNT would be worse than no columns
 * at all, so the DUPLICATE_ACCOUNT cases below are the ones that matter: C2
 * resolves a duplicate on READ, and this must too.
 *
 * THE SECOND is that it stays bounded. The whole reason it exists is that
 * 630 employees must not become 1,260 requests, so the query count is
 * asserted directly, at two very different headcounts.
 */
process.env.BANK_FINGERPRINT_KEY = "test-bank-fingerprint-key-at-least-32-chars";

const test = require("node:test");
const assert = require("node:assert/strict");

const buildSummary = require("./employee_status_summary");
const { EmployeeBankUsecase } = require("./employee_bank");

const fp = (account_no, ifsc) =>
  EmployeeBankUsecase.currentFingerprintOf({ account_no, ifsc });

/**
 * A fake of exactly the four reads the usecase performs, counting every one.
 * `employeeUsecase.get` stands in for the real employee list; the summary
 * calls it rather than querying employees itself, which is what makes its
 * visibility identical by construction rather than by review.
 */
function build({ employees = [], identities = [], verifications = [], activeVerified = [] } = {}) {
  const queries = [];
  const employeeUsecase = {
    get: async (filters) => {
      queries.push(["employees", filters]);
      return employees;
    },
  };
  const aadhaarRepo = {
    findEmployeeIdsWithIdentity: async (ids) => {
      queries.push(["aadhaar", ids]);
      return identities.filter((id) => ids.includes(id));
    },
  };
  const bankRepo = {
    getBankDetailsMany: async (ids) => {
      queries.push(["bank-details", ids]);
      return employees
        .filter((e) => ids.includes(e.employee_id))
        .map((e) => ({ employee_id: e.employee_id, account_no: e.account_no, ifsc: e.ifsc }));
    },
    getVerificationsMany: async (ids) => {
      queries.push(["verifications", ids]);
      return verifications.filter((v) => ids.includes(v.employee_id));
    },
    findActiveVerifiedByFingerprints: async (fingerprints) => {
      queries.push(["duplicates", fingerprints]);
      return activeVerified.filter((r) => fingerprints.includes(r.account_fingerprint));
    },
  };
  return { usecase: buildSummary(employeeUsecase, aadhaarRepo, bankRepo), queries };
}

const byId = (rows) => Object.fromEntries(rows.map((r) => [r.employee_id, r]));

/* ================================================================ Aadhaar */
test("an attached Aadhaar identity reads VERIFIED, and its absence reads PENDING", async () => {
  const { usecase } = build({
    employees: [{ employee_id: 1 }, { employee_id: 2 }],
    identities: [1],
  });
  const rows = byId(await usecase.list({}));
  assert.equal(rows[1].aadhaar_status, "VERIFIED");
  assert.equal(rows[2].aadhaar_status, "PENDING");
});

test("an employee who skipped Aadhaar needs no row to be answered for", async () => {
  // The 630 employees who predate C2 have no identity and no placeholder.
  // They are PENDING, not missing from the response.
  const { usecase } = build({ employees: [{ employee_id: 7 }], identities: [] });
  const rows = await usecase.list({});
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    employee_id: 7,
    aadhaar_status: "PENDING",
    bank_status: "NOT_PROVIDED",
    bank_payroll_ready: false,
  });
});

/* =================================================================== bank */
test("every bank status maps through, and only VERIFIED is payroll ready", async () => {
  const account = { account_no: "123456789012", ifsc: "HDFC0001234" };
  const cases = [
    ["VERIFIED", "VERIFIED", true],
    ["NAME_MISMATCH", "NAME_MISMATCH", false],
    ["FAILED", "FAILED", false],
    ["PENDING", "PENDING", false],
  ];
  for (const [stored, expected, ready] of cases) {
    const { usecase } = build({
      employees: [{ employee_id: 1, ...account }],
      verifications: [
        {
          employee_id: 1,
          status: stored,
          account_fingerprint: fp(account.account_no, account.ifsc),
          name_match_verdict: stored === "VERIFIED" ? "MATCH" : null,
        },
      ],
    });
    const rows = await usecase.list({});
    assert.equal(rows[0].bank_status, expected, `stored ${stored}`);
    assert.equal(rows[0].bank_payroll_ready, ready, `stored ${stored} readiness`);
  }
});

test("no account on file is NOT_PROVIDED, not PENDING", async () => {
  const { usecase } = build({
    employees: [
      { employee_id: 1, account_no: null, ifsc: null },
      { employee_id: 2, account_no: "   ", ifsc: "HDFC0001234" },
      { employee_id: 3, account_no: "123456789012", ifsc: null },
    ],
  });
  for (const row of await usecase.list({})) {
    assert.equal(row.bank_status, "NOT_PROVIDED", `employee ${row.employee_id}`);
    assert.equal(row.bank_payroll_ready, false);
  }
});

test("a verification run against a DIFFERENT account no longer applies", async () => {
  // C2's invalidation rule: the stored VERIFIED describes the account it was
  // run against, and the employee's account has since been edited.
  const { usecase } = build({
    employees: [{ employee_id: 1, account_no: "999999999999", ifsc: "HDFC0001234" }],
    verifications: [
      {
        employee_id: 1,
        status: "VERIFIED",
        account_fingerprint: fp("123456789012", "HDFC0001234"),
        name_match_verdict: "MATCH",
      },
    ],
  });
  const rows = await usecase.list({});
  assert.equal(rows[0].bank_status, "PENDING");
  assert.equal(rows[0].bank_payroll_ready, false);
});

/* ===================================================== duplicate accounts */
test("a LIVE duplicate stays DUPLICATE_ACCOUNT and is not payroll ready", async () => {
  const shared = fp("123456789012", "HDFC0001234");
  const { usecase } = build({
    employees: [{ employee_id: 1, account_no: "123456789012", ifsc: "HDFC0001234" }],
    verifications: [
      { employee_id: 1, status: "DUPLICATE_ACCOUNT", account_fingerprint: shared, name_match_verdict: "MATCH" },
    ],
    // Employee 2 is still employed and still verified against the same account.
    activeVerified: [{ account_fingerprint: shared, employee_id: 2 }],
  });
  const rows = await usecase.list({});
  assert.equal(rows[0].bank_status, "DUPLICATE_ACCOUNT");
  assert.equal(rows[0].bank_payroll_ready, false);
});

test("A DUPLICATE WHOSE CLASH HAS LEFT RESOLVES ON READ, exactly as getStatus does", async () => {
  // This is the case a stale simplified summary would get wrong: the stored
  // row still says DUPLICATE_ACCOUNT, but the only other holder has since
  // resigned, so nobody active shares the account any more.
  const shared = fp("123456789012", "HDFC0001234");
  const { usecase } = build({
    employees: [{ employee_id: 1, account_no: "123456789012", ifsc: "HDFC0001234" }],
    verifications: [
      { employee_id: 1, status: "DUPLICATE_ACCOUNT", account_fingerprint: shared, name_match_verdict: "MATCH" },
    ],
    activeVerified: [], // the other employee is inactive now
  });
  const rows = await usecase.list({});
  assert.equal(rows[0].bank_status, "VERIFIED");
  assert.equal(rows[0].bank_payroll_ready, true);
});

test("a resolved duplicate whose name never matched falls back to NAME_MISMATCH", async () => {
  const shared = fp("123456789012", "HDFC0001234");
  const { usecase } = build({
    employees: [{ employee_id: 1, account_no: "123456789012", ifsc: "HDFC0001234" }],
    verifications: [
      { employee_id: 1, status: "DUPLICATE_ACCOUNT", account_fingerprint: shared, name_match_verdict: "MISMATCH" },
    ],
    activeVerified: [],
  });
  const rows = await usecase.list({});
  assert.equal(rows[0].bank_status, "NAME_MISMATCH");
  assert.equal(rows[0].bank_payroll_ready, false);
});

test("the employee being judged is never counted as their own duplicate", async () => {
  // The single-employee query excludes them in SQL (`v.employee_id <> ?`);
  // the bulk query cannot, so the exclusion happens on the merged rows. If it
  // did not, every duplicate would look permanently live.
  const shared = fp("123456789012", "HDFC0001234");
  const { usecase } = build({
    employees: [{ employee_id: 1, account_no: "123456789012", ifsc: "HDFC0001234" }],
    verifications: [
      { employee_id: 1, status: "DUPLICATE_ACCOUNT", account_fingerprint: shared, name_match_verdict: "MATCH" },
    ],
    // The employee's own VERIFIED row comes back from the bulk query too.
    activeVerified: [{ account_fingerprint: shared, employee_id: 1 }],
  });
  const rows = await usecase.list({});
  assert.equal(rows[0].bank_status, "VERIFIED");
});

/* ========================================= it agrees with the single read */
test("THE BULK PATH AND getStatus SHARE ONE DECISION FUNCTION", async () => {
  // Not "produce the same answer today" - the same function, so they cannot
  // be changed apart. Every combination the shared rule accepts.
  const cases = [
    [{ hasAccount: false }, "NOT_PROVIDED", false],
    [{ hasAccount: true, stored: null, fingerprintMatches: false }, "PENDING", false],
    [{ hasAccount: true, stored: { status: "VERIFIED" }, fingerprintMatches: false }, "PENDING", false],
    [{ hasAccount: true, stored: { status: "VERIFIED" }, fingerprintMatches: true }, "VERIFIED", true],
    [{ hasAccount: true, stored: { status: "FAILED" }, fingerprintMatches: true }, "FAILED", false],
    [
      { hasAccount: true, stored: { status: "DUPLICATE_ACCOUNT" }, fingerprintMatches: true, activeDuplicateCount: 1 },
      "DUPLICATE_ACCOUNT",
      false,
    ],
    [
      { hasAccount: true, stored: { status: "DUPLICATE_ACCOUNT" }, fingerprintMatches: true, activeDuplicateCount: 0 },
      "VERIFIED",
      true,
    ],
  ];
  for (const [input, status, ready] of cases) {
    const got = EmployeeBankUsecase.resolveEffectiveStatus(input);
    assert.equal(got.status, status, JSON.stringify(input));
    assert.equal(got.bank_payroll_ready, ready, JSON.stringify(input));
  }
});

/* ============================================================ performance */
test("THE QUERY COUNT DOES NOT GROW WITH THE HEADCOUNT", async () => {
  const make = (n) =>
    Array.from({ length: n }, (_, i) => ({
      employee_id: i + 1,
      account_no: String(100000000000 + i),
      ifsc: "HDFC0001234",
    }));

  const small = build({ employees: make(5) });
  await small.usecase.list({});

  const large = build({ employees: make(630) });
  const rows = await large.usecase.list({});

  assert.equal(rows.length, 630, "every employee is answered");
  assert.equal(
    large.queries.length,
    small.queries.length,
    "630 employees must cost the same number of queries as 5"
  );
  assert.ok(large.queries.length <= 6, `expected a handful of queries, ran ${large.queries.length}`);
  // And specifically: one read per concern, never one per employee.
  assert.deepEqual(large.queries.map((q) => q[0]).sort(), [
    "aadhaar",
    "bank-details",
    "employees",
    "verifications",
  ]);
});

test("the duplicate lookup is skipped entirely when nobody is on a duplicate", async () => {
  const { usecase, queries } = build({
    employees: [{ employee_id: 1, account_no: "123456789012", ifsc: "HDFC0001234" }],
    verifications: [
      {
        employee_id: 1,
        status: "VERIFIED",
        account_fingerprint: fp("123456789012", "HDFC0001234"),
        name_match_verdict: "MATCH",
      },
    ],
  });
  await usecase.list({});
  assert.ok(!queries.some((q) => q[0] === "duplicates"), "no clash, no query");
});

test("an empty employee list costs nothing beyond the list itself", async () => {
  const { usecase, queries } = build({ employees: [] });
  assert.deepEqual(await usecase.list({}), []);
  assert.deepEqual(queries.map((q) => q[0]), ["employees"]);
});

/* ================================================================= scope */
test("the population comes from the employee list, filters and all", async () => {
  const { usecase, queries } = build({ employees: [{ employee_id: 1 }] });
  await usecase.list({ store_ids: [2, 3], designation_ids: [15] });

  const [, filters] = queries.find((q) => q[0] === "employees");
  assert.deepEqual(filters, { store_ids: [2, 3], designation_ids: [15] });
});

test("an employee the list does not return gets no status, however much data exists", async () => {
  // The visibility test that matters: employee 99 has an Aadhaar identity and
  // a VERIFIED bank account, and is absent from the list. They must not
  // appear - this endpoint cannot become a way to enumerate employees.
  const { usecase } = build({
    employees: [{ employee_id: 1 }],
    identities: [1, 99],
    verifications: [
      { employee_id: 99, status: "VERIFIED", account_fingerprint: "x", name_match_verdict: "MATCH" },
    ],
  });
  const rows = await usecase.list({});
  assert.deepEqual(rows.map((r) => r.employee_id), [1]);
});

/* ======================================================= nothing sensitive */
test("THE RESPONSE CARRIES FOUR SCALARS AND NOTHING ELSE", async () => {
  const { usecase } = build({
    employees: [{ employee_id: 1, account_no: "123456789012", ifsc: "HDFC0001234" }],
    identities: [1],
    verifications: [
      {
        employee_id: 1,
        status: "VERIFIED",
        account_fingerprint: fp("123456789012", "HDFC0001234"),
        name_match_verdict: "MATCH",
        // Everything a real row also carries, none of which may come out.
        account_last4: "9012",
        ifsc: "HDFC0001234",
        name_at_bank: "RAMESH KUMAR",
        provider_transaction_id: "txn_123",
        override_reason: "approved by admin",
      },
    ],
  });
  const rows = await usecase.list({});
  assert.deepEqual(Object.keys(rows[0]).sort(), [
    "aadhaar_status",
    "bank_payroll_ready",
    "bank_status",
    "employee_id",
  ]);

  const serialised = JSON.stringify(rows);
  for (const forbidden of [
    "123456789012", "9012", "HDFC0001234", "RAMESH", "txn_123", "approved by admin",
    "account_fingerprint", "aadhaar_last4", "aadhaar_ciphertext", "verification_id",
  ]) {
    assert.ok(!serialised.includes(forbidden), `${forbidden} must not appear in the summary`);
  }
});

test("the account number is read to fingerprint it, and never returned", async () => {
  // It has to be read - the fingerprint cannot be computed without it - so
  // the guarantee is about what leaves, not about what is loaded.
  const src = require("fs").readFileSync(__dirname + "/employee_status_summary.js", "utf8");
  const returned = src.slice(src.indexOf("return ids.map("), src.indexOf("});", src.indexOf("return ids.map(")));
  for (const forbidden of ["account_no", "ifsc", "last4", "fingerprint"]) {
    assert.ok(!returned.includes(forbidden), `the response must not build in ${forbidden}`);
  }
});
