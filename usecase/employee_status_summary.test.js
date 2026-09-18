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
function build({
  employees = [],
  identities = [],
  verifications = [],
  activeVerified = [],
  // `undefined` means this server has no employee-master repository wired, so
  // the HR-onboarding keys are omitted entirely - which is what every test
  // written before they existed asserts.
  statutory = undefined,
  /**
   * THE DEFAULT EMPLOYEE IS PAID BY BANK, WITH A LIVE COSTED SALARY.
   *
   * Bank is the default route because it is the one under which the bank
   * section means anything at all: a cash employee's bank section is Not
   * Applicable, so defaulting to cash would quietly turn every bank test
   * below into a test of nothing. The salary defaults to live and costed so
   * that a test about Aadhaar or PF is not also a test about payroll.
   *
   * NOTE WHAT THAT IMPLIES, because it is the specified behaviour and not a
   * fixture artefact: for a BANK employee whose account has not passed its
   * check, `bank` AND `payroll` are both outstanding - the section is
   * unfinished and they cannot be paid. The tests below assert both.
   *
   * A test that is about payroll or the payment route passes these:
   *   salaries  { [id]: "APPLIED" | "PENDING" }, absent = no live salary
   *   payroll   { [id]: 1 (Bank) | 2 (Cash) | null (nobody has said) }
   */
  salaries = undefined,
  payroll = undefined,
} = {}) {
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
  const masterRepo = statutory
    ? {
        getStatutoryDecisionsMany: async (ids) => {
          queries.push(["statutory", ids]);
          // The real query answers in SQL and returns 1/0, never the flag.
          return ids
            .filter((id) => statutory[id])
            .map((id) => ({
              employee_id: id,
              pf_decided: statutory[id].pf ? 1 : 0,
              esi_decided: statutory[id].esi ? 1 : 0,
              // `pf_applicable = 0` / `esi_applicable = 0`, answered in SQL.
              // Only meaningful where the decision was made at all.
              pf_not_applicable: statutory[id].pfNo ? 1 : 0,
              esi_not_applicable: statutory[id].esiNo ? 1 : 0,
            }));
        },
        getPayrollConfigMany: async (ids) => {
          queries.push(["payroll-config", ids]);
          return ids.map((id) => {
            const type = payroll && id in payroll ? payroll[id] : 1; // Bank by default
            return {
              employee_id: id,
              payment_type_recorded: type === null || type === undefined ? 0 : 1,
              pays_in_cash: Number(type) === 2 ? 1 : 0,
            };
          });
        },
      }
    : undefined;
  // Wired whenever the master repository is: a server that can answer the
  // statutory question can answer the payroll one.
  const salaryRepo = statutory
    ? {
        getCurrentSalaryStatusMany: async (ids, asOf) => {
          queries.push(["salary", ids, asOf]);
          return ids
            .filter((id) => (salaries ? id in salaries : true))
            /*
             * A fixture value is either a `ctc_status` on its own - which is
             * every test that only cares whether the salary was costed - or a
             * whole stored row, for the tests about a row the READ-TIME rule
             * has to complete. The real query returns the row.
             */
            .map((id) => {
              const value = salaries ? salaries[id] : "APPLIED";
              return typeof value === "string"
                ? { employee_id: id, ctc_status: value }
                : { employee_id: id, ...value };
            });
        },
      }
    : undefined;
  return {
    usecase: buildSummary(employeeUsecase, aadhaarRepo, bankRepo, masterRepo, salaryRepo),
    queries,
  };
}

const byId = (rows) => Object.fromEntries(rows.map((r) => [r.employee_id, r]));

/**
 * List AS A CALLER HOLDING `view_employee_sensitive`.
 *
 * The payment route is gated on that key, so a test about cash has to say
 * which caller it is asking as - and a plain `usecase.list({})` is
 * deliberately the OTHER caller, the one who may not see it. Both states are
 * asserted directly further down.
 */
const asSensitive = (usecase, filters = {}) =>
  usecase.list(filters, { disclosePfEsiApplicability: true, disclosePaymentRoute: true });

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

/* ================================================ HR onboarding pending == */
/**
 * The manager-created employee is real and operational the moment Stage 3
 * commits; what is still outstanding is HR's half of the record. These check
 * that "waiting on HR" is DERIVED from the sections themselves, so it cannot
 * disagree with them, and that deriving it discloses no value.
 */
const account = { account_no: "123456789012", ifsc: "HDFC0001234" };
const verified = (employee_id) => ({
  employee_id,
  status: "VERIFIED",
  account_fingerprint: fp(account.account_no, account.ifsc),
  name_match_verdict: "MATCH",
});

test("AADHAAR PENDING ALONE MAKES AN EMPLOYEE HR PENDING", async () => {
  // THE BUSINESS RULE. The store manager owns the FIRST ATTEMPT at Aadhaar;
  // HR owns every unresolved case afterwards, whatever left it unresolved -
  // a failed check, a mismatch, a technical problem, a skip, or a manager who
  // never finished it. Everything else about this employee is done.
  const { usecase } = build({
    employees: [{ employee_id: 704, ...account }],
    verifications: [verified(704)],
    identities: [], // no Aadhaar identity attached
    statutory: { 704: { pf: true, esi: true } },
  });
  const rows = await usecase.list({});
  assert.equal(rows[0].aadhaar_status, "PENDING");
  assert.equal(rows[0].bank_payroll_ready, true);
  assert.equal(rows[0].hr_onboarding_pending, true);
  assert.deepEqual(rows[0].hr_onboarding_missing, ["aadhaar"]);
});

test("AADHAAR VERIFIED WITH EVERYTHING ELSE DONE IS HR COMPLETE", async () => {
  const { usecase } = build({
    employees: [{ employee_id: 701, ...account }],
    verifications: [verified(701)],
    identities: [701],
    statutory: { 701: { pf: true, esi: true } },
  });
  const rows = await usecase.list({});
  assert.equal(rows[0].aadhaar_status, "VERIFIED");
  assert.equal(rows[0].hr_onboarding_pending, false);
  assert.deepEqual(rows[0].hr_onboarding_missing, []);
});

test("VERIFYING THE AADHAAR LATER TAKES THE EMPLOYEE OUT OF THE QUEUE", async () => {
  // The flag is DERIVED from the sections, so nothing has to be marked done:
  // attaching the identity is the whole of it. Same employee, same fixtures,
  // one identity row different.
  const fixtures = {
    employees: [{ employee_id: 709, ...account }],
    verifications: [verified(709)],
    statutory: { 709: { pf: true, esi: true } },
  };
  const before = await build({ ...fixtures, identities: [] }).usecase.list({});
  assert.equal(before[0].hr_onboarding_pending, true);
  assert.deepEqual(before[0].hr_onboarding_missing, ["aadhaar"]);

  const after = await build({ ...fixtures, identities: [709] }).usecase.list({});
  assert.equal(after[0].hr_onboarding_pending, false);
  assert.deepEqual(after[0].hr_onboarding_missing, []);
});

test("an employee a manager has just created is HR-onboarding pending, for all four reasons", async () => {
  // No Aadhaar, nothing statutory decided, no bank account - and so, since
  // they are paid by bank, no way to actually pay them either.
  const { usecase } = build({
    employees: [{ employee_id: 700 }],
    statutory: { 700: { pf: false, esi: false } },
  });
  const rows = await usecase.list({});
  assert.equal(rows[0].hr_onboarding_pending, true);
  assert.deepEqual(rows[0].hr_onboarding_missing, ["aadhaar", "statutory", "bank", "payroll"]);
});

test("AADHAAR AND BANK PENDING NAMES BOTH REASONS, AND NEITHER TWICE", async () => {
  const { usecase } = build({
    employees: [{ employee_id: 720 }], // no account on file
    identities: [],
    statutory: { 720: { pf: true, esi: true } },
  });
  const rows = await usecase.list({});
  assert.equal(rows[0].hr_onboarding_pending, true);
  // Paid by bank with no account: the section is unfinished AND they cannot
  // be paid, which is two facts about one employee, not one counted twice.
  assert.deepEqual(rows[0].hr_onboarding_missing, ["aadhaar", "bank", "payroll"]);
});

test("AADHAAR AND STATUTORY PENDING NAMES BOTH REASONS", async () => {
  const { usecase } = build({
    employees: [{ employee_id: 721, ...account }],
    verifications: [verified(721)],
    identities: [],
    statutory: { 721: { pf: true, esi: false } },
  });
  const rows = await usecase.list({});
  assert.equal(rows[0].hr_onboarding_pending, true);
  assert.deepEqual(rows[0].hr_onboarding_missing, ["aadhaar", "statutory"]);
});

test("every reason appears at most once, whatever the combination", async () => {
  // PF and ESI are ONE section of the profile and keep ONE reason - the
  // existing naming - so two undecided schemes cannot produce "statutory"
  // twice and contradict nothing.
  const { usecase } = build({
    employees: [{ employee_id: 722 }],
    identities: [],
    statutory: { 722: { pf: false, esi: false } },
  });
  const rows = await usecase.list({});
  const missing = rows[0].hr_onboarding_missing;
  assert.deepEqual(missing, ["aadhaar", "statutory", "bank", "payroll"]);
  assert.equal(new Set(missing).size, missing.length, "no reason is repeated");
  // And the flag is exactly "is anything outstanding".
  assert.equal(rows[0].hr_onboarding_pending, missing.length > 0);
});

test("half a statutory decision is still a pending one", async () => {
  const { usecase } = build({
    employees: [{ employee_id: 702, ...account }],
    verifications: [verified(702)],
    identities: [702],
    statutory: { 702: { pf: true, esi: false } },
  });
  const rows = await usecase.list({});
  assert.equal(rows[0].hr_onboarding_pending, true);
  assert.deepEqual(rows[0].hr_onboarding_missing, ["statutory"]);
});

test("PF or ESI recorded as NOT APPLICABLE is a finished decision, not a permanent chase", async () => {
  // `pf_applicable = 0` is a recorded decision, not a blank. An employee in
  // neither scheme is finished.
  const { usecase } = build({
    employees: [{ employee_id: 723, ...account }],
    verifications: [verified(723)],
    identities: [723],
    statutory: { 723: { pf: true, esi: true, pfNo: true, esiNo: true } },
  });
  const rows = await usecase.list({});
  assert.equal(rows[0].hr_onboarding_pending, false);
  assert.deepEqual(rows[0].hr_onboarding_missing, []);
});

test("AN ACCOUNT THAT HAS NOT PASSED ITS CHECK IS STILL HR WORK", async () => {
  // Entering an account number is not finishing the section: until it is
  // payroll ready the employee cannot be paid. Every non-ready state counts,
  // and the Aadhaar and statutory sections here are complete so `bank` is
  // the only reason.
  const cases = [
    ["PENDING", null],
    ["NAME_MISMATCH", "MISMATCH"],
    ["FAILED", null],
  ];
  for (const [status, verdict] of cases) {
    const { usecase } = build({
      employees: [{ employee_id: 703, ...account }],
      verifications: [{ ...verified(703), status, name_match_verdict: verdict }],
      identities: [703],
      statutory: { 703: { pf: true, esi: true } },
    });
    const rows = await usecase.list({});
    assert.equal(rows[0].bank_payroll_ready, false, status);
    assert.equal(rows[0].hr_onboarding_pending, true, status);
    assert.deepEqual(rows[0].hr_onboarding_missing, ["bank", "payroll"], status);
  }
});

test("a LIVE duplicate account is HR work too", async () => {
  const shared = fp(account.account_no, account.ifsc);
  const { usecase } = build({
    employees: [{ employee_id: 724, ...account }],
    verifications: [
      { employee_id: 724, status: "DUPLICATE_ACCOUNT", account_fingerprint: shared, name_match_verdict: "MATCH" },
    ],
    activeVerified: [{ account_fingerprint: shared, employee_id: 999 }],
    identities: [724],
    statutory: { 724: { pf: true, esi: true } },
  });
  const rows = await usecase.list({});
  assert.equal(rows[0].bank_status, "DUPLICATE_ACCOUNT");
  assert.equal(rows[0].bank_payroll_ready, false);
  assert.equal(rows[0].hr_onboarding_pending, true);
  assert.deepEqual(rows[0].hr_onboarding_missing, ["bank", "payroll"]);
});

test("THE FLAG AGREES WITH THE COLUMNS BESIDE IT, BY CONSTRUCTION", async () => {
  // There is ONE definition of HR completion and it lives here, so a screen
  // never has to compose a second one. Across every combination, the flag is
  // true exactly when Aadhaar, bank, PF or ESI is outstanding.
  for (const aadhaar of [true, false]) {
    for (const ready of [true, false]) {
      for (const pf of [true, false]) {
        for (const esi of [true, false]) {
          const id = 730;
          const { usecase } = build({
            employees: [{ employee_id: id, ...(ready ? account : {}) }],
            verifications: ready ? [verified(id)] : [],
            identities: aadhaar ? [id] : [],
            statutory: { [id]: { pf, esi } },
          });
          const row = (await usecase.list({}))[0];
          const expected = !aadhaar || !ready || !pf || !esi;
          const label = `aadhaar=${aadhaar} bank=${ready} pf=${pf} esi=${esi}`;
          assert.equal(row.hr_onboarding_pending, expected, label);
          assert.equal(row.aadhaar_status === "PENDING", !aadhaar, label);
          assert.equal(row.bank_payroll_ready, ready, label);
          assert.equal(row.pf_status === "PENDING", !pf, label);
          assert.equal(row.esi_status === "PENDING", !esi, label);
        }
      }
    }
  }
});

test("a server that cannot tell says nothing, rather than saying 'complete'", async () => {
  const { usecase, queries } = build({ employees: [{ employee_id: 705 }] });
  const rows = await usecase.list({});
  assert.ok(!("hr_onboarding_pending" in rows[0]), "an unknown state is not a false one");
  assert.ok(!("hr_onboarding_missing" in rows[0]));
  assert.ok(!queries.some(([kind]) => kind === "statutory"), "and it does not ask");
});

test("the derivation discloses whether a decision exists, never what it was", async () => {
  const { usecase, queries } = build({
    employees: [{ employee_id: 706 }],
    statutory: { 706: { pf: true, esi: true } },
  });
  const rows = await usecase.list({});
  const serialised = JSON.stringify(rows);
  for (const forbidden of ["pf_applicable", "esi_applicable", "uan", "pf_number", "esi_number"]) {
    assert.ok(!serialised.includes(forbidden), `${forbidden} must not appear in the summary`);
  }
  assert.deepEqual(Object.keys(rows[0]).sort(), [
    "aadhaar_status",
    // The dashboard's route-aware bank section, beside the raw C2 answer
    // about the account itself. Two questions, two keys, neither renamed.
    "bank_payroll_ready",
    "bank_pending",
    "bank_section_status",
    "bank_status",
    // NO `cash_to_bank_pending` HERE, and that is the assertion: this is a
    // plain caller, without `view_employee_sensitive`, so the payment route
    // is absent entirely rather than present and false. The permission tests
    // below check both states directly.
    "employee_id",
    "esi_status",
    "hr_onboarding_missing",
    "hr_onboarding_pending",
    "payroll_missing",
    "payroll_pending",
    "pf_status",
    // The two schemes as one section, for the Statutory card. A derived
    // boolean, not a third copy of either flag.
    "statutory_pending",
  ]);
  // One bulk read for the whole list, like every other read here.
  assert.equal(queries.filter(([kind]) => kind === "statutory").length, 1);
});

/* ================= the per-scheme statuses the Pending HR queue runs on = */

test("PF and ESI are reported separately, from the SAME decision the flag uses", async () => {
  const { usecase } = build({
    employees: [{ employee_id: 710, ...account }],
    verifications: [verified(710)],
    identities: [710],
    statutory: { 710: { pf: true, esi: false } },
  });
  const rows = await usecase.list({});
  assert.equal(rows[0].pf_status, "COMPLETE");
  assert.equal(rows[0].esi_status, "PENDING");
  // And they cannot disagree with the flag beside them: one scheme
  // undecided is exactly what makes the statutory section outstanding.
  assert.equal(rows[0].hr_onboarding_pending, true);
  assert.deepEqual(rows[0].hr_onboarding_missing, ["statutory"]);
});

test("NOT APPLICABLE IS A COMPLETED DECISION, and is named only to a caller who may see it", async () => {
  const employees = [{ employee_id: 711, ...account }];
  const verifications = [verified(711)];
  const identities = [711];
  const statutory = { 711: { pf: true, esi: true, pfNo: true, esiNo: true } };

  // With `view_employee_sensitive`: the recorded answer is named, which is
  // what lets the queue show "Not applicable" instead of "Complete".
  const disclosed = await build({ employees, verifications, identities, statutory }).usecase.list(
    {},
    { disclosePfEsiApplicability: true }
  );
  assert.equal(disclosed[0].pf_status, "NOT_APPLICABLE");
  assert.equal(disclosed[0].esi_status, "NOT_APPLICABLE");

  // Without it: still not outstanding, but WHICH answer was recorded is not
  // disclosed - `pf_applicable` and `esi_applicable` are sensitive under B3.
  const plain = await build({ employees, verifications, identities, statutory }).usecase.list({});
  assert.equal(plain[0].pf_status, "COMPLETE");
  assert.equal(plain[0].esi_status, "COMPLETE");

  // Either way, an employee in neither scheme is FINISHED, not permanently
  // outstanding - which is the whole reason the flags exist.
  assert.equal(disclosed[0].hr_onboarding_pending, false);
  assert.equal(plain[0].hr_onboarding_pending, false);
});

test("a server that cannot derive the statutory decision omits PF and ESI too", async () => {
  // `statutory: undefined` means no employee-master repository is wired. A
  // missing key must never read as "nothing outstanding".
  const { usecase } = build({ employees: [{ employee_id: 712 }] });
  const rows = await usecase.list({}, { disclosePfEsiApplicability: true });
  assert.ok(!("pf_status" in rows[0]));
  assert.ok(!("esi_status" in rows[0]));
  assert.ok(!("hr_onboarding_pending" in rows[0]));
});

test("nothing undecided is ever NOT_APPLICABLE, however it is asked", async () => {
  // A NULL flag is "nobody has been asked", and the disclosure option cannot
  // turn that into an answer.
  const { usecase } = build({
    employees: [{ employee_id: 713 }],
    statutory: { 713: { pf: false, esi: false, pfNo: true, esiNo: true } },
  });
  const rows = await usecase.list({}, { disclosePfEsiApplicability: true });
  assert.equal(rows[0].pf_status, "PENDING");
  assert.equal(rows[0].esi_status, "PENDING");
});

test("it stays one query per read at 600 employees, statutory included", async () => {
  const employees = [];
  const statutory = {};
  for (let id = 1; id <= 600; id += 1) {
    employees.push({ employee_id: id });
    statutory[id] = { pf: id % 2 === 0, esi: true };
  }
  const { usecase, queries } = build({ employees, statutory });
  const rows = await usecase.list({});
  assert.equal(rows.length, 600);
  // employees, aadhaar, bank-details, verifications, statutory, salary,
  // payroll-config. No duplicates query: nobody is on DUPLICATE_ACCOUNT.
  //
  // THE TWO PAYROLL READS ARE BULK READS LIKE THE REST. Payroll added two
  // concerns to this endpoint and therefore two queries - not two per
  // employee, which is the property this test exists to hold.
  assert.equal(queries.length, 7);
  assert.deepEqual(queries.map((q) => q[0]).sort(), [
    "aadhaar",
    "bank-details",
    "employees",
    "payroll-config",
    "salary",
    "statutory",
    "verifications",
  ]);
});

/* ================================================= payroll pending (dashboard) */
/**
 * THE FOURTH HR ITEM, and the one that is NOT the bank column again.
 *
 * The bank column asks whether an account can receive a transfer. Payroll
 * asks whether there is anything to transfer: an agreed, costed salary in
 * effect today, and a recorded way to pay it. An employee can have a verified
 * account and no salary, or a salary and no account, and both are unfinished
 * records - so these pin the two apart rather than trusting they differ.
 *
 * Every rule below is read from the payroll module's own definitions
 * (`getCurrentSalary` and `utils/salary_engine.js`), never restated here.
 */

test("NO LIVE SALARY IS PAYROLL PENDING, whatever else is finished", async () => {
  const { usecase } = build({
    employees: [{ employee_id: 800, ...account }],
    verifications: [verified(800)],
    identities: [800],
    statutory: { 800: { pf: true, esi: true } },
    salaries: {}, // nobody has a salary row
  });
  const rows = await usecase.list({});
  assert.equal(rows[0].payroll_pending, true);
  assert.deepEqual(rows[0].payroll_missing, ["salary"]);
  // And it reaches the overall flag, which is the whole point of the change.
  assert.equal(rows[0].hr_onboarding_pending, true);
  assert.deepEqual(rows[0].hr_onboarding_missing, ["payroll"]);
});

test("A SALARY THAT COULD NOT BE COSTED IS NOT A FINISHED PAYROLL SETUP", async () => {
  // `ctc_status = PENDING` is what the engine writes when an employer cost
  // could not be resolved. A CTC with an unresolved component in it is not a
  // CTC, so it is not a finished setup either.
  const { usecase } = build({
    employees: [{ employee_id: 801, ...account }],
    verifications: [verified(801)],
    identities: [801],
    statutory: { 801: { pf: true, esi: true } },
    salaries: { 801: "PENDING" },
  });
  const rows = await usecase.list({});
  assert.equal(rows[0].payroll_pending, true);
  assert.deepEqual(rows[0].payroll_missing, ["salary_ctc"]);
});

test("a live, costed salary with a recorded payment route is payroll COMPLETE", async () => {
  const { usecase } = build({
    employees: [{ employee_id: 802, ...account }],
    verifications: [verified(802)],
    identities: [802],
    statutory: { 802: { pf: true, esi: true } },
    salaries: { 802: "APPLIED" },
    payroll: { 802: 1 }, // Bank, and the account above is verified
  });
  const rows = await usecase.list({});
  assert.equal(rows[0].payroll_pending, false);
  assert.deepEqual(rows[0].payroll_missing, []);
  assert.equal(rows[0].hr_onboarding_pending, false, "all four complete");
  assert.deepEqual(rows[0].hr_onboarding_missing, []);
});

/*
 * THE QUEUE AND THE PROFILE MUST AGREE ABOUT THE SAME EMPLOYEE.
 *
 * A salary approved before ESI had a standard basis is STORED with
 * `esi_status = PENDING`, a null CTC and an ESI_WAGE_CONTEXT_UNAVAILABLE
 * note. `engine.fillStandardEsi` completes such a record at READ time - which
 * is what `usecase/employee_salary.js#_present` has been doing for the
 * Employee Master - so the profile showed the finished CTC while this queue,
 * reading the stored `ctc_status` column, went on calling the same employee
 * Payroll Pending.
 *
 * These pin the agreement in both directions: what the rule CAN complete, and
 * what it must leave alone.
 */

/** The four components of a 16000 gross, as the engine writes them. */
const LEGACY_SNAPSHOT = {
  esi_employee_rate_percent: 0.75,
  esi_employer_rate_percent: 3.25,
  esi_coverage_ceiling: 21000,
  esi_employee_exemption_daily_wage: 176,
  salary_days_per_month: 26,
  contribution_rounding: "NEAREST_RUPEE",
};

/** A stored row as the EARLIER engine wrote one, at a given gross. */
const legacyRow = (gross, components, notes = [{ code: "ESI_WAGE_CONTEXT_UNAVAILABLE", component: "esi" }]) => ({
  ctc_status: "PENDING",
  esi_status: "PENDING",
  monthly_gross: gross,
  ...components,
  employer_pf_total: 1200,
  edli: 50,
  pf_admin_charge: 50,
  // The driver hands JSON columns back as strings, and the rule needs objects.
  unresolved_notes: JSON.stringify(notes),
  statutory_snapshot: JSON.stringify(LEGACY_SNAPSHOT),
});

test("A. THE PRODUCTION BUG: a legacy 16000 row is NOT Payroll Pending", async () => {
  // Employee View presents this row as Employee ESI 75, Employer ESI 325 and
  // a CTC of 17625. Before this fix the queue read the stored PENDING and
  // disagreed with it about the same person on the same day.
  const { usecase } = build({
    employees: [{ employee_id: 901, ...account }],
    verifications: [verified(901)],
    identities: [901],
    statutory: { 901: { pf: true, esi: true } },
    salaries: {
      901: legacyRow(16000, { basic: 10000, conveyance: 2500, hra: 3500, special_allowance: 0 }),
    },
    payroll: { 901: 1 },
  });
  const rows = await usecase.list({});
  assert.equal(rows[0].payroll_pending, false, "the stored column is not the answer");
  assert.deepEqual(rows[0].payroll_missing, []);
  assert.equal(rows[0].hr_onboarding_pending, false);
});

test("A2. and the queue agrees with the Employee Master on the SAME row", async () => {
  // Not "both say false" by coincidence: the same function, on the same row,
  // is what produces both answers.
  const engine = require("../utils/salary_engine");
  const row = legacyRow(16000, { basic: 10000, conveyance: 2500, hra: 3500, special_allowance: 0 });
  const presented = engine.fillStandardEsi({
    ...row,
    unresolved_notes: JSON.parse(row.unresolved_notes),
    statutory_snapshot: JSON.parse(row.statutory_snapshot),
  });
  assert.equal(presented.employee_esi, 75);
  assert.equal(presented.employer_esi, 325);
  assert.equal(presented.monthly_ctc, 17625);
  assert.equal(presented.ctc_status, "APPLIED");

  const { usecase } = build({
    employees: [{ employee_id: 902, ...account }],
    verifications: [verified(902)],
    identities: [902],
    statutory: { 902: { pf: true, esi: true } },
    salaries: { 902: row },
    payroll: { 902: 1 },
  });
  const rows = await usecase.list({});
  assert.equal(rows[0].payroll_pending, presented.ctc_status !== "APPLIED");
});

test("B. a GENUINELY unresolved salary stays Payroll Pending", async () => {
  // Nobody recorded whether this employee is in ESI. The rule declines to
  // complete that, and the queue must not clear it either.
  const { usecase } = build({
    employees: [{ employee_id: 903, ...account }],
    verifications: [verified(903)],
    identities: [903],
    statutory: { 903: { pf: true, esi: true } },
    salaries: {
      903: legacyRow(
        16000,
        { basic: 10000, conveyance: 2500, hra: 3500, special_allowance: 0 },
        [{ code: "ESI_APPLICABILITY_NOT_RECORDED", component: "esi" }]
      ),
    },
    payroll: { 903: 1 },
  });
  const rows = await usecase.list({});
  assert.equal(rows[0].payroll_pending, true);
  assert.deepEqual(rows[0].payroll_missing, ["salary_ctc"]);
});

test("C. a legacy ABOVE-CEILING row stays Payroll Pending", async () => {
  // 60000 gross: statutory wages are above the coverage ceiling, and whether
  // the employee was covered when the contribution period began cannot be
  // proved from the row alone. That is an open question, not a zero - and not
  // a finished payroll setup.
  const { usecase } = build({
    employees: [{ employee_id: 904, ...account }],
    verifications: [verified(904)],
    identities: [904],
    statutory: { 904: { pf: true, esi: true } },
    salaries: {
      904: legacyRow(60000, {
        basic: 30000,
        conveyance: 2500,
        hra: 10000,
        special_allowance: 17500,
      }),
    },
    payroll: { 904: 1 },
  });
  const rows = await usecase.list({});
  assert.equal(rows[0].payroll_pending, true, "an unprovable period must not be cleared");
  assert.deepEqual(rows[0].payroll_missing, ["salary_ctc"]);
});

test("D. a newly stored APPLIED salary is complete, exactly as before", async () => {
  // A record the current engine wrote never reaches the completion rule at
  // all, and its stored answer is the answer.
  const { usecase } = build({
    employees: [{ employee_id: 905, ...account }],
    verifications: [verified(905)],
    identities: [905],
    statutory: { 905: { pf: true, esi: true } },
    salaries: {
      905: {
        ctc_status: "APPLIED",
        esi_status: "APPLIED",
        monthly_gross: 16000,
        basic: 10000,
        conveyance: 2500,
        hra: 3500,
        special_allowance: 0,
        employee_esi: 75,
        employer_esi: 325,
        monthly_ctc: 17625,
        unresolved_notes: "[]",
        statutory_snapshot: JSON.stringify(LEGACY_SNAPSHOT),
      },
    },
    payroll: { 905: 1 },
  });
  const rows = await usecase.list({});
  assert.equal(rows[0].payroll_pending, false);
  assert.deepEqual(rows[0].payroll_missing, []);
});

test("E. no live approved salary is still Payroll Pending", async () => {
  const { usecase } = build({
    employees: [{ employee_id: 906, ...account }],
    verifications: [verified(906)],
    identities: [906],
    statutory: { 906: { pf: true, esi: true } },
    salaries: {}, // nothing current for this employee
    payroll: { 906: 1 },
  });
  const rows = await usecase.list({});
  assert.equal(rows[0].payroll_pending, true);
  assert.deepEqual(rows[0].payroll_missing, ["salary"]);
});

test("F. ONE bulk salary read, whatever the head count", async () => {
  // The rule is arithmetic over rows already in hand. A per-employee read
  // here is 630 queries to draw one screen, which is why the bulk query
  // exists at all.
  const many = Array.from({ length: 40 }, (_, i) => ({ employee_id: 1000 + i, ...account }));
  const salaries = {};
  for (const e of many) {
    salaries[e.employee_id] = legacyRow(16000, {
      basic: 10000,
      conveyance: 2500,
      hra: 3500,
      special_allowance: 0,
    });
  }
  const { usecase, queries } = build({
    employees: many,
    verifications: many.map((e) => verified(e.employee_id)),
    identities: many.map((e) => e.employee_id),
    statutory: Object.fromEntries(many.map((e) => [e.employee_id, { pf: true, esi: true }])),
    salaries,
    payroll: Object.fromEntries(many.map((e) => [e.employee_id, 1])),
  });
  const rows = await usecase.list({});
  assert.equal(rows.length, 40);
  assert.equal(queries.filter(([kind]) => kind === "salary").length, 1, "one salary query, not 40");
  for (const row of rows) assert.equal(row.payroll_pending, false);
});

test("NO SALARY AMOUNT LEAVES THIS ENDPOINT, though the rule now reads them", async () => {
  // The bulk read had to widen to run the rule. The RESPONSE must not: a
  // queue needs a badge, not a payslip, and `view_employee_sensitive` is not
  // what gates this endpoint.
  const { usecase } = build({
    employees: [{ employee_id: 907, ...account }],
    verifications: [verified(907)],
    identities: [907],
    statutory: { 907: { pf: true, esi: true } },
    salaries: {
      907: legacyRow(16000, { basic: 10000, conveyance: 2500, hra: 3500, special_allowance: 0 }),
    },
    payroll: { 907: 1 },
  });
  const rows = await usecase.list({});
  const serialised = JSON.stringify(rows[0]);
  for (const leak of ["16000", "17625", "10000", "monthly_gross", "monthly_ctc", "employer_esi", "basic"]) {
    assert.ok(!serialised.includes(leak), `${leak} must not reach the response`);
  }
  assert.equal(rows[0].payroll_pending, false, "only the boolean");
});

test("NOBODY HAS SAID HOW TO PAY THEM, so payroll is pending", async () => {
  const { usecase } = build({
    employees: [{ employee_id: 803, ...account }],
    verifications: [verified(803)],
    identities: [803],
    statutory: { 803: { pf: true, esi: true } },
    salaries: { 803: "APPLIED" },
    payroll: { 803: null }, // payment_type not recorded
  });
  const rows = await usecase.list({});
  assert.equal(rows[0].payroll_pending, true);
  assert.deepEqual(rows[0].payroll_missing, ["payment_type"]);
});

test("BANK-PAID WITHOUT A PAYROLL-READY ACCOUNT IS PAYROLL PENDING TOO", async () => {
  // Chosen Bank, account on file, verification never passed. They cannot be
  // paid, so both the bank column AND payroll say so - two different facts
  // about the same employee, not one counted twice.
  const { usecase } = build({
    employees: [{ employee_id: 804, ...account }],
    verifications: [{ ...verified(804), status: "FAILED", name_match_verdict: null }],
    identities: [804],
    statutory: { 804: { pf: true, esi: true } },
    salaries: { 804: "APPLIED" },
    payroll: { 804: 1 }, // Bank
  });
  const rows = await usecase.list({});
  assert.equal(rows[0].bank_payroll_ready, false);
  assert.deepEqual(rows[0].payroll_missing, ["payment_account"]);
  assert.deepEqual(rows[0].hr_onboarding_missing, ["bank", "payroll"]);
});

test("A CASH-PAID EMPLOYEE IS NOT HELD UP BY A BANK ACCOUNT THEY DO NOT NEED", async () => {
  // The payroll half of it: Cash needs no account, so payroll is complete.
  // The BANK column still reports what it has always reported - that is the
  // definition the dashboard was given, and it is not changed here.
  const { usecase } = build({
    employees: [{ employee_id: 805 }], // no account at all
    identities: [805],
    statutory: { 805: { pf: true, esi: true } },
    salaries: { 805: "APPLIED" },
    payroll: { 805: 2 }, // Cash
  });
  const rows = await usecase.list({});
  assert.equal(rows[0].payroll_pending, false, "cash needs no account");
  assert.equal(rows[0].bank_status, "NOT_PROVIDED");
});

test("EVERY REASON APPEARS AT MOST ONCE ACROSS ALL FOUR ITEMS", async () => {
  const { usecase } = build({
    employees: [{ employee_id: 806 }],
    identities: [],
    statutory: { 806: { pf: false, esi: false } },
    salaries: {},
    payroll: { 806: null },
  });
  const rows = await usecase.list({});
  const missing = rows[0].hr_onboarding_missing;
  // NO "bank" HERE, and that is the point: nobody has recorded how this
  // employee is paid, so there is no way to say whether they need an account.
  // The thing that IS outstanding - the unrecorded payment type - is reported
  // once, by payroll, rather than twice under two names.
  assert.deepEqual(missing, ["aadhaar", "statutory", "payroll"]);
  assert.equal(new Set(missing).size, missing.length, "no reason is repeated");
  assert.equal(rows[0].hr_onboarding_pending, missing.length > 0);
});

test("HR PENDING IS EXACTLY THE UNION OF THE FOUR, over every combination", async () => {
  // The property the dashboard is specified on, checked exhaustively across
  // the payment route as well: HR is pending if and only if at least one of
  // Aadhaar, Bank, Statutory and Payroll is - and being paid in cash is not
  // one of them.
  for (const aadhaarDone of [false, true]) {
    for (const bankDone of [false, true]) {
      for (const statutoryDone of [false, true]) {
        for (const payrollDone of [false, true]) {
          for (const route of [1, 2, null]) {
            const id = 900;
            const { usecase } = build({
              employees: [{ employee_id: id, ...(bankDone ? account : {}) }],
              verifications: bankDone ? [verified(id)] : [],
              identities: aadhaarDone ? [id] : [],
              statutory: { [id]: { pf: statutoryDone, esi: statutoryDone } },
              salaries: payrollDone ? { [id]: "APPLIED" } : {},
              payroll: { [id]: route },
            });
            const row = (await asSensitive(usecase))[0];

            const label = JSON.stringify({ aadhaarDone, bankDone, statutoryDone, payrollDone, route });
            const four = [
              row.aadhaar_status !== "VERIFIED",
              row.bank_pending,
              row.statutory_pending,
              row.payroll_pending,
            ];

            assert.equal(
              row.hr_onboarding_pending,
              four.some(Boolean),
              `HR pending must be the union ${label}`
            );
            assert.equal(
              row.hr_onboarding_pending === false,
              four.every((p) => !p),
              `HR complete means all four complete ${label}`
            );
            // THE CASH MIGRATION IS NEVER ONE OF THE FOUR. Whatever else is
            // true, being on cash cannot by itself make HR pending.
            assert.equal(
              row.cash_to_bank_pending,
              route === null ? undefined : route === 2,
              `cash flag follows the route alone, and is absent without one ${label}`
            );
            assert.ok(
              !row.hr_onboarding_missing.includes("cash_to_bank"),
              `the cash migration is not an HR reason ${label}`
            );
          }
        }
      }
    }
  }
});

/* ========================== the five specified semantic cases ========== */
/**
 * The exact table the dashboard was specified on, asserted case by case
 * rather than inferred from the properties above - these are the answers
 * somebody will check by hand against the screen.
 */
test("CASE 1 - paid by bank, account not verified", async () => {
  const { usecase } = build({
    employees: [{ employee_id: 910, ...account }],
    verifications: [{ ...verified(910), status: "FAILED", name_match_verdict: null }],
    identities: [910],
    statutory: { 910: { pf: true, esi: true } },
    salaries: { 910: "APPLIED" },
    payroll: { 910: 1 },
  });
  const row = (await asSensitive(usecase))[0];
  assert.equal(row.bank_pending, true, "Bank Pending = YES");
  assert.equal(row.cash_to_bank_pending, false, "Cash to Bank = NO");
  assert.equal(row.payroll_pending, true, "Payroll Pending = YES");
  assert.equal(row.hr_onboarding_pending, true, "HR Pending = YES");
  assert.deepEqual(row.payroll_missing, ["payment_account"]);
});

test("CASE 2 - paid in cash, everything else ready", async () => {
  const { usecase } = build({
    employees: [{ employee_id: 911 }], // no account, and none needed
    identities: [911],
    statutory: { 911: { pf: true, esi: true } },
    salaries: { 911: "APPLIED" },
    payroll: { 911: 2 },
  });
  const row = (await asSensitive(usecase))[0];
  assert.equal(row.bank_pending, false, "Bank Pending = NO");
  assert.equal(row.bank_section_status, "NOT_APPLICABLE", "and it is N/A, not Complete");
  assert.equal(row.cash_to_bank_pending, true, "Cash to Bank = YES");
  assert.equal(row.payroll_pending, false, "Payroll Pending = NO");
  assert.equal(row.hr_onboarding_pending, false, "HR must NOT be pending merely for being cash");
  assert.deepEqual(row.hr_onboarding_missing, []);
});

test("CASE 3 - paid in cash, no salary", async () => {
  const { usecase } = build({
    employees: [{ employee_id: 912 }],
    identities: [912],
    statutory: { 912: { pf: true, esi: true } },
    salaries: {},
    payroll: { 912: 2 },
  });
  const row = (await asSensitive(usecase))[0];
  assert.equal(row.cash_to_bank_pending, true, "Cash to Bank = YES");
  assert.equal(row.payroll_pending, true, "Payroll Pending = YES");
  assert.equal(row.hr_onboarding_pending, true, "HR Pending = YES");
  assert.deepEqual(row.payroll_missing, ["salary"]);
  assert.deepEqual(row.hr_onboarding_missing, ["payroll"], "for payroll, not for cash");
});

test("CASE 4 - payment type not recorded", async () => {
  const { usecase } = build({
    employees: [{ employee_id: 913, ...account }],
    verifications: [verified(913)],
    identities: [913],
    statutory: { 913: { pf: true, esi: true } },
    salaries: { 913: "APPLIED" },
    payroll: { 913: null },
  });
  const row = (await asSensitive(usecase))[0];
  assert.equal(row.bank_pending, false, "Bank Pending = NO");
  assert.equal(row.bank_section_status, "UNKNOWN", "there is no way to say yet");
  assert.ok(!("cash_to_bank_pending" in row), "not false - nobody has said how they are paid");
  assert.equal(row.payroll_pending, true, "Payroll Pending = YES");
  assert.deepEqual(row.payroll_missing, ["payment_type"]);
  assert.equal(row.hr_onboarding_pending, true, "HR Pending = YES");
});

test("CASE 5 - paid by bank, verified account, everything complete", async () => {
  const { usecase } = build({
    employees: [{ employee_id: 914, ...account }],
    verifications: [verified(914)],
    identities: [914],
    statutory: { 914: { pf: true, esi: true } },
    salaries: { 914: "APPLIED" },
    payroll: { 914: 1 },
  });
  const row = (await asSensitive(usecase))[0];
  assert.equal(row.bank_pending, false);
  assert.equal(row.bank_section_status, "COMPLETE");
  assert.equal(row.cash_to_bank_pending, false);
  assert.equal(row.payroll_pending, false);
  assert.equal(row.hr_onboarding_pending, false, "HR Complete");
  assert.deepEqual(row.hr_onboarding_missing, []);
});

test("THE RAW BANK ANSWER IS UNCHANGED AND STILL REPORTED", async () => {
  // `bank_status` / `bank_payroll_ready` are the C2 answer about the ACCOUNT,
  // which the profile and the employee list render. The dashboard's
  // route-aware question is a separate key, so neither had to change meaning
  // for the other - and a cash employee's account, if they have one, is still
  // described accurately.
  const { usecase } = build({
    employees: [{ employee_id: 915, ...account }],
    verifications: [verified(915)],
    statutory: { 915: { pf: true, esi: true } },
    payroll: { 915: 2 }, // cash, but an account exists and is verified
  });
  const row = (await asSensitive(usecase))[0];
  assert.equal(row.bank_status, "VERIFIED");
  assert.equal(row.bank_payroll_ready, true);
  assert.equal(row.bank_section_status, "NOT_APPLICABLE", "they are not paid that way");
  assert.equal(row.bank_pending, false);
});

test("statutory_pending is pf OR esi, and NOT_APPLICABLE is not pending", async () => {
  const cases = [
    [{ pf: true, esi: true }, false],
    [{ pf: true, esi: false }, true],
    [{ pf: false, esi: true }, true],
    [{ pf: false, esi: false }, true],
    // Recorded as "not in the scheme" is a decision, so it is finished.
    [{ pf: true, esi: true, pfNo: true, esiNo: true }, false],
  ];
  for (const [decision, expected] of cases) {
    const { usecase } = build({
      employees: [{ employee_id: 807 }],
      statutory: { 807: decision },
    });
    const rows = await usecase.list({});
    assert.equal(rows[0].statutory_pending, expected, JSON.stringify(decision));
    // It cannot disagree with the two columns it is derived from.
    assert.equal(
      rows[0].statutory_pending,
      rows[0].pf_status === "PENDING" || rows[0].esi_status === "PENDING",
      JSON.stringify(decision)
    );
  }
});

test("A SERVER WITH NO SALARY MODULE SAYS SO, rather than reporting payroll finished", async () => {
  // The same rule every other key here follows: not wired is omitted, never
  // guessed - and an unanswerable payroll item leaves the overall flag
  // unanswered too, because a union missing a term is not the union.
  const { usecase } = build({ employees: [{ employee_id: 808 }] }); // no statutory => no repos
  const rows = await usecase.list({});
  assert.ok(!("payroll_pending" in rows[0]), "an unknown state is not a false one");
  assert.ok(!("payroll_missing" in rows[0]));
  assert.ok(!("hr_onboarding_pending" in rows[0]));
});

test("the payroll reads carry no money, no breakup and no effective date out", async () => {
  const { usecase } = build({
    employees: [{ employee_id: 809, ...account }],
    verifications: [verified(809)],
    identities: [809],
    statutory: { 809: { pf: true, esi: true } },
    salaries: { 809: "APPLIED" },
  });
  const serialised = JSON.stringify(await usecase.list({}));
  for (const forbidden of [
    "monthly_gross", "monthly_ctc", "basic", "hra", "salary_id", "effective_from",
    "employee_pf", "employer_pf_total", "statutory_snapshot", "unresolved_notes",
    "payment_type",
  ]) {
    assert.ok(!serialised.includes(forbidden), `${forbidden} must not appear in the summary`);
  }
});

/* ============== the payment route is sensitive, and is gated like one === */
/**
 * `payment_type` is B3-sensitive, so "paid in cash" goes only to a caller
 * holding `view_employee_sensitive`. What matters as much as withholding it
 * is HOW it is withheld: absent, never false - a false would let a screen
 * count zero and announce that nobody is on cash.
 */
const cashEmployee = (id) => ({
  employees: [{ employee_id: id }],
  identities: [id],
  statutory: { [id]: { pf: true, esi: true } },
  salaries: { [id]: "APPLIED" },
  payroll: { [id]: 2 },
});

test("WITHOUT view_employee_sensitive THE CASH FLAG IS ABSENT, NOT FALSE", async () => {
  const { usecase } = build(cashEmployee(920));
  const row = (await usecase.list({}))[0];
  assert.ok(
    !("cash_to_bank_pending" in row),
    "a false here would be counted as 'nobody is on cash', which is worse than no card"
  );
  // The route is not named anywhere else either: NOT_APPLICABLE says "paid in
  // cash" in as many words, so it collapses to UNKNOWN for this caller.
  assert.equal(row.bank_section_status, "UNKNOWN");
  assert.ok(!JSON.stringify(row).includes("NOT_APPLICABLE"));
  assert.ok(!JSON.stringify(row).includes("payment_type"));
});

test("WITH view_employee_sensitive IT IS DISCLOSED IN FULL", async () => {
  const { usecase } = build(cashEmployee(921));
  const row = (await asSensitive(usecase))[0];
  assert.equal(row.cash_to_bank_pending, true);
  assert.equal(row.bank_section_status, "NOT_APPLICABLE");
});

test("THE PERMISSION CHANGES NOTHING ELSE ON THE ROW", async () => {
  // The gate withholds a reason, never a count: Bank, Statutory, Payroll and
  // HR must be identical for both callers, or two people looking at the same
  // dashboard would see different numbers.
  const fixtures = [
    ["cash, finished", cashEmployee(922)],
    ["bank, unverified", {
      employees: [{ employee_id: 923, ...account }],
      verifications: [{ ...verified(923), status: "FAILED", name_match_verdict: null }],
      identities: [923],
      statutory: { 923: { pf: true, esi: true } },
      salaries: { 923: "APPLIED" },
      payroll: { 923: 1 },
    }],
    ["route unrecorded", {
      employees: [{ employee_id: 924, ...account }],
      verifications: [verified(924)],
      identities: [924],
      statutory: { 924: { pf: true, esi: true } },
      salaries: { 924: "APPLIED" },
      payroll: { 924: null },
    }],
  ];

  for (const [label, fixture] of fixtures) {
    const plain = (await build(fixture).usecase.list({}))[0];
    const sensitive = (await asSensitive(build(fixture).usecase))[0];
    for (const key of [
      "bank_pending", "statutory_pending", "payroll_pending",
      "hr_onboarding_pending", "bank_status", "bank_payroll_ready", "aadhaar_status",
    ]) {
      assert.deepEqual(plain[key], sensitive[key], `${label}: ${key} must not depend on the permission`);
    }
    assert.deepEqual(
      plain.hr_onboarding_missing,
      sensitive.hr_onboarding_missing,
      `${label}: HR reasons must not depend on the permission`
    );
  }
});

test("A CASH EMPLOYEE IS STILL NOT BANK PENDING FOR AN UNPRIVILEGED CALLER", async () => {
  // The functional rule survives the gate: the Bank card shows the same
  // number to everyone, only the reason behind it is withheld.
  const { usecase } = build(cashEmployee(925));
  const row = (await usecase.list({}))[0];
  assert.equal(row.bank_pending, false);
  assert.equal(row.hr_onboarding_pending, false, "HR is still the union of the four");
  assert.deepEqual(row.hr_onboarding_missing, []);
});
