/**
 * IFSC lookup: the local master, and when the provider is worth paying.
 *
 *   node --test usecase/ifsc_lookup.test.js
 *
 * ================================================== WHAT THESE PROTECT =====
 *
 * Two things, and they pull in opposite directions.
 *
 * The first is MONEY. Every provider call costs, and an IFSC-to-branch
 * mapping is the same answer for every employee who banks at that branch. A
 * change that quietly reinstated a call per lookup would not fail anything
 * else - the feature would still work, and the bill would arrive later. So
 * the provider here is a spy that COUNTS, and the counts are asserted.
 *
 * The second is HONESTY about failure. "There is no such branch code" and
 * "the provider could not answer" are different sentences to a person
 * retyping an IFSC, and collapsing them is how somebody ends up correcting a
 * code that was right all along.
 *
 * The repository and the provider are both fakes: no test may reach MySQL or
 * Sandbox.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const { IfscLookupUsecase, normalise, IFSC_PATTERN } = require("./ifsc_lookup");
const { SandboxError, FAILURE } = require("../services/sandbox_client");
const kycConfig = require("../config/sandbox_kyc");

const IFSC = "SBIN0010507";
const RESULT = { exists: true, ifsc: IFSC, bank_name: "State Bank of India", branch_name: "Lawspet" };

/** An in-memory `ifsc_master`, counting the writes as well as the reads. */
function fakeRepo(seed = null) {
  const rows = new Map();
  if (seed) rows.set(seed.ifsc, { ...seed });
  return {
    rows,
    gets: [],
    upserts: [],
    async get(ifsc) {
      this.gets.push(ifsc);
      return rows.has(ifsc) ? { ...rows.get(ifsc) } : null;
    },
    async upsert(row) {
      this.upserts.push({ ...row });
      rows.set(row.ifsc, { ...row, last_checked_at: new Date() });
      return row;
    },
  };
}

/** A Sandbox bank service that never leaves the process, and counts its calls. */
function fakeProvider(behaviour) {
  return {
    calls: [],
    isEnabled: () => true,
    async lookupIfsc(ifsc) {
      this.calls.push(ifsc);
      if (typeof behaviour === "function") return behaviour(ifsc);
      return behaviour;
    },
  };
}

const daysAgo = (n) => new Date(Date.now() - n * 86400000);

/* ============================ 1. cache miss ============================== */

test("A CACHE MISS CALLS THE PROVIDER ONCE AND STORES THE ANSWER", async () => {
  const repo = fakeRepo();
  const provider = fakeProvider(RESULT);
  const out = await new IfscLookupUsecase(repo, provider).lookup(IFSC);

  assert.deepStrictEqual(provider.calls, [IFSC], "exactly one provider call");
  assert.strictEqual(out.code, 200);
  assert.strictEqual(out.bank_name, "State Bank of India");
  assert.strictEqual(out.branch_name, "Lawspet");
  assert.strictEqual(out.cached, false);

  // And it was written, so the next employee at this branch is free.
  assert.deepStrictEqual(repo.upserts, [
    { ifsc: IFSC, bank_name: "State Bank of India", branch_name: "Lawspet" },
  ]);
});

/* ============================ 2. cache hit =============================== */

test("A FRESH CACHE HIT DOES NOT CALL THE PROVIDER AT ALL", async () => {
  const repo = fakeRepo({
    ifsc: IFSC,
    bank_name: "State Bank of India",
    branch_name: "Lawspet",
    last_checked_at: daysAgo(3),
  });
  const provider = fakeProvider(() => {
    throw new Error("the provider must not be called for a fresh row");
  });

  const out = await new IfscLookupUsecase(repo, provider).lookup(IFSC);
  assert.strictEqual(provider.calls.length, 0, "no provider call, and therefore no charge");
  assert.strictEqual(out.code, 200);
  assert.strictEqual(out.bank_name, "State Bank of India");
  assert.strictEqual(out.branch_name, "Lawspet");
  assert.strictEqual(out.cached, true);
  assert.strictEqual(repo.upserts.length, 0, "a read must not write");
});

test("TWO DIFFERENT EMPLOYEES AT ONE BRANCH COST ONE PROVIDER CALL", async () => {
  // The saving this whole table exists for. Nothing about the lookup is
  // per-employee, so the second one is served from the row the first stored.
  const repo = fakeRepo();
  const provider = fakeProvider(RESULT);
  const usecase = new IfscLookupUsecase(repo, provider);

  const first = await usecase.lookup(IFSC);
  const second = await usecase.lookup(IFSC);

  assert.strictEqual(provider.calls.length, 1, "the second lookup must be free");
  assert.strictEqual(first.cached, false);
  assert.strictEqual(second.cached, true);
  assert.strictEqual(second.branch_name, first.branch_name);
});

/* ============================ 3. staleness =============================== */

test("A STALE ROW IS REFRESHED ONCE, THEN SERVED FROM CACHE AGAIN", async () => {
  const stale = kycConfig.bank.ifscCacheDays + 1;
  const repo = fakeRepo({
    ifsc: IFSC,
    bank_name: "Old Bank Name",
    branch_name: "Old Branch",
    last_checked_at: daysAgo(stale),
  });
  const provider = fakeProvider(RESULT);
  const usecase = new IfscLookupUsecase(repo, provider);

  const refreshed = await usecase.lookup(IFSC);
  assert.strictEqual(provider.calls.length, 1);
  assert.strictEqual(refreshed.bank_name, "State Bank of India", "the new answer wins");
  assert.strictEqual(refreshed.branch_name, "Lawspet");
  assert.strictEqual(repo.upserts.length, 1);

  // The refresh moved `last_checked_at`, so the next one is free again.
  const again = await usecase.lookup(IFSC);
  assert.strictEqual(provider.calls.length, 1, "the refresh must reset the window");
  assert.strictEqual(again.cached, true);
});

test("the freshness window is the configured one, not a number in the code", async () => {
  const days = kycConfig.bank.ifscCacheDays;
  assert.strictEqual(days, 180, "the agreed window");

  const usecase = new IfscLookupUsecase(fakeRepo(), fakeProvider(RESULT));
  const row = (age) => ({ bank_name: "B", branch_name: "Br", last_checked_at: daysAgo(age) });
  assert.strictEqual(usecase.isFresh(row(days - 1)), true, "just inside is fresh");
  assert.strictEqual(usecase.isFresh(row(days + 1)), false, "just outside is stale");

  // And no source file states the number itself - it lives in config.
  for (const f of ["usecase/ifsc_lookup.js", "repository/ifsc_master.js", "services/sandbox_bank.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
    assert.ok(!/\b180\b/.test(src), `${f} must not hard-code the window`);
  }
});

test("an unreadable or missing timestamp counts as stale, never as fresh", async () => {
  const usecase = new IfscLookupUsecase(fakeRepo(), fakeProvider(RESULT));
  for (const bad of [null, undefined, "", "not a date"]) {
    assert.strictEqual(
      usecase.isFresh({ bank_name: "B", branch_name: "Br", last_checked_at: bad }),
      false
    );
  }
  // A row missing either name is unusable regardless of its age.
  assert.strictEqual(usecase.isFresh({ bank_name: "B", branch_name: null, last_checked_at: new Date() }), false);
});

/* ============================ 4. invalid format ========================== */

test("A MALFORMED IFSC IS REFUSED LOCALLY - NO PROVIDER CALL, NO DB READ", async () => {
  // A typo must not cost money or a round trip. This is checked before
  // anything else happens.
  const bad = ["", "SBIN001050", "SBIN00105077", "SBI0010507", "SBIN1010507", "1234567890X", null, undefined];
  for (const value of bad) {
    const repo = fakeRepo();
    const provider = fakeProvider(RESULT);
    const out = await new IfscLookupUsecase(repo, provider).lookup(value);

    assert.strictEqual(out.code, 422, `${String(value)} must be refused`);
    assert.strictEqual(provider.calls.length, 0, `${String(value)} must not reach the provider`);
    assert.strictEqual(repo.gets.length, 0, `${String(value)} must not even be looked up`);
  }
});

test("the format rule is the same one the rest of the system uses", () => {
  // Penny-Less, this lookup and the frontend must agree about what an IFSC
  // is, or a code accepted by one is rejected by another.
  const bankService = fs.readFileSync(path.join(__dirname, "..", "services/sandbox_bank.js"), "utf8");
  assert.match(bankService, /\/\^\[A-Z\]\{4\}0\[A-Z0-9\]\{6\}\$\//);
  assert.strictEqual(IFSC_PATTERN.source, "^[A-Z]{4}0[A-Z0-9]{6}$");
});

/* ============================ 5. invalid IFSC ============================ */

test("AN IFSC THE PROVIDER DOES NOT KNOW IS A CLEAN 404, AND IS NOT CACHED", async () => {
  const repo = fakeRepo();
  const provider = fakeProvider({ exists: false, ifsc: IFSC, bank_name: null, branch_name: null });

  const out = await new IfscLookupUsecase(repo, provider).lookup(IFSC);
  assert.strictEqual(out.code, 404);
  assert.match(out.msg, /Invalid IFSC/);
  // A "no" is not reference data: a code that does not exist today may be
  // issued next year, and a cached negative would outlive the truth.
  assert.strictEqual(repo.upserts.length, 0, "a negative answer must never be cached");
  assert.strictEqual(repo.rows.size, 0);
});

test("a not-found answer never overwrites a row we already had", async () => {
  const repo = fakeRepo({
    ifsc: IFSC,
    bank_name: "State Bank of India",
    branch_name: "Lawspet",
    last_checked_at: daysAgo(kycConfig.bank.ifscCacheDays + 1),
  });
  const provider = fakeProvider({ exists: false });

  const out = await new IfscLookupUsecase(repo, provider).lookup(IFSC);
  assert.strictEqual(out.code, 404);
  assert.strictEqual(repo.upserts.length, 0);
  assert.strictEqual(repo.rows.get(IFSC).bank_name, "State Bank of India", "the old row survives");
});

/* ============================ 6. provider unavailable ==================== */

test("A PROVIDER FAILURE IS NEVER REPORTED AS AN INVALID IFSC", async () => {
  // The distinction this module exists to keep. A 404 means "fix your typo";
  // anything else must not, or somebody retypes a correct code until they
  // give up.
  for (const category of [
    FAILURE.UNAVAILABLE,
    FAILURE.TIMEOUT,
    FAILURE.AUTH_FAILED,
    FAILURE.RATE_LIMITED,
    FAILURE.NOT_ENTITLED,
    FAILURE.UNEXPECTED,
  ]) {
    const repo = fakeRepo();
    const provider = fakeProvider(() => {
      throw new SandboxError(category, "safe message", 502);
    });
    const out = await new IfscLookupUsecase(repo, provider).lookup(IFSC);

    assert.notStrictEqual(out.code, 404, `${category} must not read as an invalid IFSC`);
    assert.notStrictEqual(out.code, 200, `${category} must not read as a success`);
    assert.ok(!/Invalid IFSC/.test(out.msg || ""), `${category} must not say the code is wrong`);
    assert.strictEqual(repo.upserts.length, 0, `${category} must not be cached`);
  }
});

test("a provider outage does not erase an answer already held", async () => {
  // Refusing to fill the form in helps nobody when we know the branch: the
  // row is served, and flagged stale rather than passed off as fresh.
  const repo = fakeRepo({
    ifsc: IFSC,
    bank_name: "State Bank of India",
    branch_name: "Lawspet",
    last_checked_at: daysAgo(kycConfig.bank.ifscCacheDays + 5),
  });
  const provider = fakeProvider(() => {
    throw new SandboxError(FAILURE.UNAVAILABLE, "safe message", 502);
  });

  const out = await new IfscLookupUsecase(repo, provider).lookup(IFSC);
  assert.strictEqual(out.code, 200);
  assert.strictEqual(out.branch_name, "Lawspet");
  assert.strictEqual(out.stale, true, "and it says so");
  assert.strictEqual(repo.upserts.length, 0, "a failed refresh must not be recorded as one");
});

test("a provider that is switched off is a 503, not an invalid IFSC", async () => {
  const repo = fakeRepo();
  const off = { isEnabled: () => false, lookupIfsc: () => assert.fail("must not be called") };
  const out = await new IfscLookupUsecase(repo, off).lookup(IFSC);
  assert.strictEqual(out.code, 503);
  assert.ok(!/Invalid IFSC/.test(out.msg));

  // With no service wired at all, likewise.
  const none = await new IfscLookupUsecase(repo, null).lookup(IFSC);
  assert.strictEqual(none.code, 503);
});

/* ============================ 7. normalisation =========================== */

test("LOWER CASE, SPACES AND DASHES ALL RESOLVE TO ONE CACHE KEY", async () => {
  const repo = fakeRepo();
  const provider = fakeProvider(RESULT);
  const usecase = new IfscLookupUsecase(repo, provider);

  for (const spelling of ["sbin0010507", "SBIN 0010507", " sbin 0010507 ", "SBIN-0010507", "SbIn0010507"]) {
    const out = await usecase.lookup(spelling);
    assert.strictEqual(out.code, 200, `${spelling} must resolve`);
    assert.strictEqual(out.ifsc, IFSC, `${spelling} must normalise to ${IFSC}`);
  }
  // Five spellings, one provider call, one row.
  assert.strictEqual(provider.calls.length, 1, "spelling must not defeat the cache");
  assert.strictEqual(repo.rows.size, 1);
  assert.deepStrictEqual([...repo.rows.keys()], [IFSC]);
});

test("normalise is pure and total", () => {
  assert.strictEqual(normalise(" sbin 0010507 "), IFSC);
  assert.strictEqual(normalise(null), "");
  assert.strictEqual(normalise(undefined), "");
  assert.strictEqual(normalise(123), "123");
});

test("the provider is asked for the NORMALISED code, and stores it normalised", async () => {
  const repo = fakeRepo();
  const provider = fakeProvider(RESULT);
  await new IfscLookupUsecase(repo, provider).lookup("sbin 0010507");
  assert.deepStrictEqual(provider.calls, [IFSC]);
  assert.strictEqual(repo.upserts[0].ifsc, IFSC);
});

/* ============================ 8. minimal exposure ======================== */

test("ONLY THE IFSC AND THE TWO NAMES ARE RETURNED", async () => {
  // Sandbox sends city, district, state, address, MICR and the payment-rail
  // flags. None of it is stored, and none of it is returned.
  const repo = fakeRepo();
  const provider = fakeProvider({
    exists: true,
    ifsc: IFSC,
    bank_name: "State Bank of India",
    branch_name: "Lawspet",
    // Anything the service might one day pass through must not leak.
    city: "Puducherry",
    address: "100 Feet Road",
    MICR: "605002003",
    UPI: true,
  });

  const out = await new IfscLookupUsecase(repo, provider).lookup(IFSC);
  assert.deepStrictEqual(Object.keys(out).sort(), ["bank_name", "branch_name", "cached", "code", "ifsc"]);
  for (const leaked of ["city", "address", "MICR", "UPI", "state", "district"]) {
    assert.ok(!(leaked in out), `${leaked} must not be returned`);
  }
  // Nor stored.
  assert.deepStrictEqual(Object.keys(repo.upserts[0]).sort(), ["bank_name", "branch_name", "ifsc"]);
});

test("the table itself holds only the four agreed columns", () => {
  const sql = fs.readFileSync(
    path.join(__dirname, "..", "migrations/mysql/migrations/sqls/20260909180000-c2-ifsc-master-up.sql"),
    "utf8"
  );
  const body = sql.slice(sql.indexOf("CREATE TABLE"));
  for (const wanted of ["`ifsc`", "`bank_name`", "`branch_name`", "`last_checked_at`"]) {
    assert.ok(body.includes(wanted), `${wanted} must exist`);
  }
  for (const unwanted of ["city", "district", "state", "address", "micr", "neft", "rtgs", "imps", "upi"]) {
    assert.ok(!new RegExp("`" + unwanted, "i").test(body), `${unwanted} must not be a column`);
  }
  // The IFSC is the identity, which is what makes concurrent lookups converge.
  assert.match(body, /PRIMARY KEY \(`ifsc`\)/);
});

/* ============================ 9. nothing leaks =========================== */

test("NO PROVIDER PAYLOAD, TOKEN, HEADER OR STACK CAN REACH A CALLER OR A LOG", async () => {
  const repo = fakeRepo();
  const provider = fakeProvider(() => {
    const err = new SandboxError(FAILURE.UNAVAILABLE, "The verification provider is unavailable", 502);
    // A real axios error carries all of this. None of it may survive.
    err.response = { headers: { authorization: "SECRET-TOKEN" }, data: { raw: "payload" } };
    throw err;
  });

  const out = await new IfscLookupUsecase(repo, provider).lookup(IFSC);
  const serialised = JSON.stringify(out);
  for (const secret of ["SECRET-TOKEN", "authorization", "payload", "stack", "x-api-key"]) {
    assert.ok(!serialised.includes(secret), `${secret} must not reach the caller`);
  }
  // Only a category-derived safe message, and only the fields we chose.
  assert.deepStrictEqual(Object.keys(out).sort(), ["code", "msg"]);
});

test("this module has no logger of its own, and logs no code", () => {
  // The repository logs a failing query with the IFSC and nothing else; this
  // module logs nothing at all, so there is no path by which a response body
  // could be written to a log from here.
  const src = fs.readFileSync(path.join(__dirname, "ifsc_lookup.js"), "utf8");
  assert.ok(!/require\(["'].*logger/.test(src), "the usecase must not import a logger");
  assert.ok(!/console\.(log|error|warn)/.test(src), "and must not print");

  // The repository does log a failing query, so what matters there is WHAT it
  // logs: the IFSC - a public branch code naming no person - and nothing else.
  const repo = fs.readFileSync(path.join(__dirname, "..", "repository/ifsc_master.js"), "utf8");
  const logCall = repo.slice(repo.indexOf("_log(code, err, ref"), repo.indexOf("_query(code, sql, params)"));
  assert.match(logCall, /description: err\.toString\(\)/);
  for (const field of ["bank_name", "branch_name", "rows", "sql", "params"]) {
    assert.ok(!logCall.includes(field), `the repository log must not carry ${field}`);
  }
  // The one ref it builds is the IFSC alone.
  assert.match(repo, /\{ \.\.\.\(params && params\[0\] \? \{ ifsc: params\[0\] \} : \{\}\) \}/);
});

/* ============================ the Penny-Less contract ==================== */

test("THE PENNY-LESS VERIFICATION CONTRACT IS UNTOUCHED", async () => {
  const bank = fs.readFileSync(path.join(__dirname, "..", "services/sandbox_bank.js"), "utf8");
  // Still the same path, still reading both inputs, still returning the same
  // two facts. The IFSC lookup is a sibling, not a replacement.
  assert.match(bank, /pennyLessPathTemplate/);
  assert.match(bank, /async pennyLessVerify\(\{ account_number, ifsc \}\)/);
  assert.match(bank, /account_exists/);
  assert.match(bank, /name_at_bank/);

  // The lookup path takes an IFSC and nothing else - no account number can
  // reach it even by mistake.
  const lookup = bank.slice(bank.indexOf("async lookupIfsc"));
  assert.match(lookup, /^async lookupIfsc\(ifsc\)/);
  assert.ok(!/account_number/.test(lookup), "the lookup must not mention an account number");

  // And the route still reads the account server-side.
  const routes = fs.readFileSync(path.join(__dirname, "..", "routes/employee_master.js"), "utf8");
  assert.match(
    routes,
    /"\/employee\/:employee_id\/bank\/verify",\s*this\.permissions\.requireAll\(P\.VERIFY_EMPLOYEE_BANK, P\.VIEW_EMPLOYEE_SENSITIVE\)/
  );
});

test("the lookup route is authenticated, uses existing permissions, and adds none", () => {
  const routes = fs.readFileSync(path.join(__dirname, "..", "routes/employee_master.js"), "utf8");
  const route = routes.slice(routes.indexOf('"/bank/ifsc/:ifsc"'));
  assert.match(
    route.slice(0, 300),
    /this\.permissions\.requireAll\(P\.EDIT_EMPLOYEE_SENSITIVE, P\.VIEW_EMPLOYEE_SENSITIVE\)/,
    "both keys, and requireAll - `require` would be either-of"
  );

  // No new permission key was declared anywhere for this.
  const perms = fs.readFileSync(path.join(__dirname, "..", "constants/hr_permissions.js"), "utf8");
  assert.ok(!/ifsc/i.test(perms), "no IFSC permission may be introduced");

  const migration = fs.readFileSync(
    path.join(__dirname, "..", "migrations/mysql/migrations/sqls/20260909180000-c2-ifsc-master-up.sql"),
    "utf8"
  );
  assert.ok(!/all_permissions/.test(migration), "the migration must grant nothing");
});
