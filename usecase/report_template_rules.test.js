/**
 * Reports — template ownership and stale-template reconciliation.
 *
 *   node --test usecase/report_template_rules.test.js
 *
 * The case this file exists for, and the one tested hardest:
 *
 *   a template filtered to ONE outlet; that outlet is deleted; dropping the
 *   stale value leaves no outlet filter, which does not mean "no results" but
 *   "every outlet" - so a one-branch report silently becomes a whole-company
 *   export.
 *
 * Everything else here is ownership, where the rule is that a shared template
 * belongs to the person who made it and "Save a Copy" is the path for anyone
 * who wants it different.
 */
const test = require("node:test");
const assert = require("node:assert");

const {
  TEMPLATE_KIND,
  kindOf,
  templatePermissions,
  canSeeTemplate,
  buildCopy,
  reconcileLookupFilter,
  reconcileStatus,
  widensResultSet,
  exportGate,
} = require("./report_template_rules");

const alice = { userId: 21 };
const bob = { userId: 42 };

const personal = { template_id: 1, template_name: "Mine", owner_user_id: 21, is_shared: 0, is_system: 0, field_keys: ["employee_id"], filters: {} };
const shared = { template_id: 2, template_name: "Team", owner_user_id: 21, is_shared: 1, is_system: 0, field_keys: ["employee_id"], filters: {} };
const system = { template_id: 3, template_name: "PF List", owner_user_id: null, is_shared: 1, is_system: 1, field_keys: ["uan"], filters: {} };

/* ============================================================= ownership */
test("the three kinds are distinguished by their flags", () => {
  assert.strictEqual(kindOf(personal), TEMPLATE_KIND.PERSONAL);
  assert.strictEqual(kindOf(shared), TEMPLATE_KIND.SHARED);
  assert.strictEqual(kindOf(system), TEMPLATE_KIND.SYSTEM);
});

test("a personal template is the owner's alone", () => {
  assert.deepStrictEqual(templatePermissions(personal, alice), {
    canRun: true, canEdit: true, canDelete: true, canCopy: true, kind: "personal",
  });
  const forBob = templatePermissions(personal, bob);
  assert.strictEqual(forBob.canRun, false);
  assert.strictEqual(forBob.canEdit, false);
  assert.strictEqual(canSeeTemplate(personal, bob), false, "and he cannot even see it");
});

test("A NON-OWNER MAY RUN AND COPY A SHARED TEMPLATE, BUT NOT EDIT OR DELETE IT", () => {
  const forBob = templatePermissions(shared, bob);
  assert.strictEqual(forBob.canRun, true);
  assert.strictEqual(forBob.canCopy, true);
  assert.strictEqual(forBob.canEdit, false, "editing would change what colleagues see");
  assert.strictEqual(forBob.canDelete, false);
  assert.strictEqual(canSeeTemplate(shared, bob), true);

  const forAlice = templatePermissions(shared, alice);
  assert.strictEqual(forAlice.canEdit, true);
  assert.strictEqual(forAlice.canDelete, true);
});

test("A SYSTEM TEMPLATE IS EDITABLE BY NOBODY, INCLUDING AN ADMIN", () => {
  for (const actor of [alice, bob, { userId: 1, isAdmin: true }]) {
    const p = templatePermissions(system, actor);
    assert.strictEqual(p.canRun, true);
    assert.strictEqual(p.canCopy, true);
    assert.strictEqual(p.canEdit, false, "Save a Copy is the explicit path");
    assert.strictEqual(p.canDelete, false);
  }
});

test("a copy is a fresh personal template owned by the copier", () => {
  const copy = buildCopy(system, bob, "");
  assert.strictEqual(copy.owner_user_id, 42);
  assert.strictEqual(copy.is_system, 0);
  assert.strictEqual(copy.is_shared, 0);
  assert.strictEqual(copy.template_name, "PF List (copy)");
  assert.deepStrictEqual(copy.field_keys, ["uan"], "the ordered keys carry over");
  // And it is a copy, not a reference.
  copy.field_keys.push("pan_no");
  assert.deepStrictEqual(system.field_keys, ["uan"]);
});

/* ================================================== filter reconciliation */
const OUTLET = { field: "outlet_ids", label: "Outlet" };

test("all values still resolvable and active: nothing to say", () => {
  const r = reconcileLookupFilter([2, 3], new Set([2, 3, 4]), new Set([2, 3, 4]), OUTLET);
  assert.deepStrictEqual(r.values, [2, 3]);
  assert.deepStrictEqual(r.warnings, []);
});

test("AN INACTIVE BUT RESOLVABLE VALUE IS KEPT, NOT DISCARDED", () => {
  // A closed branch's staff are exactly who a leavers report is about, and
  // dropping the filter because the branch shut would widen the report.
  const r = reconcileLookupFilter([2, 3], new Set([2, 3]), new Set([2]), OUTLET);
  assert.deepStrictEqual(r.values, [2, 3], "the inactive outlet is still filtered on");
  assert.strictEqual(r.warnings.length, 1);
  assert.strictEqual(r.warnings[0].type, "filter_value_inactive");
  assert.strictEqual(r.warnings[0].widens_result_set, false, "keeping a value cannot widen");
});

test("SOME values unresolvable: the filter survives and NARROWS", () => {
  const r = reconcileLookupFilter([2, 99], new Set([2]), new Set([2]), OUTLET);
  assert.deepStrictEqual(r.values, [2]);
  const w = r.warnings.find((x) => x.type === "filter_value_unresolvable");
  assert.ok(w);
  assert.strictEqual(w.widens_result_set, false, "a restrictive value remains");
  assert.match(w.message, /remaining selection still applies/);
});

test("EVERY VALUE UNRESOLVABLE: THE FILTER IS LOST AND THE RESULT WIDENS", () => {
  const r = reconcileLookupFilter([99], new Set([2, 3]), new Set([2, 3]), OUTLET);
  assert.deepStrictEqual(r.values, [], "no filter left");
  const w = r.warnings.find((x) => x.type === "filter_value_unresolvable");
  assert.strictEqual(w.widens_result_set, true, "one outlet has become all outlets");
  assert.match(w.message, /more outlets than before/);
});

test("an empty saved filter is not a widening event", () => {
  // It never restricted anything, so nothing was lost.
  const r = reconcileLookupFilter([], new Set([2]), new Set([2]), OUTLET);
  assert.deepStrictEqual(r.values, []);
  assert.deepStrictEqual(r.warnings, []);
  assert.strictEqual(widensResultSet(r.warnings), false);
});

test("the same rules apply to department and designation", () => {
  for (const meta of [
    { field: "department_ids", label: "Department" },
    { field: "designation_ids", label: "Designation" },
  ]) {
    const lost = reconcileLookupFilter([88], new Set([1]), new Set([1]), meta);
    assert.strictEqual(lost.values.length, 0);
    assert.strictEqual(lost.warnings[0].widens_result_set, true);
    assert.strictEqual(lost.warnings[0].field, meta.field);
  }
});

test("an unrecognised saved status falls back to Active, not to All", () => {
  const r = reconcileStatus("terminated", ["active", "inactive", "all"]);
  assert.strictEqual(r.value, "active", "the safest option, never the widest");
  assert.strictEqual(r.warnings[0].widens_result_set, false);

  assert.deepStrictEqual(reconcileStatus("all", ["active", "inactive", "all"]).warnings, []);
  assert.strictEqual(reconcileStatus(undefined, ["active", "inactive", "all"]).value, "active");
});

/* ==================================================== the export gate === */
test("an export with no widening proceeds without ceremony", () => {
  assert.deepStrictEqual(exportGate([], undefined), { allowed: true });
  const narrowing = [{ type: "filter_value_unresolvable", widens_result_set: false }];
  assert.deepStrictEqual(exportGate(narrowing, undefined), { allowed: true });
});

test("A WIDENED EXPORT IS REFUSED UNTIL IT IS ACKNOWLEDGED", () => {
  const widened = [
    { type: "filter_value_unresolvable", field: "outlet_ids", widens_result_set: true, message: "..." },
    { type: "field_unavailable", widens_result_set: false },
  ];
  const blocked = exportGate(widened, undefined);
  assert.strictEqual(blocked.allowed, false);
  assert.strictEqual(blocked.code, "FILTER_WIDENED");
  assert.strictEqual(blocked.httpCode, 409);
  // Only the widening warnings are put to the caller; the rest is noise here.
  assert.strictEqual(blocked.warnings.length, 1);
  assert.strictEqual(blocked.warnings[0].field, "outlet_ids");

  assert.strictEqual(exportGate(widened, true).allowed, true);
});

test("acknowledgement must be explicit, not merely truthy", () => {
  const widened = [{ widens_result_set: true }];
  for (const notAcknowledged of ["yes", 1, {}, "true", null]) {
    assert.strictEqual(
      exportGate(widened, notAcknowledged).allowed,
      false,
      `${JSON.stringify(notAcknowledged)} must not count as acknowledgement`
    );
  }
});

test("preview is never gated - looking is not taking data out of the building", () => {
  // The gate is only consulted by export; this asserts the classification is
  // available to preview without blocking it.
  const widened = [{ widens_result_set: true }];
  assert.strictEqual(widensResultSet(widened), true);
  assert.strictEqual(widensResultSet([]), false);
});
