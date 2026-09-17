/**
 * MAPPING PREVIEW - who a rule WOULD cover, before anybody saves it.
 *
 *   node --test usecase/telegram_mapping_preview.test.js
 *
 * The rules under test:
 *
 *   IT WRITES NOTHING AND CALLS TELEGRAM NEVER. Not a row, not a claim, not
 *   a request. A preview that had a side effect would be a rule somebody
 *   applied by looking at it.
 *   THE SCOPE IS THE CALLER'S AND FAILS CLOSED. `NONE` lists nobody.
 *   THE FIELDS ARE THE APPROVED SIX. No salary, Aadhaar, bank, mobile or
 *   Telegram identifier can appear even when the snapshot row carries one.
 *   SEARCH NARROWS WHAT IS SHOWN, NEVER WHAT IS COUNTED.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const buildMapping = require("./telegram_group_mapping");
const { COUNTS_SCOPE, PREVIEW_MESSAGES } = require("../constants/telegram_group_mapping");
const { EMPLOYEE_BRANCH_SCOPE } = require("../utils/employee_branch_scope");

const NOW = new Date("2026-09-16T04:00:00Z"); // 09:30 IST
const TODAY = "2026-09-16";

const emp = (over = {}) => ({
  employee_id: 1,
  employee_name: "Raj",
  store_id: 5,
  designation_id: 7,
  department_id: 3,
  status: 1,
  date_of_joining: "2020-01-01",
  resignation_date: null,
  outlet_name: "ECR",
  designation_name: "Cashier",
  department_name: "Operations",
  ...over,
});

const GROUP = {
  telegram_group_id: 10,
  group_name: "Cashiers",
  category: "HR",
  used_for: "Daily notices",
  outlet_id: 9,
  outlet_name: "Moolakulam",
  bot_is_admin: true,
  is_active: true,
};

const TARGETS = {
  OUTLET: { 5: { name: "ECR", active: true }, 6: { name: "Anna Nagar", active: true } },
  DEPARTMENT: { 3: { name: "Operations", active: true } },
  DESIGNATION: { 7: { name: "Cashier", active: true }, 8: { name: "Packer", active: true } },
};

const makeRepo = ({ employees = [], connected = [], mappings = [], targets = TARGETS } = {}) => {
  const calls = { snapshot: 0, connected: 0, resolveTargets: 0, writes: 0 };
  return {
    calls,
    getByGroup: async () => mappings,
    findDuplicateRule: async () => null,
    resolveTargets: async (idsByDimension) => {
      calls.resolveTargets += 1;
      const out = new Map();
      for (const [dimension, ids] of Object.entries(idsByDimension || {})) {
        if (!ids || ids.length === 0) continue;
        const found = new Map();
        for (const id of ids) {
          const row = (targets[dimension] || {})[id];
          if (row) found.set(Number(id), row);
        }
        out.set(dimension, found);
      }
      return out;
    },
    getEmployeeSnapshot: async () => {
      calls.snapshot += 1;
      return employees;
    },
    getConnectedEmployeeIds: async (ids) => {
      calls.connected += 1;
      return new Set(connected.filter((id) => ids.includes(id)));
    },
    withTransaction: async (fn) => {
      calls.writes += 1;
      return fn({ query: async () => ({}) });
    },
    create: async () => {
      calls.writes += 1;
      return { telegram_group_mapping_id: 1 };
    },
    delete: async () => {
      calls.writes += 1;
      return { affectedRows: 1 };
    },
  };
};

const build = (opts, group = GROUP) =>
  buildMapping(makeRepo(opts), { getById: async (id) => (group && group.telegram_group_id === id ? group : null) }, { now: () => NOW });

const ALL_BRANCHES = { kind: EMPLOYEE_BRANCH_SCOPE.ALL_BRANCHES, store_ids: null };
const ownBranches = (ids) => ({ kind: EMPLOYEE_BRANCH_SCOPE.OWN_BRANCHES, store_ids: ids });
const NONE = { kind: EMPLOYEE_BRANCH_SCOPE.NONE, store_ids: null };

const STAFF = [
  emp({ employee_id: 1, employee_name: "Anitha", store_id: 5, department_id: 3, designation_id: 7 }),
  emp({ employee_id: 2, employee_name: "Bala", store_id: 5, department_id: 3, designation_id: 8 }),
  emp({ employee_id: 3, employee_name: "Chitra", store_id: 6, department_id: 3, designation_id: 7 }),
  emp({ employee_id: 4, employee_name: "Deepa", store_id: 5, department_id: 4, designation_id: 7 }),
];

describe("the preview answers the rule being built", () => {
  it("nothing narrowed previews everybody employed today", async () => {
    const result = await build({ employees: STAFF }).previewEmployees(10, { scope: ALL_BRANCHES });
    assert.equal(result.total_matched, 4);
    assert.equal(result.is_all_employees, true);
    assert.equal(result.rule_label, "All Employees");
    assert.equal(result.as_of_date, TODAY);
  });

  it("each dimension added shrinks the preview", async () => {
    const usecase = build({ employees: STAFF });
    const at = async (body) => (await usecase.previewEmployees(10, { ...body, scope: ALL_BRANCHES })).total_matched;
    assert.equal(await at({}), 4);
    assert.equal(await at({ outlet_id: 5 }), 3);
    assert.equal(await at({ outlet_id: 5, department_id: 3 }), 2);
    assert.equal(await at({ outlet_id: 5, department_id: 3, designation_id: 7 }), 1);
  });

  it("names the rule it previewed, resolved", async () => {
    const result = await build({ employees: STAFF }).previewEmployees(10, {
      outlet_id: 5,
      designation_id: 7,
      scope: ALL_BRANCHES,
    });
    assert.equal(result.rule_label, "Outlet: ECR + Designation: Cashier");
    assert.deepEqual(result.rule, { outlet_id: 5, department_id: null, designation_id: 7 });
  });

  it("excludes a leaver, by the dated rule and not by `status`", async () => {
    const leaver = emp({ employee_id: 9, employee_name: "Gone", status: 1, resignation_date: "2026-01-01" });
    const result = await build({ employees: [...STAFF, leaver] }).previewEmployees(10, { scope: ALL_BRANCHES });
    assert.equal(result.total_matched, 4);
    assert.ok(!result.employees.some((e) => e.employee_id === 9));
  });

  it("refuses a rule it would refuse at save time, with the same sentence", async () => {
    const usecase = build({ employees: STAFF });
    await assert.rejects(() => usecase.previewEmployees(10, { outlet_id: 404, scope: ALL_BRANCHES }), /outlet no longer exists/);
    await assert.rejects(() => usecase.previewEmployees(10, { outlet_id: "abc", scope: ALL_BRANCHES }), /Select a valid outlet/);
  });

  it("refuses a group that does not exist", async () => {
    const usecase = build({ employees: STAFF }, null);
    await assert.rejects(() => usecase.previewEmployees(10, { scope: ALL_BRANCHES }), /not found/);
  });

  it("says whether an identical rule is already saved", async () => {
    const repo = makeRepo({ employees: STAFF });
    repo.findDuplicateRule = async () => ({ telegram_group_mapping_id: 1 });
    const usecase = buildMapping(repo, { getById: async () => GROUP }, { now: () => NOW });
    const result = await usecase.previewEmployees(10, { outlet_id: 5, scope: ALL_BRANCHES });
    assert.equal(result.duplicate_rule, true);
  });
});

describe("the preview writes nothing and calls Telegram never", () => {
  it("performs no write on the mapping repository", async () => {
    const repo = makeRepo({ employees: STAFF });
    const usecase = buildMapping(repo, { getById: async () => GROUP }, { now: () => NOW });
    await usecase.previewEmployees(10, { outlet_id: 5, designation_id: 7, scope: ALL_BRANCHES });
    assert.equal(repo.calls.writes, 0, "a preview must not write");
  });

  it("the usecase has no Telegram service to call at all", async () => {
    // The cheapest guarantee a membership call cannot appear is for there to
    // be nothing to call it on.
    const usecase = build({ employees: STAFF });
    const source = require("node:fs").readFileSync(
      require.resolve("./telegram_group_mapping.js"),
      "utf8"
    );
    assert.doesNotMatch(source, /require\(.*services\/telegram/);
    assert.ok(!("telegram" in usecase), "no telegram service is held");
  });

  it("reads one snapshot and one identity list, whatever the rule", async () => {
    const repo = makeRepo({ employees: STAFF });
    const usecase = buildMapping(repo, { getById: async () => GROUP }, { now: () => NOW });
    await usecase.previewEmployees(10, { outlet_id: 5, department_id: 3, designation_id: 7, scope: ALL_BRANCHES });
    assert.equal(repo.calls.snapshot, 1, "never one query per employee");
    assert.equal(repo.calls.connected, 1);
    assert.equal(repo.calls.resolveTargets, 1, "one resolution pass for all three dimensions");
  });
});

describe("the preview is branch-scoped, and fails closed", () => {
  it("a branch manager previews ONLY their own branch", async () => {
    const result = await build({ employees: STAFF }).previewEmployees(10, {
      designation_id: 7,
      scope: ownBranches([6]),
    });
    assert.equal(result.total_matched, 1, "not the company's three cashiers");
    assert.deepEqual(result.employees.map((e) => e.employee_name), ["Chitra"]);
    assert.equal(result.counts_scope, COUNTS_SCOPE.BRANCH);
  });

  it("a rule naming ANOTHER branch previews nobody, and says so honestly", async () => {
    const result = await build({ employees: STAFF }).previewEmployees(10, {
      outlet_id: 5,
      scope: ownBranches([6]),
    });
    assert.equal(result.total_matched, 0);
    assert.equal(result.counts_scope, COUNTS_SCOPE.BRANCH, "an observation, not a failure");
    // The RULE is still named in full - that is configuration, not staff.
    assert.equal(result.rule_label, "Outlet: ECR");
  });

  it("a NONE scope previews nobody and counts nothing", async () => {
    for (const scope of [NONE, undefined, ownBranches([])]) {
      const result = await build({ employees: STAFF }).previewEmployees(10, { scope });
      assert.equal(result.total_matched, 0);
      assert.equal(result.employees.length, 0);
      assert.equal(result.counts_scope, COUNTS_SCOPE.NONE, "not BRANCH, and never ALL");
    }
  });

  it("an employee with no branch is invisible to a branch-scoped caller", async () => {
    const floating = emp({ employee_id: 5, employee_name: "Eshwar", store_id: null });
    const result = await build({ employees: [floating] }).previewEmployees(10, { scope: ownBranches([5]) });
    assert.equal(result.total_matched, 0);
  });

  it("the COUNT and the LIST agree for the same caller", async () => {
    const result = await build({ employees: STAFF }).previewEmployees(10, {
      outlet_id: 5,
      scope: ownBranches([5]),
    });
    assert.equal(result.total_matched, result.employees.length);
  });
});

describe("what a previewed employee row may contain", () => {
  it("is exactly the approved six fields", async () => {
    const result = await build({ employees: [emp()], connected: [1] }).previewEmployees(10, { scope: ALL_BRANCHES });
    assert.deepEqual(Object.keys(result.employees[0]).sort(), [
      "department_name",
      "designation_name",
      "employee_id",
      "employee_name",
      "outlet_name",
      "telegram_connected",
    ]);
  });

  it("leaks nothing sensitive even when the snapshot row carries it", async () => {
    const loaded = emp({
      salary: 45000,
      aadhaar_number: "1234 5678 9012",
      bank_account_number: "0001234567",
      mobile: "9876543210",
      telegram_user_id: "555000111",
      telegram_chat_id: "-1001234567890",
      telegram_username: "raj",
      pan_number: "ABCDE1234F",
      date_of_birth: "1995-04-04",
    });
    const result = await build({ employees: [loaded] }).previewEmployees(10, { scope: ALL_BRANCHES });
    const body = JSON.stringify(result);
    for (const secret of [
      "45000",
      "1234 5678 9012",
      "0001234567",
      "9876543210",
      "555000111",
      "-1001234567890",
      "ABCDE1234F",
      "1995-04-04",
    ]) {
      assert.ok(!body.includes(secret), `${secret} must not appear in a preview`);
    }
  });

  it("telegram_connected is a boolean yes/no and names no account", async () => {
    const result = await build({
      employees: [emp({ employee_id: 1 }), emp({ employee_id: 2, employee_name: "Bala" })],
      connected: [1],
    }).previewEmployees(10, { scope: ALL_BRANCHES });
    const byId = new Map(result.employees.map((e) => [e.employee_id, e]));
    assert.equal(byId.get(1).telegram_connected, true);
    assert.equal(byId.get(2).telegram_connected, false);
    assert.equal(result.total_connected, 1);
  });

  it("connection does not decide who matches the rule", async () => {
    const result = await build({ employees: STAFF, connected: [] }).previewEmployees(10, { scope: ALL_BRANCHES });
    assert.equal(result.total_matched, 4, "nobody is connected and everybody still matches");
    assert.equal(result.total_connected, 0);
  });
});

describe("search narrows what is shown, never what is counted", () => {
  it("filters the list by name", async () => {
    const result = await build({ employees: STAFF }).previewEmployees(10, {
      scope: ALL_BRANCHES,
      search: "chi",
    });
    assert.deepEqual(result.employees.map((e) => e.employee_name), ["Chitra"]);
  });

  it("leaves the rule's population untouched", async () => {
    // Typing in the search box must not make the operator believe the rule
    // got smaller - that is how a correct rule gets deleted.
    const result = await build({ employees: STAFF }).previewEmployees(10, {
      scope: ALL_BRANCHES,
      search: "chi",
    });
    assert.equal(result.total_matched, 4);
    assert.equal(result.total_connected, 0);
  });

  it("is case-insensitive and ignores surrounding space", async () => {
    for (const search of ["CHITRA", "  chitra  ", "Chi"]) {
      const result = await build({ employees: STAFF }).previewEmployees(10, { scope: ALL_BRANCHES, search });
      assert.equal(result.employees.length, 1, JSON.stringify(search));
    }
  });

  it("an empty search shows everybody the rule covers", async () => {
    for (const search of ["", "   ", null, undefined]) {
      const result = await build({ employees: STAFF }).previewEmployees(10, { scope: ALL_BRANCHES, search });
      assert.equal(result.employees.length, 4, JSON.stringify(search));
    }
  });

  it("cannot be used to reach outside the caller's branch", async () => {
    const result = await build({ employees: STAFF }).previewEmployees(10, {
      scope: ownBranches([6]),
      search: "anitha",
    });
    assert.equal(result.employees.length, 0, "search runs AFTER the scope, never instead of it");
  });
});

describe("the cascade's options come from the employees, not the masters", () => {
  /**
   * ECR (5) has Operations(3)/Cashier(7), Operations(3)/Packer(8) and
   * Billing(4)/Cashier(7). Anna Nagar (6) has Accounts(9)/Manager(10).
   * Nothing at ECR is in Accounts, and nobody at ECR is a Manager.
   */
  const CASCADE = [
    emp({ employee_id: 1, employee_name: "Anitha", store_id: 5, department_id: 3, designation_id: 7, outlet_name: "ECR", department_name: "Operations", designation_name: "Cashier" }),
    emp({ employee_id: 2, employee_name: "Bala", store_id: 5, department_id: 3, designation_id: 8, outlet_name: "ECR", department_name: "Operations", designation_name: "Packer" }),
    emp({ employee_id: 3, employee_name: "Chitra", store_id: 5, department_id: 4, designation_id: 7, outlet_name: "ECR", department_name: "Billing", designation_name: "Cashier" }),
    emp({ employee_id: 4, employee_name: "Deepa", store_id: 6, department_id: 9, designation_id: 10, outlet_name: "Anna Nagar", department_name: "Accounts", designation_name: "Manager" }),
  ];

  const num = (list) => [...list].sort((a, b) => a - b);

  /** The masters behind the cascade fixture, so every id validates. */
  const CASCADE_TARGETS = {
    OUTLET: { 5: { name: "ECR", active: true }, 6: { name: "Anna Nagar", active: true } },
    DEPARTMENT: {
      3: { name: "Operations", active: true },
      4: { name: "Billing", active: true },
      9: { name: "Accounts", active: true },
      77: { name: "Retired Dept", active: true },
    },
    DESIGNATION: {
      7: { name: "Cashier", active: true },
      8: { name: "Packer", active: true },
      10: { name: "Manager", active: true },
    },
  };
  const cascade = (employees = CASCADE) => build({ employees, targets: CASCADE_TARGETS });

  const optionsFor = async (body, scope = ALL_BRANCHES) => {
    const result = await cascade().previewEmployees(10, { ...body, scope });
    const ids = (field) => result.rule_options[field].map((o) => o.id);
    return { ids, raw: result.rule_options };
  };

  it("with nothing chosen, every dimension offers everything present", async () => {
    const { ids } = await optionsFor({});
    assert.deepEqual(ids("outlet_id"), [6, 5], "sorted by name: Anna Nagar, ECR");
    assert.deepEqual(num(ids("department_id")), [3, 4, 9]);
    assert.deepEqual(num(ids("designation_id")), [7, 8, 10]);
  });

  it("ECR narrows Department and Designation to the people AT ECR", async () => {
    // THE RULE THIS BLOCK EXISTS FOR. Accounts(9) and Manager(10) exist in
    // the masters but nobody at ECR is in either, so offering them would let
    // the operator build a rule that matches nobody and read the 0 as a
    // mistake they cannot diagnose.
    const { ids } = await optionsFor({ outlet_id: 5 });
    assert.deepEqual(num(ids("department_id")), [3, 4], "no Accounts");
    assert.deepEqual(num(ids("designation_id")), [7, 8], "no Manager");
  });

  it("ECR + Operations narrows Designation to that population only", async () => {
    const { ids } = await optionsFor({ outlet_id: 5, department_id: 3 });
    assert.deepEqual(num(ids("designation_id")), [7, 8]);
  });

  it("ECR + Billing narrows Designation further still", async () => {
    // Billing at ECR is Chitra alone, a Cashier. Packer must disappear.
    const { ids } = await optionsFor({ outlet_id: 5, department_id: 4 });
    assert.deepEqual(ids("designation_id"), [7], "only Cashier");
  });

  it("a level never narrows ITSELF, or there would be no way back", async () => {
    // Choosing Operations must not reduce the Department list to Operations:
    // the dropdown would then offer only what is already selected.
    const { ids } = await optionsFor({ outlet_id: 5, department_id: 3 });
    assert.deepEqual(num(ids("department_id")), [3, 4], "the sibling stays on offer");
    const outlets = await optionsFor({ outlet_id: 5 });
    assert.deepEqual(outlets.ids("outlet_id"), [6, 5], "Outlet still offers both");
  });

  it("a lower level never narrows a higher one", async () => {
    // Designation is below Outlet, so choosing a designation must leave the
    // outlet list alone - the cascade runs one way.
    const { ids } = await optionsFor({ designation_id: 10 });
    assert.deepEqual(ids("outlet_id"), [6, 5]);
    assert.deepEqual(num(ids("department_id")), [3, 4, 9]);
  });

  it("going back to All restores the wider choices", async () => {
    const narrowed = await optionsFor({ outlet_id: 5 });
    assert.deepEqual(num(narrowed.ids("department_id")), [3, 4]);
    // "All" is sent as an omitted/empty dimension, exactly as the form sends
    // it, and the wider choices must come back.
    const widened = await optionsFor({ outlet_id: "" });
    assert.deepEqual(num(widened.ids("department_id")), [3, 4, 9], "Accounts is back");
    assert.deepEqual(num(widened.ids("designation_id")), [7, 8, 10], "Manager is back");
  });

  it("every option carries the name the snapshot already knows", async () => {
    const { raw } = await optionsFor({ outlet_id: 5 });
    assert.deepEqual(raw.outlet_id, [
      { id: 6, name: "Anna Nagar" },
      { id: 5, name: "ECR" },
    ]);
    assert.deepEqual(raw.department_id.map((o) => o.name).sort(), ["Billing", "Operations"]);
  });

  it("offers no combination that matches nobody", async () => {
    // The promise the whole cascade makes: anything reachable in the form
    // covers at least one person.
    const outlets = (await optionsFor({})).ids("outlet_id");
    for (const outlet_id of outlets) {
      const level = await optionsFor({ outlet_id });
      for (const department_id of level.ids("department_id")) {
        const result = await cascade().previewEmployees(10, {
          outlet_id,
          department_id,
          scope: ALL_BRANCHES,
        });
        assert.ok(result.total_matched > 0, `outlet ${outlet_id} + department ${department_id}`);
      }
    }
  });

  it("excludes a leaver from the options, as it excludes them from the count", async () => {
    // Otherwise a department only a resigned employee was in stays on offer.
    const leaver = emp({ employee_id: 9, employee_name: "Gone", store_id: 5, department_id: 77, designation_id: 7, outlet_name: "ECR", department_name: "Retired Dept", resignation_date: "2026-01-01" });
    const result = await cascade([...CASCADE, leaver]).previewEmployees(10, { scope: ALL_BRANCHES });
    assert.ok(!result.rule_options.department_id.some((o) => o.id === 77));
  });

  it("is branch-scoped - a manager is not offered another branch's departments", async () => {
    const { ids } = await optionsFor({}, ownBranches([5]));
    assert.deepEqual(ids("outlet_id"), [5]);
    assert.deepEqual(num(ids("department_id")), [3, 4], "Accounts belongs to the other branch");
  });

  it("a NONE scope is offered nothing at all", async () => {
    const { ids } = await optionsFor({}, NONE);
    assert.deepEqual(ids("outlet_id"), []);
    assert.deepEqual(ids("department_id"), []);
    assert.deepEqual(ids("designation_id"), []);
  });

  it("skips an employee with no value on a dimension rather than inventing one", async () => {
    const floating = emp({ employee_id: 8, store_id: 5, department_id: null, outlet_name: "ECR" });
    const result = await cascade([...CASCADE, floating]).previewEmployees(10, { scope: ALL_BRANCHES });
    assert.ok(result.rule_options.department_id.every((o) => o.id !== null && o.id > 0));
  });
});

describe("search matches both safe identifiers", () => {
  const PEOPLE = [
    emp({ employee_id: 42, employee_name: "Ravi" }),
    emp({ employee_id: 1425, employee_name: "Kumar" }),
    emp({ employee_id: 7, employee_name: "Ravi Kumar" }),
  ];

  const found = async (search) => {
    const result = await build({ employees: PEOPLE }).previewEmployees(10, { scope: ALL_BRANCHES, search });
    return result.employees.map((e) => e.employee_id).sort((a, b) => a - b);
  };

  it("matches the employee NAME", async () => {
    assert.deepEqual(await found("ravi"), [7, 42]);
    assert.deepEqual(await found("Kumar"), [7, 1425]);
  });

  it("matches the employee ID", async () => {
    assert.deepEqual(await found("1425"), [1425]);
    assert.deepEqual(await found("7"), [7]);
  });

  it("matches an ID as a substring, like every other search box here", async () => {
    assert.deepEqual(await found("42"), [42, 1425]);
  });

  it("still leaves the rule's population untouched", async () => {
    const result = await build({ employees: PEOPLE }).previewEmployees(10, { scope: ALL_BRANCHES, search: "1425" });
    assert.equal(result.employees.length, 1);
    assert.equal(result.total_matched, 3, "the rule still covers everybody");
  });

  it("matches NOTHING else - not a mobile, not an Aadhaar", async () => {
    // Matching those would CONFIRM a value the searcher already had, which
    // is a disclosure even though nothing is printed.
    const loaded = [emp({ employee_id: 3, employee_name: "Raj", mobile: "9876543210", aadhaar_number: "123456789012" })];
    const result = await build({ employees: loaded }).previewEmployees(10, { scope: ALL_BRANCHES, search: "9876543210" });
    assert.equal(result.employees.length, 0);
    const byAadhaar = await build({ employees: loaded }).previewEmployees(10, { scope: ALL_BRANCHES, search: "123456789012" });
    assert.equal(byAadhaar.employees.length, 0);
  });

  it("cannot reach outside the caller's branch", async () => {
    const other = [emp({ employee_id: 99, employee_name: "Elsewhere", store_id: 6 })];
    const result = await build({ employees: other }).previewEmployees(10, { scope: ownBranches([5]), search: "99" });
    assert.equal(result.employees.length, 0);
  });
});

describe("the preview message vocabulary", () => {
  it("names a bound the browser cannot argue with", () => {
    assert.match(PREVIEW_MESSAGES.TOO_MANY_EMPLOYEES, /at most \d+ employees/);
  });
});
