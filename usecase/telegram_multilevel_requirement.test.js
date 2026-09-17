/**
 * MULTI-LEVEL RULES REACH THE PHASES THAT ACT ON THEM.
 *
 *   node --test usecase/telegram_multilevel_requirement.test.js
 *
 * A composite rule that the Map screen displays correctly but that Phase 3B
 * and Phase 3C read as a single dimension would be the worst possible
 * outcome: the screen would say "Cashiers at Moolakulam" and the system
 * would require every cashier in the company to join. Both paths go through
 * the SAME `matchesDimension`, and these tests pin that they do.
 *
 * WHAT THIS FILE DOES NOT DO is add a membership rule of its own. It asserts
 * that the one matcher decides both answers.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const buildMembership = require("./employee_telegram_membership");
const buildReconcile = require("./telegram_membership_reconcile");

const NOW = new Date("2026-09-16T04:00:00Z"); // 09:30 IST

const emp = (over = {}) => ({
  employee_id: 1,
  employee_name: "Raj",
  store_id: 5,
  department_id: 3,
  designation_id: 7,
  status: 1,
  date_of_joining: "2020-01-01",
  resignation_date: null,
  ...over,
});

const group = (id, name) => ({
  telegram_group_id: id,
  group_name: name,
  chat_id: `-100${id}`,
  category: "HR",
  used_for: "Notices",
  outlet_id: null,
  bot_is_admin: true,
  is_active: true,
});

/** A stored multi-level rule on a group. */
const rule = (id, groupId, dims = {}) => ({
  telegram_group_mapping_id: id,
  telegram_group_id: groupId,
  rule_outlet_id: Number(dims.outlet_id || 0),
  rule_department_id: Number(dims.department_id || 0),
  rule_designation_id: Number(dims.designation_id || 0),
  group: group(groupId, `Group ${groupId}`),
});

const mappingRepo = (mappings) => ({ getAllMappingsWithGroups: async () => mappings });

/**
 * Both usecases are built with only what `requiredGroups` / `ruleGroups`
 * touch. Anything else they hold is irrelevant to the question asked here,
 * and supplying it would hide a dependency this path must not have.
 */
const required3B = async (mappings, employee) => {
  const usecase = buildMembership({
    mappingRepo: mappingRepo(mappings),
    now: () => NOW,
  });
  const groups = await usecase.requiredGroups(employee);
  return groups.map((g) => g.telegram_group_id).sort();
};

const required3C = async (mappings, employee) => {
  const usecase = buildReconcile({
    mappingRepo: mappingRepo(mappings),
    now: () => NOW,
  });
  const groups = await usecase.ruleGroups(employee);
  return [...groups.keys()].sort();
};

describe("a composite rule requires only the people it names", () => {
  const mappings = [
    // "Cashiers at outlet 5" - the rule the whole feature exists for.
    rule(1, 10, { outlet_id: 5, designation_id: 7 }),
  ];

  it("Phase 3B requires the cashier AT that outlet", async () => {
    assert.deepEqual(await required3B(mappings, emp()), [10]);
  });

  it("Phase 3B does NOT require a cashier at another outlet", async () => {
    // Under OR this would be [10], and every cashier in the company would be
    // told to join a single store's group.
    assert.deepEqual(await required3B(mappings, emp({ store_id: 6 })), []);
  });

  it("Phase 3B does NOT require a non-cashier at that outlet", async () => {
    assert.deepEqual(await required3B(mappings, emp({ designation_id: 8 })), []);
  });

  it("Phase 3C reaches exactly the same answers", async () => {
    assert.deepEqual(await required3C(mappings, emp()), [10]);
    assert.deepEqual(await required3C(mappings, emp({ store_id: 6 })), []);
    assert.deepEqual(await required3C(mappings, emp({ designation_id: 8 })), []);
  });
});

describe("the two phases cannot disagree about any rule", () => {
  const mappings = [
    rule(1, 10, {}),
    rule(2, 11, { outlet_id: 5 }),
    rule(3, 12, { outlet_id: 5, department_id: 3 }),
    rule(4, 13, { outlet_id: 5, department_id: 3, designation_id: 7 }),
    rule(5, 14, { department_id: 3, designation_id: 7 }),
    rule(6, 15, { outlet_id: 6 }),
  ];

  const people = [];
  for (const store_id of [5, 6]) {
    for (const department_id of [3, 4]) {
      for (const designation_id of [7, 8]) {
        people.push(emp({ employee_id: people.length + 1, store_id, department_id, designation_id }));
      }
    }
  }

  it("agree employee by employee, across every combination", async () => {
    for (const person of people) {
      assert.deepEqual(
        await required3C(mappings, person),
        await required3B(mappings, person),
        JSON.stringify({
          store: person.store_id,
          dept: person.department_id,
          desig: person.designation_id,
        })
      );
    }
  });

  it("the all-employees rule requires everybody, whatever else is stored", async () => {
    for (const person of people) {
      assert.ok((await required3B(mappings, person)).includes(10), person.employee_id);
    }
  });

  it("the three-dimension rule requires exactly one of the eight combinations", async () => {
    const hits = [];
    for (const person of people) {
      if ((await required3B(mappings, person)).includes(13)) hits.push(person.employee_id);
    }
    assert.equal(hits.length, 1, "only outlet 5 + department 3 + designation 7");
  });
});

describe("employment still decides before any dimension does", () => {
  const mappings = [rule(1, 10, { outlet_id: 5, designation_id: 7 })];

  it("a leaver carrying status = 1 is required to be in nothing", async () => {
    const leaver = emp({ status: 1, resignation_date: "2026-01-01" });
    assert.deepEqual(await required3B(mappings, leaver), []);
    assert.deepEqual(await required3C(mappings, leaver), []);
  });

  it("somebody who has not joined yet is required to be in nothing", async () => {
    const future = emp({ date_of_joining: "2026-12-01" });
    assert.deepEqual(await required3B(mappings, future), []);
    assert.deepEqual(await required3C(mappings, future), []);
  });
});

describe("a legacy rule read after the migration means what it always meant", () => {
  it("a migrated OUTLET rule requires the same people as before", async () => {
    const migrated = [rule(1, 10, { outlet_id: 5 })];
    const legacy = [
      {
        telegram_group_mapping_id: 1,
        telegram_group_id: 10,
        mapping_type: "OUTLET",
        target_id: 5,
        group: group(10, "Group 10"),
      },
    ];
    for (const person of [emp(), emp({ store_id: 6 }), emp({ designation_id: 8 })]) {
      assert.deepEqual(
        await required3B(migrated, person),
        await required3B(legacy, person),
        `employee at store ${person.store_id}`
      );
    }
  });
});
