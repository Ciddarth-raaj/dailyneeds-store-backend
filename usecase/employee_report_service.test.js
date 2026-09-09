/**
 * Reports — the Employee Master service.
 *
 *   node --test usecase/employee_report_service.test.js
 *
 * The database is a small in-memory fake that answers the two queries the
 * service actually issues (a COUNT and a page of rows) by applying the SAME
 * predicates to a fixed set of employees. That is enough to test the thing
 * that matters most here - that preview and export agree about who is in the
 * report - without a MySQL instance, and it fails loudly if the service ever
 * grows a second WHERE clause, because the fake would then have to interpret
 * two of them.
 */
const test = require("node:test");
const assert = require("node:assert");

const build = require("./employee_report_service");
const { ReportError } = require("./employee_report_service");
const rules = require("./report_template_rules");

/* ------------------------------------------------------------- fixtures */

const EMPLOYEES = [
  { employee_id: 1, employee_name: "Ada", status: 1, store_id: 2, department_id: 5, designation_id: 15 },
  { employee_id: 2, employee_name: "Grace", status: 1, store_id: 3, department_id: 5, designation_id: 15 },
  { employee_id: 3, employee_name: "Katherine", status: 0, store_id: 2, department_id: 6, designation_id: 16 },
  { employee_id: 4, employee_name: "Dorothy", status: 0, store_id: 3, department_id: 6, designation_id: 16 },
  { employee_id: 5, employee_name: "Mary", status: null, store_id: 2, department_id: 5, designation_id: 16 },
];

/**
 * A fake connection that understands the generated SQL well enough to apply
 * it: it reads which predicates are present and binds the parameters in the
 * order the builder emitted them. It does NOT reimplement the filter logic
 * from the spec - it follows the SQL - which is why a mismatch between the
 * count query and the row query shows up as a test failure rather than being
 * papered over.
 */
function fakeDb(rows = EMPLOYEES) {
  const calls = [];

  const query = (sql, params, cb) => {
    calls.push({ sql, params });
    const p = [...params];
    let out = rows;

    // The predicates, read in the order buildQuery emits them.
    if (/store_id IN \(\?\)/.test(sql)) {
      const ids = p.shift();
      out = out.filter((r) => ids.includes(r.store_id));
    }
    if (/designation_id IN \(\?\)/.test(sql)) {
      const ids = p.shift();
      out = out.filter((r) => ids.includes(r.designation_id));
    }
    if (/new_employee\.status = 1/.test(sql)) out = out.filter((r) => r.status === 1);
    else if (/status <> 1 OR new_employee\.status IS NULL/.test(sql))
      out = out.filter((r) => r.status !== 1);

    if (/department_id IN \(\?\)/.test(sql)) {
      const ids = p.shift();
      out = out.filter((r) => ids.includes(r.department_id));
    }
    if (/employee_name LIKE \?/.test(sql)) {
      const like = String(p.shift()).replace(/%/g, "");
      const exact = String(p.shift());
      out = out.filter(
        (r) => r.employee_name.includes(like) || String(r.employee_id) === exact
      );
    }

    out = [...out].sort((a, b) => a.employee_id - b.employee_id);

    if (/COUNT\(\*\)/.test(sql)) {
      cb(null, [{ matching_count: out.length }]);
      return;
    }

    // LIMIT/OFFSET are always the last two bound values when present.
    const offsetMatches = sql.match(/LIMIT \? OFFSET \?/g) || [];
    if (offsetMatches.length) {
      const offset = params[params.length - 1];
      const limit = params[params.length - 2];
      out = out.slice(offset, offset + limit);
    }

    // The projection is `expr AS c0, c1, ...` in field order; the fake only
    // needs to return something distinguishable per column.
    cb(
      null,
      out.map((r) => ({ c0: r.employee_id, c1: r.employee_name, c2: r.store_id }))
    );
  };

  return { query, calls };
}

/** A template repository fake. */
function fakeTemplates(seed = []) {
  const rowsById = new Map(seed.map((t) => [t.template_id, { ...t }]));
  let nextId = 100;
  const exports_ = [];

  return {
    exports_,
    rowsById,
    listVisible: async (dataset, actor) =>
      [...rowsById.values()].filter(
        (t) =>
          t.dataset_key === dataset &&
          (t.is_system === 1 ||
            t.is_shared === 1 ||
            Number(t.owner_user_id) === Number(actor && actor.userId))
      ),
    findById: async (id) => rowsById.get(Number(id)) || null,
    create: async (t) => {
      const id = nextId++;
      rowsById.set(id, { ...t, template_id: id, is_system: 0, is_shared: t.is_shared ? 1 : 0 });
      return id;
    },
    update: async (id, patch) => {
      const row = rowsById.get(Number(id));
      if (!row || row.is_system === 1) return false;
      Object.assign(row, patch);
      return true;
    },
    remove: async (id) => {
      const row = rowsById.get(Number(id));
      if (!row || row.is_system === 1) return false;
      return rowsById.delete(Number(id));
    },
    logExport: async (entry) => {
      exports_.push(entry);
      return exports_.length;
    },
    resolveLookupIds: async (kind, ids) => {
      // Outlet 2 exists and is active; 3 exists but is inactive; 99 is gone.
      const resolvable = new Set(ids.map(Number).filter((id) => id === 2 || id === 3));
      const active = new Set(ids.map(Number).filter((id) => id === 2));
      return { resolvable, active };
    },
  };
}

const FIELDS = ["employee_id", "employee_name", "outlet"];

const hrActor = {
  userId: 21,
  employeeId: 631,
  isAdmin: false,
  permissions: ["view_employees", "view_reports", "export_reports"],
};
// May look at the employee master and use Reports, but may not export and
// holds no sensitive-field permission.
const viewerActor = {
  userId: 22,
  employeeId: 632,
  isAdmin: false,
  permissions: ["view_reports", "view_employees"],
};

// Holds the reporting capability and NOTHING about employees. Reports must not
// be the doorway that lets them in.
const reportsOnlyActor = {
  userId: 23,
  employeeId: 633,
  isAdmin: false,
  permissions: ["view_reports", "export_reports"],
};

const svc = (db, templates) => build(db, templates);

/* ================================================== THE CORE INVARIANT === */

test("PREVIEW COUNT AND EXPORT ROW COUNT AGREE, FOR EVERY STATUS", async () => {
  // The whole reason there is one query builder. If preview says 216 and the
  // spreadsheet has 214, nobody finds out until somebody reconciles a payroll
  // against it.
  for (const status of ["active", "inactive", "all"]) {
    const db = fakeDb();
    const service = svc(db, fakeTemplates());
    const body = { field_keys: FIELDS, filters: { status } };

    const preview = await service.preview(body, hrActor);
    const prepared = await service.prepareExport(body, hrActor, "csv");

    let streamed = 0;
    await service.streamRows(prepared, (rows) => {
      streamed += rows.length;
    });

    assert.strictEqual(
      preview.matching_count,
      prepared.row_count,
      `${status}: preview said ${preview.matching_count}, export prepared ${prepared.row_count}`
    );
    assert.strictEqual(
      streamed,
      preview.matching_count,
      `${status}: ${streamed} rows streamed for a preview count of ${preview.matching_count}`
    );
  }
});

test("the three statuses actually mean different things", async () => {
  // The parity test above would pass trivially if every status returned the
  // same set, so pin the populations too. Two employees are employed, two have
  // left, and one has a NULL status - which is not employed.
  const service = svc(fakeDb(), fakeTemplates());
  const count = async (status) =>
    (await service.preview({ field_keys: FIELDS, filters: { status } }, hrActor)).matching_count;

  assert.strictEqual(await count("active"), 2);
  assert.strictEqual(await count("inactive"), 3);
  assert.strictEqual(await count("all"), 5);
  assert.strictEqual((await count("active")) + (await count("inactive")), await count("all"));
});

test("A RESIGNED REPORT RETURNS RESIGNED PEOPLE, NOT NOBODY", async () => {
  // The defect the visibility separation exists to prevent: if Reports had
  // inherited the directory's resigned-name exclusion, this would be 0.
  const service = svc(fakeDb(), fakeTemplates());
  const preview = await service.preview(
    { field_keys: FIELDS, filters: { status: "inactive" } },
    hrActor
  );
  assert.ok(preview.matching_count > 0, "an inactive report must return the people who left");
});

test("no report query carries the directory's resignation exclusion", async () => {
  const db = fakeDb();
  const service = svc(db, fakeTemplates());
  await service.preview({ field_keys: FIELDS, filters: { status: "all" } }, hrActor);
  for (const call of db.calls) {
    assert.ok(!/employee_name NOT IN/.test(call.sql), call.sql.slice(0, 120));
    assert.ok(!/\bresignation\b/.test(call.sql));
  }
});

/* ============================================== the export refuses loudly */

test("an export over the row cap is REFUSED, never truncated", async () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    employee_id: i + 1,
    employee_name: `E${i}`,
    status: 1,
    store_id: 2,
    department_id: 5,
    designation_id: 15,
  }));
  const service = svc(fakeDb(many), fakeTemplates());
  // Squeeze the cap rather than generate 5,001 rows.
  const config = require("../config/reports");
  const original = config.MAX_ROWS;
  config.MAX_ROWS = 5;
  try {
    await assert.rejects(
      () => service.prepareExport({ field_keys: FIELDS, filters: { status: "active" } }, hrActor, "csv"),
      (err) => {
        assert.strictEqual(err.code, "TOO_MANY_ROWS");
        assert.strictEqual(err.httpCode, 422);
        assert.strictEqual(err.detail.row_count, 20);
        return true;
      }
    );
  } finally {
    config.MAX_ROWS = original;
  }
});

test("export requires export_reports, and preview does not", async () => {
  const service = svc(fakeDb(), fakeTemplates());
  const body = { field_keys: FIELDS, filters: { status: "active" } };

  // Someone who may look.
  const preview = await service.preview(body, viewerActor);
  assert.ok(preview.matching_count >= 0);

  // The same someone may not take it out of the building.
  await assert.rejects(
    () => service.prepareExport(body, viewerActor, "xlsx"),
    (err) => err.code === "EXPORT_FORBIDDEN" && err.httpCode === 403
  );
});

/* ====================================== reconciliation and the export gate */

const staleTemplate = {
  template_id: 1,
  template_name: "One Branch",
  dataset_key: "EMPLOYEE_MASTER",
  field_keys: FIELDS,
  // Outlet 99 no longer exists, and it is the ONLY value - so dropping it
  // would remove the filter and widen the report to every outlet.
  filters: { status: "active", outlet_ids: [99] },
  owner_user_id: 21,
  is_shared: 0,
  is_system: 0,
};

test("A TEMPLATE WHOSE ONLY OUTLET IS GONE WIDENS, AND SAYS SO", async () => {
  const service = svc(fakeDb(), fakeTemplates([staleTemplate]));
  const preview = await service.preview({ template_id: 1 }, hrActor);

  assert.strictEqual(preview.requires_acknowledgement, true);
  assert.ok(rules.widensResultSet(preview.warnings));
  // Preview still shows it: looking is not taking.
  assert.ok(preview.matching_count > 0);
});

test("that export is blocked until it is acknowledged, then allowed", async () => {
  const service = svc(fakeDb(), fakeTemplates([staleTemplate]));

  await assert.rejects(
    () => service.prepareExport({ template_id: 1 }, hrActor, "csv"),
    (err) => {
      assert.strictEqual(err.code, "FILTER_WIDENED");
      assert.strictEqual(err.httpCode, 409);
      return true;
    }
  );

  const prepared = await service.prepareExport(
    { template_id: 1, acknowledge_widened_filters: true },
    hrActor,
    "csv"
  );
  assert.ok(prepared.row_count > 0);
});

test("an inactive but existing outlet is KEPT, and does not widen", async () => {
  const template = {
    ...staleTemplate,
    template_id: 2,
    filters: { status: "active", outlet_ids: [2, 3] },
  };
  const service = svc(fakeDb(), fakeTemplates([template]));
  const preview = await service.preview({ template_id: 2 }, hrActor);

  // Outlet 3 exists but is inactive: flagged, still applied.
  assert.strictEqual(preview.requires_acknowledgement, false);
  assert.deepStrictEqual(preview.filters.outlet_ids, [2, 3]);
  assert.ok(preview.warnings.some((w) => w.type === "filter_value_inactive"));
});

test("a template naming a field the caller may not use reconciles rather than fails", async () => {
  const template = {
    ...staleTemplate,
    template_id: 3,
    filters: { status: "active" },
    field_keys: ["employee_id", "employee_name", "pan_no"],
    // Shared, so the colleague who lacks `view_employee_sensitive` can run
    // it - which is exactly the case reconciliation exists for.
    is_shared: 1,
  };
  const service = svc(fakeDb(), fakeTemplates([template]));
  const preview = await service.preview({ template_id: 3 }, viewerActor);

  assert.deepStrictEqual(
    preview.columns.map((c) => c.key),
    ["employee_id", "employee_name"]
  );
  assert.ok(preview.warnings.some((w) => w.type === "field_unavailable" && w.field === "pan_no"));
  // Dropping a column cannot add a row.
  assert.strictEqual(preview.requires_acknowledgement, false);
});

/* ================================================== template ownership === */

const systemTemplate = {
  template_id: 10,
  template_name: "Active Employee List",
  dataset_key: "EMPLOYEE_MASTER",
  field_keys: FIELDS,
  filters: { status: "active" },
  owner_user_id: null,
  is_shared: 1,
  is_system: 1,
};

test("A SYSTEM TEMPLATE CANNOT BE EDITED OR DELETED, EVEN BY AN ADMIN", async () => {
  const templates = fakeTemplates([systemTemplate]);
  const service = svc(fakeDb(), templates);
  const admin = { userId: 1, employeeId: 1, isAdmin: true, permissions: [] };

  for (const actor of [hrActor, admin]) {
    await assert.rejects(
      () => service.updateTemplate(10, { template_name: "Mine", field_keys: FIELDS }, actor),
      (err) => err.code === "TEMPLATE_FORBIDDEN" && err.httpCode === 403
    );
    await assert.rejects(
      () => service.deleteTemplate(10, actor),
      (err) => err.code === "TEMPLATE_FORBIDDEN"
    );
  }
  assert.ok(templates.rowsById.has(10), "the seeded template survives");
});

test("but anybody may run it, and Save a Copy gives them their own", async () => {
  const templates = fakeTemplates([systemTemplate]);
  const service = svc(fakeDb(), templates);

  const preview = await service.preview({ template_id: 10 }, viewerActor);
  assert.ok(preview.matching_count >= 0);

  const copy = await service.copyTemplate(10, "My version", viewerActor);
  assert.strictEqual(copy.is_system, 0);
  assert.strictEqual(copy.is_shared, 0);
  assert.strictEqual(Number(copy.owner_user_id), viewerActor.userId);
  assert.notStrictEqual(copy.template_id, 10);
});

test("SOMEBODY ELSE'S PERSONAL TEMPLATE IS NOT FOUND, NOT FORBIDDEN", async () => {
  // A 403 would confirm the id is real and belongs to a colleague, which is
  // itself a disclosure. Both answers are 404.
  const mine = { ...staleTemplate, template_id: 4, owner_user_id: 999, filters: { status: "active" } };
  const service = svc(fakeDb(), fakeTemplates([mine]));

  for (const call of [
    () => service.preview({ template_id: 4 }, hrActor),
    () => service.updateTemplate(4, { template_name: "x", field_keys: FIELDS }, hrActor),
    () => service.deleteTemplate(4, hrActor),
    () => service.copyTemplate(4, "x", hrActor),
  ]) {
    await assert.rejects(call, (err) => {
      assert.strictEqual(err.httpCode, 404);
      assert.strictEqual(err.code, "TEMPLATE_NOT_FOUND");
      return true;
    });
  }
});

test("listing shows only what the caller may see", async () => {
  const templates = fakeTemplates([
    systemTemplate,
    { ...staleTemplate, template_id: 5, owner_user_id: 21, is_shared: 0 },
    { ...staleTemplate, template_id: 6, owner_user_id: 999, is_shared: 0 },
    { ...staleTemplate, template_id: 7, owner_user_id: 999, is_shared: 1 },
  ]);
  const service = svc(fakeDb(), templates);

  const ids = (await service.listTemplates(hrActor)).map((t) => t.template_id);
  assert.ok(ids.includes(10), "system");
  assert.ok(ids.includes(5), "own personal");
  assert.ok(ids.includes(7), "somebody's shared");
  assert.ok(!ids.includes(6), "somebody else's personal must not appear");
});

test("sharing a template needs its own permission", async () => {
  const service = svc(fakeDb(), fakeTemplates());
  await assert.rejects(
    () => service.createTemplate({ template_name: "Shared", field_keys: FIELDS, is_shared: true }, hrActor),
    (err) => err.code === "SHARING_FORBIDDEN" && err.httpCode === 403
  );

  const sharer = { ...hrActor, permissions: [...hrActor.permissions, "manage_shared_report_templates"] };
  const made = await service.createTemplate(
    { template_name: "Shared", field_keys: FIELDS, is_shared: true },
    sharer
  );
  assert.strictEqual(made.is_shared, 1);
});

test("saving a template names a field the caller cannot use is refused now, not later", async () => {
  const service = svc(fakeDb(), fakeTemplates());
  await assert.rejects(
    () =>
      service.createTemplate(
        { template_name: "PAN", field_keys: ["employee_id", "pan_no"] },
        viewerActor
      ),
    (err) => err.code === "UNKNOWN_FIELD" && err.httpCode === 422
  );
});

/* ================================================== the audit trail ===== */

test("THE EXPORT AUDIT RECORDS THE SHAPE AND NEVER A VALUE", async () => {
  const templates = fakeTemplates();
  const service = svc(fakeDb(), templates);

  const prepared = await service.prepareExport(
    {
      field_keys: ["employee_id", "employee_name", "outlet"],
      filters: { status: "active", outlet_ids: [2], search: "Ada" },
    },
    hrActor,
    "xlsx"
  );
  await service.recordExport(prepared, hrActor);

  assert.strictEqual(templates.exports_.length, 1);
  const entry = templates.exports_[0];

  assert.strictEqual(entry.user_id, 21);
  assert.strictEqual(entry.employee_id, 631);
  assert.deepStrictEqual(entry.field_keys, ["employee_id", "employee_name", "outlet"]);
  assert.strictEqual(entry.format, "xlsx");
  assert.strictEqual(entry.row_count, prepared.row_count);

  // The shape of the filter, not what was typed into it. A search string is
  // usually somebody's name, and this table must not hold one.
  assert.strictEqual(entry.filters.search_used, true);
  const serialized = JSON.stringify(entry);
  assert.ok(!/Ada/.test(serialized), "no searched-for value in the audit row");
  assert.ok(!/Grace|Katherine|Dorothy/.test(serialized), "no exported value in the audit row");
});

test("the audit flags an export that included a sensitive column", async () => {
  const sensitiveActor = {
    ...hrActor,
    permissions: [...hrActor.permissions, "view_employee_sensitive"],
  };
  const templates = fakeTemplates();
  const service = svc(fakeDb(), templates);

  const plain = await service.prepareExport(
    { field_keys: ["employee_id", "employee_name"], filters: { status: "active" } },
    sensitiveActor,
    "csv"
  );
  assert.strictEqual(plain.sensitive_fields_included, false);

  const withPan = await service.prepareExport(
    { field_keys: ["employee_id", "pan_no"], filters: { status: "active" } },
    sensitiveActor,
    "csv"
  );
  assert.strictEqual(withPan.sensitive_fields_included, true);
});

/* ================================================== request validation === */

test("no caller string reaches the SQL", async () => {
  const db = fakeDb();
  const service = svc(db, fakeTemplates());

  await service.preview(
    { field_keys: FIELDS, filters: { status: "all", search: "'; DROP TABLE new_employee; --" } },
    hrActor
  );

  for (const call of db.calls) {
    assert.ok(!/DROP/i.test(call.sql), call.sql.slice(0, 200));
    // The search travels as two bound values, never as text in the statement.
    assert.ok(call.sql.includes("?"));
  }
});

test("an unknown field key is refused rather than interpolated", async () => {
  const service = svc(fakeDb(), fakeTemplates());
  for (const key of ["new_employee.salary", "aadhaar_number", "1=1", "(SELECT 1)"]) {
    await assert.rejects(
      () => service.preview({ field_keys: ["employee_id", key] }, hrActor),
      (err) => err.code === "UNKNOWN_FIELD"
    );
  }
});

test("the export filename cannot carry a header injection", async () => {
  const template = {
    ...systemTemplate,
    template_id: 11,
    template_name: 'evil"\r\nX-Injected: 1',
    is_system: 0,
    is_shared: 0,
    owner_user_id: 21,
  };
  const service = svc(fakeDb(), fakeTemplates([template]));
  const prepared = await service.prepareExport({ template_id: 11 }, hrActor, "csv");

  assert.ok(!/["\r\n]/.test(prepared.filename), prepared.filename);
  assert.match(prepared.filename, /\.csv$/);
});

test("a ReportError carries an HTTP status the route can use", () => {
  const err = new ReportError(409, "X", "message");
  assert.strictEqual(err.name, "ReportError");
  assert.strictEqual(err.httpCode, 409);
});

/* ============================ the dataset's own permission comes first === */

test("view_reports ALONE REACHES NOTHING IN THE EMPLOYEE MASTER", () => {
  // The prerequisite, checked as a predicate. `view_reports` is a reporting
  // capability; the Employee Master dataset is HR's, and reaching it needs the
  // same key that guards the HR directory.
  const service = svc(fakeDb(), fakeTemplates());
  assert.strictEqual(service.canReachDataset(reportsOnlyActor), false);
  assert.strictEqual(service.canReachDataset(viewerActor), true);
  // And the verb does not satisfy the prerequisite.
  assert.strictEqual(service.canExport(reportsOnlyActor), false);
});

test("EVERY VERB REFUSES A CALLER WITHOUT view_employees", async () => {
  const templates = fakeTemplates([systemTemplate]);
  const service = svc(fakeDb(), templates);
  const body = { field_keys: FIELDS, filters: { status: "active" } };

  const calls = [
    ["describe", () => service.describe(reportsOnlyActor)],
    ["listTemplates", () => service.listTemplates(reportsOnlyActor)],
    ["preview", () => service.preview(body, reportsOnlyActor)],
    ["createTemplate", () => service.createTemplate({ template_name: "T", ...body }, reportsOnlyActor)],
    ["updateTemplate", () => service.updateTemplate(10, { template_name: "T", ...body }, reportsOnlyActor)],
    ["deleteTemplate", () => service.deleteTemplate(10, reportsOnlyActor)],
    ["copyTemplate", () => service.copyTemplate(10, "T", reportsOnlyActor)],
    ["prepareExport", () => service.prepareExport(body, reportsOnlyActor, "csv")],
  ];

  for (const [name, call] of calls) {
    await assert.rejects(
      async () => call(),
      (err) => {
        assert.strictEqual(err.code, "DATASET_FORBIDDEN", name);
        assert.strictEqual(err.httpCode, 403, name);
        return true;
      },
      name
    );
  }
});

test("the refusal happens BEFORE any query is issued", async () => {
  // Not "runs and returns nothing" - never runs. A query that executes and is
  // then discarded has already read the rows.
  const db = fakeDb();
  const service = svc(db, fakeTemplates());
  await assert.rejects(
    () => service.preview({ field_keys: FIELDS, filters: { status: "all" } }, reportsOnlyActor),
    (err) => err.code === "DATASET_FORBIDDEN"
  );
  assert.strictEqual(db.calls.length, 0, "no SQL may be sent for a refused caller");
});

test("missing the DATASET is reported differently from missing the EXPORT verb", async () => {
  // Two different things to ask an administrator for, so they are two
  // different answers.
  const service = svc(fakeDb(), fakeTemplates());
  const body = { field_keys: FIELDS, filters: { status: "active" } };

  await assert.rejects(
    () => service.prepareExport(body, reportsOnlyActor, "csv"),
    (err) => err.code === "DATASET_FORBIDDEN"
  );
  await assert.rejects(
    () => service.prepareExport(body, viewerActor, "csv"),
    (err) => err.code === "EXPORT_FORBIDDEN"
  );
});

test("THE ADMIN BYPASS IS UNCHANGED", () => {
  const service = svc(fakeDb(), fakeTemplates());
  const admin = { userId: 1, employeeId: 1, isAdmin: true, permissions: [] };
  assert.strictEqual(service.canReachDataset(admin), true);
  assert.strictEqual(service.canExport(admin), true);
});
