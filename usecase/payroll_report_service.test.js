/**
 * Payroll Reports - the service, driven with in-memory repositories.
 *
 *   node --test usecase/payroll_report_service.test.js
 *
 * The fake `query` executes the SQL the real query builder produces in the
 * only way that matters here: it reads the SELECT list (expression AS alias)
 * and answers each expression from a fixture of STORED values keyed by that
 * expression, filtered by the month and the branch scope in the params. So
 * what these tests prove about column order, months and scope is proved
 * against the actual generated SQL.
 */
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const ExcelJS = require("exceljs");

const buildService = require("./payroll_report_service");
const buildRoutes = require("../routes/payroll_report");

const READ = ["view_reports", "view_employees", "view_payroll", "view_salary"];
const reader = (extra = [], userId = 7) => ({ userId, employeeId: 70, isAdmin: false, permissions: [...READ, ...extra] });
const EXPORTER = reader(["export_reports"]);
const STATUTORY = reader(["export_reports", "view_employee_sensitive"]);

/* --------------------------------------------------------------- fakes */

function stored(id, period, over = {}) {
  return {
    _period: period,
    "pe.store_id": over.store_id || 1,
    "pe.employee_id": id,
    "c.status": over.status || "APPROVED_LOCKED",
    "c.published_at": null,
    "pe.employee_name": `Employee ${id}`,
    "pe.store_name": over.store_id === 2 ? "Outlet B" : "Outlet A",
    "c.salary_days": 26,
    "c.total_earnings": "20000.00",
    "c.total_employee_deductions": "1800.00",
    "c.net_pay": "18200.00",
    "c.pf_status": "APPLIED",
    "c.pay_type": "BANK",
    "new_employee.account_no": "000111222333",
    "new_employee.primary_contact_number": "9876543210",
    ...over.values,
  };
}

function splitSelect(sql) {
  const head = sql.slice(sql.indexOf("SELECT ") + 7, sql.indexOf("\nFROM"));
  return head.split(",\n       ").map((part) => {
    const at = part.lastIndexOf(" AS ");
    return { expr: part.slice(0, at), alias: part.slice(at + 4) };
  });
}

const catalogue = require("../constants/payroll_report_catalogue");

/** Evaluate one select expression of the generated SQL against a stored row. */
function evaluate(expr, row) {
  const finalOnly = /^IF\(c\.status = 'APPROVED_LOCKED', ([\s\S]*), NULL\)$/.exec(expr);
  if (finalOnly) return row["c.status"] === "APPROVED_LOCKED" ? evaluate(finalOnly[1], row) : null;
  if (expr === catalogue.PAYRUN_STATUS) {
    if (!row["c.status"]) return "NOT_CALCULATED";
    if (row["c.status"] !== "APPROVED_LOCKED") return row["c.unlocked_at"] ? "UNLOCKED" : "PENDING_APPROVAL";
    return row["c.published_at"] ? "PUBLISHED" : "APPROVED_LOCKED";
  }
  return expr in row ? row[expr] : null;
}

function fakeReportRepo() {
  const state = { data: [], layouts: new Map(), defaults: new Map(), statutory: [], queries: [], months: [] };
  const lkey = (u, t, y, m) => `${u}|${t}|${y}|${m}`;
  const match = (sql, params) => {
    const nums = params.filter((p) => typeof p === "number");
    const [year, month] = nums;
    let rows = state.data.filter((r) => r._period.year === year && r._period.month === month);
    if (/1 = 0/.test(sql)) return [];
    if (/pe\.store_id IN \(\?\)/.test(sql)) {
      const scope = params.find((p) => Array.isArray(p));
      rows = rows.filter((r) => scope.includes(r["pe.store_id"]));
    }
    return rows;
  };
  return {
    state,
    query: async (sql, params) => {
      state.queries.push({ sql, params });
      const rows = match(sql, params);
      if (/COUNT\(\*\) AS matching_count/.test(sql)) {
        return [{ matching_count: rows.length, finalized_count: rows.filter((r) => r["c.status"] === "APPROVED_LOCKED").length }];
      }
      if (/^SELECT SUM/.test(sql)) {
        const out = {};
        for (const m of sql.matchAll(/SUM\((IF\(c\.status = 'APPROVED_LOCKED', .+?, NULL\))\) AS (t\d+)/g)) {
          out[m[2]] = rows.reduce((s, r) => s + Number(evaluate(m[1], r) || 0), 0);
        }
        return [out];
      }
      const select = splitSelect(sql);
      return rows.map((r) => {
        const out = {};
        for (const { expr, alias } of select) out[alias] = evaluate(expr, r);
        return out;
      });
    },
    listMonths: async () => state.months,
    // The payrun's own totals, computed here independently of the report SQL.
    payrunTotals: async ({ year, month, store_ids }) => {
      const rows = state.data.filter((r) => r._period.year === year && r._period.month === month && (store_ids === null || store_ids.includes(r["pe.store_id"])));
      const fin = rows.filter((r) => r["c.status"] === "APPROVED_LOCKED");
      const sum = (k) => Math.round(fin.reduce((a, r) => a + Number(r[k] || 0), 0) * 100) / 100;
      return { employees: rows.length, finalized: fin.length, gross: sum("c.total_earnings"), deductions: sum("c.total_employee_deductions"), net_pay: sum("c.net_pay") };
    },
    listStatutoryRows: async () => state.statutory,
    getLayout: async ({ user_id, report_type, year, month }) => state.layouts.get(lkey(user_id, report_type, year, month)) || null,
    findLatestLayoutBefore: async ({ user_id, report_type, year, month }) => {
      const before = [...state.layouts.values()]
        .filter((l) => l.user_id === user_id && l.report_type === report_type && (l.year < year || (l.year === year && l.month < month)))
        .sort((a, b) => b.year - a.year || b.month - a.month);
      return before[0] || null;
    },
    saveLayout: async (l) => state.layouts.set(lkey(l.user_id, l.report_type, l.year, l.month), { ...l, display: l.display }),
    deleteLayout: async ({ user_id, report_type, year, month }) => state.layouts.delete(lkey(user_id, report_type, year, month)),
    getDefaultTemplateId: async ({ user_id, report_type }) => state.defaults.get(`${user_id}|${report_type}`) || null,
    listDefaultTemplateIds: async (user_id) => {
      const out = {};
      for (const [k, v] of state.defaults) if (k.startsWith(`${user_id}|`)) out[k.split("|")[1]] = v;
      return out;
    },
    setDefaultTemplate: async ({ user_id, report_type, template_id }) => state.defaults.set(`${user_id}|${report_type}`, template_id),
    clearDefaultTemplate: async ({ user_id, report_type }) => state.defaults.delete(`${user_id}|${report_type}`),
    clearDefaultsForTemplate: async (id) => {
      for (const [k, v] of state.defaults) if (v === id) state.defaults.delete(k);
    },
  };
}

function fakeTemplateRepo() {
  const rows = new Map();
  const exports = [];
  let next = 1;
  return {
    rows,
    exports,
    seedSystem(t) {
      const id = next++;
      rows.set(id, { template_id: id, owner_user_id: null, is_shared: 1, is_system: 1, ...t });
      return id;
    },
    listVisible: async (dataset, actor) =>
      [...rows.values()].filter((t) => t.dataset_key === dataset && (t.is_system || t.is_shared || t.owner_user_id === actor.userId)),
    findById: async (id) => (rows.has(Number(id)) ? { ...rows.get(Number(id)) } : null),
    create: async (t) => {
      const id = next++;
      rows.set(id, { ...t, template_id: id, is_system: 0, filters: t.filters || {} });
      return id;
    },
    update: async (id, patch) => {
      const t = rows.get(Number(id));
      if (!t || t.is_system) return false;
      rows.set(Number(id), { ...t, ...patch });
      return true;
    },
    remove: async (id) => rows.delete(Number(id)),
    logExport: async (e) => exports.push(e),
  };
}

const SEPT = { year: 2026, month: 9 };
const OCT = { year: 2026, month: 10 };

let repo;
let templates;
let service;
let pdfHtml;

beforeEach(() => {
  repo = fakeReportRepo();
  templates = fakeTemplateRepo();
  pdfHtml = null;
  service = buildService(repo, templates, {
    withBrowser: (fn) => fn({ renderPdf: async (html) => { pdfHtml = html; return Buffer.from("%PDF-fake"); } }),
  });
  repo.state.data.push(
    stored(1, SEPT),
    stored(2, SEPT, { store_id: 2, values: { "c.net_pay": "9000.00" } }),
    stored(1, OCT, { values: { "c.net_pay": "18500.00" } })
  );
});

/* ---------------------------------------------------------------- tests */

describe("month-wise layouts", () => {
  it("September and October remember different columns for the same user and report type", async () => {
    await service.saveLayout(EXPORTER, { report_type: "PAYROLL_REGISTER", ...SEPT, field_keys: ["employee_id", "employee_name", "outlet", "date_of_joining", "gross_salary", "employee_pf", "employee_esi", "net_pay"] });
    await service.saveLayout(EXPORTER, { report_type: "PAYROLL_REGISTER", ...OCT, field_keys: ["employee_id", "net_pay"] });
    const sept = await service.getLayout(EXPORTER, { report_type: "PAYROLL_REGISTER", ...SEPT });
    const oct = await service.getLayout(EXPORTER, { report_type: "PAYROLL_REGISTER", ...OCT });
    assert.equal(sept.source, "MONTH");
    assert.equal(sept.field_keys.length, 8);
    assert.deepEqual(oct.field_keys, ["employee_id", "net_pay"]);
    // Another report type and another user are untouched.
    assert.equal((await service.getLayout(EXPORTER, { report_type: "BANK", ...SEPT })).source, "REPORT_DEFAULT");
    assert.equal((await service.getLayout(reader([], 99), { report_type: "PAYROLL_REGISTER", ...SEPT })).source, "REPORT_DEFAULT");
  });

  it("a month without a layout opens with the user's default template, else the report default", async () => {
    const fresh = await service.getLayout(EXPORTER, { report_type: "PAYROLL_REGISTER", ...SEPT });
    assert.deepEqual(fresh.field_keys, ["employee_id", "employee_name", "outlet_department", "paid_days", "gross_salary", "total_deductions", "net_pay"]);
    const t = await service.createTemplate(EXPORTER, { report_type: "PAYROLL_REGISTER", template_name: "Mine", field_keys: ["net_pay", "employee_id"] });
    await service.setDefaultTemplate(EXPORTER, { report_type: "PAYROLL_REGISTER", template_id: t.template_id });
    const viaDefault = await service.getLayout(EXPORTER, { report_type: "PAYROLL_REGISTER", ...OCT });
    assert.equal(viaDefault.source, "DEFAULT_TEMPLATE");
    assert.deepEqual(viaDefault.field_keys, ["net_pay", "employee_id"]);
  });

  it("Copy Columns from Previous Month copies the latest earlier layout into this month", async () => {
    await service.saveLayout(EXPORTER, { report_type: "BANK", ...SEPT, field_keys: ["employee_id", "employee_name", "net_pay"], display: { sort_by: "employee_name" } });
    const copied = await service.copyPreviousMonth(EXPORTER, { report_type: "BANK", ...OCT });
    assert.deepEqual(copied.copied_from, { year: 2026, month: 9, label: "September 2026" });
    assert.equal(copied.source, "MONTH");
    assert.deepEqual(copied.field_keys, ["employee_id", "employee_name", "net_pay"]);
    assert.equal(copied.display.sort_by, "employee_name");
    // Separate from templates: nothing was created there.
    assert.equal(templates.rows.size, 0);
    await assert.rejects(service.copyPreviousMonth(EXPORTER, { report_type: "OT", ...OCT }), (e) => e.code === "NO_PREVIOUS_LAYOUT");
  });

  it("a saved layout naming a field the user can no longer see is reconciled, with a warning", async () => {
    repo.state.layouts.set("7|BANK|2026|9", { user_id: 7, report_type: "BANK", year: 2026, month: 9, field_keys: ["employee_id", "bank_account_number"], display: {}, filters: {} });
    const layout = await service.getLayout(EXPORTER, { report_type: "BANK", ...SEPT });
    assert.deepEqual(layout.field_keys, ["employee_id"]);
    assert.equal(layout.warnings.length, 1);
  });
});

describe("templates", () => {
  it("store structure only, and applying a September template to October pulls October's data", async () => {
    const t = await service.createTemplate(EXPORTER, {
      report_type: "PAYROLL_REGISTER",
      template_name: "Net pay list",
      field_keys: ["employee_id", "net_pay"],
      display: { show_totals: false },
      filters: { pay_type: "BANK", search: "one-off" },
    });
    const storedTemplate = templates.rows.get(t.template_id);
    assert.deepEqual(storedTemplate.field_keys, ["employee_id", "net_pay"]);
    assert.equal(storedTemplate.filters.search, undefined, "a one-off search is not part of a template");
    assert.equal(JSON.stringify(storedTemplate).includes("18200"), false, "no payroll value in a template");

    // Apply in October: the layout takes the template's structure...
    await service.saveLayout(EXPORTER, { report_type: "PAYROLL_REGISTER", ...OCT, field_keys: t.field_keys, display: t.display, filters: t.filters, template_id: t.template_id });
    const layout = await service.getLayout(EXPORTER, { report_type: "PAYROLL_REGISTER", ...OCT });
    assert.equal(layout.template_id, t.template_id);
    // ...and the data is October's.
    const preview = await service.preview(EXPORTER, { report_type: "PAYROLL_REGISTER", ...OCT, field_keys: layout.field_keys, display: layout.display }, null);
    assert.equal(preview.period.label, "October 2026");
    assert.deepEqual(preview.rows, [{ employee_id: 1, net_pay: 18500 }]);
  });

  it("rename, update, duplicate, delete and default behave per ownership; built-ins are read-only", async () => {
    const sys = templates.seedSystem({ template_name: "Bank Report", dataset_key: "PAYROLL_BANK", field_keys: ["employee_id", "net_pay"], filters: {} });
    await assert.rejects(service.renameTemplate(EXPORTER, sys, "x"), (e) => e.code === "TEMPLATE_FORBIDDEN");
    const dup = await service.duplicateTemplate(EXPORTER, sys, "My Bank");
    assert.equal(dup.is_system, 0);
    const renamed = await service.renameTemplate(EXPORTER, dup.template_id, "Bank v2");
    assert.equal(renamed.template_name, "Bank v2");
    const updated = await service.updateTemplate(EXPORTER, dup.template_id, { field_keys: ["net_pay", "employee_name"] });
    assert.deepEqual(updated.field_keys, ["net_pay", "employee_name"]);
    await service.setDefaultTemplate(EXPORTER, { report_type: "BANK", template_id: dup.template_id });
    assert.equal((await service.listTemplates(EXPORTER, "BANK")).find((t) => t.template_id === dup.template_id).is_default, true);
    await assert.rejects(service.setDefaultTemplate(EXPORTER, { report_type: "EPF", template_id: dup.template_id }), (e) => e.code === "TEMPLATE_TYPE_MISMATCH");
    // Somebody else may not touch it.
    await assert.rejects(service.deleteTemplate(reader([], 99), dup.template_id), (e) => e.code === "TEMPLATE_NOT_FOUND");
    await service.deleteTemplate(EXPORTER, dup.template_id);
    assert.equal(repo.state.defaults.size, 0, "a deleted template stops being anybody's default");
  });

  it("a shared template with a sensitive column shows it only to readers who may see it", async () => {
    templates.seedSystem({ template_name: "PF Working", dataset_key: "PAYROLL_EPF", field_keys: ["employee_id", "uan", "epf_wages"], filters: {} });
    const plain = await service.listTemplates(EXPORTER, "EPF");
    assert.deepEqual(plain[0].field_keys, ["employee_id", "epf_wages"]);
    assert.equal(plain[0].warnings.length, 1);
    const sensitive = await service.listTemplates(STATUTORY, "EPF");
    assert.deepEqual(sensitive[0].field_keys, ["employee_id", "uan", "epf_wages"]);
  });
});

describe("preview and export", () => {
  const body = { report_type: "PAYROLL_REGISTER", ...SEPT, field_keys: ["net_pay", "employee_name", "employee_id"] };

  it("finalized values are read as stored - never recalculated - and only SELECTs run", async () => {
    const preview = await service.preview(EXPORTER, body, null);
    assert.deepEqual(preview.rows[0], { net_pay: 18200, employee_name: "Employee 1", employee_id: 1 });
    assert.equal(preview.totals.net_pay, 27200);
    for (const q of repo.state.queries) {
      assert.match(q.sql.trim(), /^SELECT/);
      assert.match(q.sql, /APPROVED_LOCKED/);
    }
    // The service has no handle on any calculation usecase at all.
    assert.equal(Object.values(service).some((v) => v && typeof v.calculate === "function"), false);
  });

  it("a historical month reads its own finalized payrun", async () => {
    const sept = await service.preview(EXPORTER, { ...body, field_keys: ["employee_id", "net_pay"] }, null);
    const oct = await service.preview(EXPORTER, { ...body, ...OCT, field_keys: ["employee_id", "net_pay"] }, null);
    assert.deepEqual(sept.rows.map((r) => r.net_pay), [18200, 9000]);
    assert.deepEqual(oct.rows.map((r) => r.net_pay), [18500]);
  });

  it("outlet scope is enforced: a scoped user sees only their outlets, an empty scope sees nothing", async () => {
    const scoped = await service.preview(EXPORTER, body, [2]);
    assert.deepEqual(scoped.rows.map((r) => r.employee_id), [2]);
    assert.equal(scoped.matching_count, 1);
    const none = await service.preview(EXPORTER, body, []);
    assert.equal(none.rows.length, 0);
  });

  it("Employee Master fields can be added to a payroll report", async () => {
    const preview = await service.preview(EXPORTER, { ...body, field_keys: ["employee_id", "em_mobile"] }, null);
    assert.equal(preview.rows[0].em_mobile, "9876543210");
    assert.equal(preview.columns[1].source, "CURRENT_MASTER");
  });

  it("an unauthorized sensitive field is refused even when named directly", async () => {
    await assert.rejects(service.preview(EXPORTER, { ...body, field_keys: ["employee_id", "bank_account_number"] }, null), (e) => e.code === "UNKNOWN_FIELD");
    const meta = service.describe(EXPORTER);
    const keys = meta.groups.flatMap((g) => g.fields.map((f) => f.key));
    assert.equal(keys.includes("bank_account_number"), false);
    assert.equal(keys.includes("em_pan_no"), false);
  });

  it("Excel has exactly the selected columns, in the selected order, for every row", async () => {
    const file = await service.exportXlsx(EXPORTER, body, null);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.buffer);
    const ws = wb.worksheets[0];
    assert.deepEqual(ws.getRow(4).values.slice(1), ["Net Pay", "Employee Name", "Employee ID"]);
    assert.deepEqual(ws.getRow(5).values.slice(1), [18200, "Employee 1", 1]);
    assert.deepEqual(ws.getRow(6).values.slice(1), [9000, "Employee 2", 2]);
    assert.equal(ws.getRow(7).getCell(1).value, "Total");
    assert.equal(ws.getRow(1).getCell(1).value, "Payroll Register - September 2026");
    assert.equal(file.filename, "Payroll-Register_Sep-2026.xlsx");
    assert.deepEqual(templates.exports[0].field_keys, ["net_pay", "employee_name", "employee_id"]);
    assert.equal(templates.exports[0].format, "xlsx");
  });

  it("PDF has exactly the selected columns, in the selected order", async () => {
    await service.exportPdf(EXPORTER, body, null);
    const headers = [...pdfHtml.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
    assert.deepEqual(headers, ["Net Pay", "Employee Name", "Employee ID"]);
    assert.match(pdfHtml, /September 2026/);
    assert.equal(templates.exports[0].format, "pdf");
  });

  it("export needs export_reports", async () => {
    await assert.rejects(service.exportXlsx(reader(), body, null), (e) => e.code === "EXPORT_FORBIDDEN");
  });
});

/* ------------------------------------------------------ statutory files */

const NAMES = ["", "Asha", "Babu", "Chitra", "Devi"];
const pfRow = (id, over = {}) => ({
  employee: { employee_id: id, employee_name: NAMES[id], uan: "100200300400", pf_applicable: 1, esi_applicable: 1, esi_number: "1234567890", ...over.employee },
  calculation: {
    employee_id: id, status: "APPROVED_LOCKED", is_complete: 1, pf_status: "APPLIED", total_earnings: "16000", pf_wage: "15000",
    eps_wage: "15000", edli_wage: "15000", employee_pf: "1800", employer_eps: "1250", employer_epf: "550", ncp_days: 0,
    esi_status: "APPLIED", salary_days: 26, esi_wage: "15000", employee_esi: "113", employer_esi: "488", ...over.calculation,
  },
});

describe("EPF statutory file (ECR)", () => {
  it("the statutory population is complete: every PF member of the payrun is Ready or Blocked", async () => {
    repo.state.statutory = [
      pfRow(1),
      pfRow(2, { calculation: { status: "CALCULATED" } }),
      { employee: pfRow(3).employee, calculation: null },
      pfRow(4, { calculation: { pf_status: "NOT_APPLICABLE" } }),
    ];
    const v = await service.epfValidation(EXPORTER, SEPT, null);
    assert.deepEqual(v.summary, { considered: 3, ready: 1, blocked: 2 });
    assert.deepEqual(v.blocked.map((b) => [b.employee_id, b.reasons[0].code]), [[2, "NOT_APPROVED"], [3, "NOT_CALCULATED"]]);
  });

  it("ONE blocked employee prevents the ECR - there is no ready-only path", async () => {
    repo.state.statutory = [pfRow(1), pfRow(2), pfRow(3, { employee: { uan: "" } })];
    await assert.rejects(service.ecrFile(STATUTORY, SEPT, null), (e) =>
      e.code === "BLOCKED_EMPLOYEES" && e.httpCode === 409 &&
      e.detail.summary.ready === 2 && e.detail.summary.blocked === 1 &&
      e.detail.blocked[0].employee_id === 3 && e.detail.blocked[0].reasons[0].code === "UAN_MISSING");
    // Asking for a partial file is not an option the service has.
    await assert.rejects(service.ecrFile(STATUTORY, { ...SEPT, acknowledge_blocked: true }, null), (e) => e.code === "BLOCKED_EMPLOYEES");
    assert.equal(templates.exports.length, 0, "nothing was generated or logged");
  });

  it("with nobody blocked, the ECR holds every member, in the EPFO layout", async () => {
    repo.state.statutory = [pfRow(1), pfRow(2)];
    const file = await service.ecrFile(STATUTORY, SEPT, null);
    const lines = file.buffer.toString().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(lines[0], "100200300400#~#ASHA#~#16000#~#15000#~#15000#~#15000#~#1800#~#1250#~#550#~#0#~#0");
    assert.equal(file.filename, "ECR_Sep-2026.txt");
    assert.equal(templates.exports[0].format, "ecr");
  });

  it("the ECR structure is fixed whatever columns the EPF report shows", async () => {
    repo.state.statutory = [pfRow(1)];
    const before = (await service.ecrFile(STATUTORY, SEPT, null)).buffer.toString();
    await service.saveLayout(STATUTORY, { report_type: "EPF", ...SEPT, field_keys: ["employee_id", "employee_name"] });
    await service.saveLayout(STATUTORY, { report_type: "EPF", ...SEPT, field_keys: ["net_pay", "em_mobile", "uan"] });
    const after = (await service.ecrFile(STATUTORY, SEPT, null)).buffer.toString();
    assert.equal(after, before);
    assert.equal(after.split("#~#").length, 11);
  });

  it("the validation status column in the EPF report agrees with the ECR validation", async () => {
    repo.state.data = [stored(1, SEPT), stored(2, SEPT)];
    repo.state.statutory = [pfRow(1), pfRow(2, { employee: { uan: "" } })];
    const preview = await service.preview(EXPORTER, { report_type: "EPF", ...SEPT, field_keys: ["employee_id", "epf_validation"] }, null);
    assert.deepEqual(preview.rows.map((r) => r.epf_validation), ["Ready", "Blocked: UAN is not recorded"]);
    // Normal Excel still downloads with the status column in it.
    const file = await service.exportXlsx(EXPORTER, { report_type: "EPF", ...SEPT, field_keys: ["employee_id", "epf_validation"] }, null);
    assert.ok(file.buffer.length > 0);
  });
});

describe("ESI statutory file (ESIC contribution file)", () => {
  const XLSX = require("xlsx");

  it("the statutory population is complete, and ONE blocked employee prevents the file", async () => {
    repo.state.statutory = [pfRow(1), pfRow(2, { employee: { esi_number: "" } }), pfRow(3, { calculation: { esi_status: "NOT_APPLICABLE" } })];
    const v = await service.esiValidation(EXPORTER, SEPT, null);
    assert.deepEqual(v.summary, { considered: 2, ready: 1, blocked: 1 });
    assert.equal(v.blocked[0].reasons[0].code, "IP_MISSING");
    await assert.rejects(service.esicFile(STATUTORY, SEPT, null), (e) => e.code === "BLOCKED_EMPLOYEES" && e.detail.blocked.length === 1);
    await assert.rejects(service.esicFile(STATUTORY, { ...SEPT, acknowledge_blocked: true }, null), (e) => e.code === "BLOCKED_EMPLOYEES");
    assert.equal(templates.exports.length, 0);
  });

  it("a zero-day employee is blocked until a reason is chosen; then the file is a real .xls for the ESIC portal", async () => {
    repo.state.statutory = [pfRow(1), pfRow(2, { calculation: { salary_days: 0, esi_wage: "0", employee_esi: "0", employer_esi: "0" } })];
    await assert.rejects(service.esicFile(STATUTORY, SEPT, null), (e) => e.detail.blocked[0].reasons[0].code === "ZERO_REASON_MISSING");
    const file = await service.esicFile(STATUTORY, { ...SEPT, overrides: [{ employee_id: 2, reason_code: 1 }] }, null);
    assert.equal(file.filename, "ESIC_Contribution_Sep-2026.xls");
    assert.equal(file.buffer.slice(0, 8).toString("hex"), "d0cf11e0a1b11ae1", "OLE2 / BIFF8 .xls, not a zipped .xlsx");
    const rows = XLSX.utils.sheet_to_json(XLSX.read(file.buffer, { type: "buffer" }).Sheets.Sheet1, { header: 1, raw: true, defval: "" });
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[1], ["1234567890", "ASHA", 26, 15000, 0, ""]);
    assert.deepEqual(rows[2], ["1234567890", "BABU", 0, 0, 1, ""]);
    assert.equal(templates.exports[0].format, "esic");
  });

  it("visible ESI report columns do not affect the contribution file", async () => {
    repo.state.statutory = [pfRow(1)];
    const before = (await service.esicFile(STATUTORY, SEPT, null)).buffer;
    await service.saveLayout(STATUTORY, { report_type: "ESI", ...SEPT, field_keys: ["employee_name"] });
    const after = (await service.esicFile(STATUTORY, SEPT, null)).buffer;
    const read = (b) => XLSX.utils.sheet_to_json(XLSX.read(b, { type: "buffer" }).Sheets.Sheet1, { header: 1, raw: true });
    assert.deepEqual(read(after), read(before));
    assert.equal(read(after)[0].length, 6);
  });

  it("statutory files need view_employee_sensitive as well as export_reports", async () => {
    repo.state.statutory = [pfRow(1)];
    await assert.rejects(service.ecrFile(EXPORTER, SEPT, null), (e) => e.code === "STATUTORY_FORBIDDEN");
    await assert.rejects(service.esicFile(EXPORTER, SEPT, null), (e) => e.code === "STATUTORY_FORBIDDEN");
  });
});

/* ======================================= reconciliation to the finalized payrun */

describe("Payroll Register reconciles to the finalized payrun", () => {
  const REGISTER = { report_type: "PAYROLL_REGISTER", ...SEPT, field_keys: ["employee_id", "gross_salary", "total_deductions", "net_pay"] };

  beforeEach(() => {
    repo.state.data = [
      stored(1, SEPT, { values: { "c.total_earnings": "20000.00", "c.total_employee_deductions": "1800.00", "c.net_pay": "18200.00" } }),
      stored(2, SEPT, { store_id: 2, values: { "c.total_earnings": "10000.50", "c.total_employee_deductions": "750.25", "c.net_pay": "9250.00" } }),
      stored(3, SEPT, { values: { "c.total_earnings": "15000.00", "c.total_employee_deductions": "1200.00", "c.net_pay": "13800.00" } }),
      stored(1, OCT),
    ];
  });

  it("employee count, gross, deductions and net pay equal the payrun's", async () => {
    const p = await service.preview(EXPORTER, REGISTER, null);
    const payrun = await repo.payrunTotals({ ...SEPT, store_ids: null });
    assert.equal(p.matching_count, payrun.employees);
    assert.equal(p.matching_count, 3);
    assert.equal(p.totals.gross_salary, payrun.gross);
    assert.equal(p.totals.total_deductions, payrun.deductions);
    assert.equal(p.totals.net_pay, payrun.net_pay);
    assert.deepEqual([payrun.gross, payrun.deductions, payrun.net_pay], [45000.5, 3750.25, 41250]);
    assert.equal(p.reconciliation.reconciled, true);
    assert.deepEqual(p.reconciliation.report, { employees: 3, finalized: 3, gross: 45000.5, deductions: 3750.25, net_pay: 41250 });
  });

  it("reconciles within the caller's branch scope too", async () => {
    const p = await service.preview(EXPORTER, REGISTER, [1]);
    assert.equal(p.matching_count, 2);
    assert.equal(p.reconciliation.reconciled, true);
    assert.equal(p.reconciliation.payrun.employees, 2);
  });

  it("a later employee-status change does not remove a payrun employee", async () => {
    // The employee resigned and was deactivated after payroll: today's
    // master says inactive. The report reads the payrun, not the master.
    repo.state.data[1]["new_employee.status"] = 0;
    repo.state.data[1]["new_employee.resignation_date"] = "2026-10-10";
    const p = await service.preview(EXPORTER, REGISTER, null);
    assert.deepEqual(p.rows.map((r) => r.employee_id), [1, 2, 3]);
    assert.equal(p.reconciliation.reconciled, true);
  });

  it("an employee whose month is later unlocked stays IN the report, figures blank and status shown; totals stay the finalized totals", async () => {
    repo.state.data[2]["c.status"] = "CALCULATED";
    const p = await service.preview(EXPORTER, { ...REGISTER, field_keys: [...REGISTER.field_keys, "payrun_status"] }, null);
    assert.equal(p.matching_count, 3, "not silently removed");
    assert.equal(p.not_finalized_count, 1);
    const row = p.rows.find((r) => r.employee_id === 3);
    assert.deepEqual(row, { employee_id: 3, gross_salary: null, total_deductions: null, net_pay: null, payrun_status: "Not Finalized - Pending Approval" });
    assert.equal(p.row_status[2].status, "PENDING_APPROVAL");
    const payrun = await repo.payrunTotals({ ...SEPT, store_ids: null });
    assert.equal(p.totals.net_pay, payrun.net_pay);
    assert.equal(p.reconciliation.reconciled, true);
    assert.deepEqual([payrun.employees, payrun.finalized], [3, 2]);
  });

  it("a later attendance recalculation does not change a frozen payroll figure", async () => {
    repo.state.data[0]["amp.attendance_days"] = 26;
    const before = await service.preview(EXPORTER, { ...REGISTER, field_keys: ["employee_id", "net_pay", "paid_days"] }, null);
    // Attendance is recalculated after payroll: the live summary moves.
    repo.state.data[0]["amp.attendance_days"] = 20;
    repo.state.data[0]["c.salary_days_live"] = 20;
    const after = await service.preview(EXPORTER, { ...REGISTER, field_keys: ["employee_id", "net_pay", "paid_days"] }, null);
    assert.deepEqual(after.rows, before.rows);
    assert.equal(after.rows[0].net_pay, 18200);
    assert.equal(after.rows[0].paid_days, 26);
  });

  it("a mismatch is reported, never hidden", async () => {
    const real = repo.payrunTotals;
    repo.payrunTotals = async (args) => ({ ...(await real(args)), net_pay: 1 });
    const p = await service.preview(EXPORTER, REGISTER, null);
    assert.equal(p.reconciliation.reconciled, false);
  });
});

describe("routes", () => {
  function captured() {
    const calls = [];
    const permissions = {
      requireAll: (...keys) => {
        const mw = (req, res, next) => next();
        mw.keys = keys;
        calls.push(keys);
        return mw;
      },
    };
    const routes = buildRoutes({}, permissions, { actorFor: async () => ({}), listFilters: async () => ({ ok: true, store_ids: null }) });
    const byPath = {};
    for (const layer of routes.getRouter().stack) {
      const method = Object.keys(layer.route.methods)[0].toUpperCase();
      byPath[`${method} ${layer.route.path}`] = layer.route.stack[0].handle.keys;
    }
    return byPath;
  }

  it("every route requires the payroll read keys; exports and statutory files add their own", () => {
    const keys = captured();
    for (const [route, ks] of Object.entries(keys)) {
      for (const k of READ) assert.ok(ks.includes(k), `${route} needs ${k}`);
    }
    assert.ok(keys["POST /export/xlsx"].includes("export_reports"));
    assert.ok(keys["POST /export/pdf"].includes("export_reports"));
    for (const r of ["POST /epf/ecr", "POST /esi/contribution-file"]) {
      assert.ok(keys[r].includes("export_reports") && keys[r].includes("view_employee_sensitive"), r);
    }
  });

  it("the statutory download routes accept the month only: no column list, no partial-file flag", async () => {
    const express = require("express");
    const http = require("http");
    const seen = [];
    const svc = {
      ecrFile: async (a, body) => (seen.push(body), { buffer: Buffer.from("x"), filename: "E.txt", summary: { ready: 1, blocked: 0 } }),
      esicFile: async (a, body) => (seen.push(body), { buffer: Buffer.from("x"), filename: "E.xls", summary: { ready: 1, blocked: 0 } }),
    };
    const app = express();
    app.use(express.json());
    app.use("/r", buildRoutes(svc, { requireAll: () => (q, s2, n) => n() }, { actorFor: async () => ({}), listFilters: async () => ({ ok: true, store_ids: null }), refuse: () => {} }).getRouter());
    const server = await new Promise((resolve) => { const sv = app.listen(0, () => resolve(sv)); });
    const post = (path, body) =>
      new Promise((resolve) => {
        const r = http.request({ port: server.address().port, path, method: "POST", headers: { "content-type": "application/json" } }, (res) => {
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"] }));
        });
        r.end(JSON.stringify(body));
      });
    try {
      for (const path of ["/r/epf/ecr", "/r/esi/contribution-file"]) {
        assert.equal((await post(path, { year: 2026, month: 9, acknowledge_blocked: true })).status, 400, `${path}: no partial flag`);
        assert.equal((await post(path, { year: 2026, month: 9, field_keys: ["uan"] })).status, 400, `${path}: no column list`);
      }
      assert.equal(seen.length, 0);
      assert.equal((await post("/r/epf/ecr", { year: 2026, month: 9 })).type, "text/plain; charset=utf-8");
      assert.equal((await post("/r/esi/contribution-file", { year: 2026, month: 9 })).type, "application/vnd.ms-excel");
    } finally {
      server.close();
    }
  });
});
