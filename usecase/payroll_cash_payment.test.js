/**
 * Cash Payment Excel - the service and the route, with an in-memory repository.
 *
 *   node --test usecase/payroll_cash_payment.test.js
 *
 * The fake repository keeps STORED payrun rows and answers the three reads
 * the service makes by the same rules the SQL states: pay type is the
 * approved calculation's, else the payrun snapshot's; the reference counts
 * only approved & locked CASH rows with net pay above zero.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const express = require("express");
const ExcelJS = require("exceljs");

const buildService = require("./payroll_report_service");
const buildRoutes = require("../routes/payroll_report");
const cash = require("../utils/cash_payment_report");

const READ = ["view_reports", "view_employees", "view_payroll", "view_salary"];
const actor = (extra = []) => ({ userId: 7, employeeId: 70, isAdmin: false, permissions: [...READ, ...extra] });
const EXPORTER = actor(["export_reports"]);
const AUG = { year: 2026, month: 8 };

/** One stored payrun employee: snapshot pay type, and its calculation if any. */
const emp = (id, over = {}) => ({
  period: AUG,
  employee_id: id,
  employee_name: `Employee ${id}`,
  store_id: over.store_id || 1,
  store_name: over.store_name || "Anna Nagar",
  snapshot_pay_type: over.snapshot_pay_type || "CASH",
  calc: over.calc === null ? null : { status: "APPROVED_LOCKED", pay_type: "CASH", net_pay: "18760.00", ...(over.calc || {}) },
});

function fakeRepo(stored) {
  const inMonth = ({ year, month, store_ids }) =>
    stored.filter((e) => e.period.year === year && e.period.month === month && (store_ids === null || store_ids.includes(e.store_id)));
  const payType = (e) => (e.calc && e.calc.status === "APPROVED_LOCKED" ? e.calc.pay_type : e.snapshot_pay_type);
  return {
    listCashPayRows: async (scope) =>
      inMonth(scope)
        .filter((e) => payType(e) === "CASH")
        .map((e) => ({
          employee_id: e.employee_id,
          employee_name: e.employee_name,
          store_name: e.store_name,
          status: e.calc ? e.calc.status : null,
          net_pay: e.calc ? e.calc.net_pay : null,
          pay_type: payType(e),
        })),
    payrunTotals: async (scope) => ({ finalized: inMonth(scope).filter((e) => e.calc && e.calc.status === "APPROVED_LOCKED").length }),
    cashPayrunTotals: async (scope) => {
      const payable = inMonth(scope).filter(
        (e) => e.calc && e.calc.status === "APPROVED_LOCKED" && e.calc.pay_type === "CASH" && Number(e.calc.net_pay) > 0
      );
      return { employees: payable.length, net_pay: payable.reduce((s, e) => s + Number(e.calc.net_pay), 0) };
    },
  };
}

function setup(stored) {
  const exports = [];
  const templates = { logExport: async (e) => exports.push(e) };
  return { service: buildService(fakeRepo(stored), templates), exports };
}

const employeesOf = async (file) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file.buffer);
  const ws = wb.getWorksheet("Cash Denomination");
  const ids = [];
  for (let r = 6; typeof ws.getCell(r, 1).value === "number"; r += 1) ids.push(ws.getCell(r, 2).value);
  return { wb, ids };
};

describe("cashPaymentFile - population", () => {
  it("includes Cash employees and excludes Bank employees", async () => {
    const { service } = setup([
      emp(1),
      emp(2, { snapshot_pay_type: "BANK", calc: { pay_type: "BANK" } }),
      emp(3, { calc: { net_pay: "700.00" } }),
    ]);
    const file = await service.cashPaymentFile(EXPORTER, AUG, null);
    assert.equal(file.filename, "Cash Payment - Aug 2026.xlsx");
    assert.deepEqual((await employeesOf(file)).ids, [1, 3]);
    assert.deepEqual(file.summary, { employees: 2, total_net_pay: 18760 + 700, excluded: 0 });
  });

  it("the approved calculation's pay type wins over the payrun snapshot", async () => {
    const { service } = setup([
      emp(1, { snapshot_pay_type: "BANK", calc: { pay_type: "CASH" } }), // moved to Cash before approval
      emp(2, { snapshot_pay_type: "CASH", calc: { pay_type: "BANK" } }), // moved to Bank before approval
    ]);
    assert.deepEqual((await employeesOf(await service.cashPaymentFile(EXPORTER, AUG, null))).ids, [1]);
  });

  it("is limited to the caller's branch scope", async () => {
    const { service } = setup([emp(1, { store_id: 1 }), emp(2, { store_id: 2, store_name: "Velachery" })]);
    assert.deepEqual((await employeesOf(await service.cashPaymentFile(EXPORTER, AUG, [2]))).ids, [2]);
  });

  it("net pay in the file is exactly the stored finalized net pay", async () => {
    const { service } = setup([emp(1, { calc: { net_pay: "12345.00" } })]);
    const { wb } = await employeesOf(await service.cashPaymentFile(EXPORTER, AUG, null));
    assert.equal(wb.getWorksheet("Cash Denomination").getCell("E6").value, 12345);
    assert.equal(wb.getWorksheet("Acknowledgement").getCell("E5").value, 12345);
  });

  it("records the export in the audit log, without values", async () => {
    const { service, exports } = setup([emp(1)]);
    await service.cashPaymentFile(EXPORTER, AUG, null);
    assert.equal(exports.length, 1);
    assert.equal(exports[0].dataset_key, "PAYROLL_CASH");
    assert.equal(exports[0].format, "xlsx");
    assert.equal(exports[0].row_count, 1);
    assert.equal(exports[0].filters.period, "2026-08");
  });
});

describe("cashPaymentFile - refusals", () => {
  it("refuses a month whose payroll is not finalized", async () => {
    const { service, exports } = setup([emp(1, { calc: { status: "CALCULATED" } }), emp(2, { calc: null })]);
    await assert.rejects(
      service.cashPaymentFile(EXPORTER, AUG, null),
      (e) => e.code === "PAYROLL_NOT_FINALIZED" && e.httpCode === 409 && e.message === "Cash Payment Report can be generated only after payroll is finalized."
    );
    assert.equal(exports.length, 0);
  });

  it("refuses while any one Cash employee is still pending, even if others are approved", async () => {
    const { service } = setup([emp(1), emp(2, { calc: { status: "CALCULATED" } })]);
    await assert.rejects(service.cashPaymentFile(EXPORTER, AUG, null), (e) => e.code === "PAYROLL_NOT_FINALIZED" && e.detail.pending[0].employee_id === 2);
  });

  it("a finalized month with no Cash employees gives the message, not an empty workbook", async () => {
    const { service } = setup([emp(1, { snapshot_pay_type: "BANK", calc: { pay_type: "BANK" } })]);
    await assert.rejects(
      service.cashPaymentFile(EXPORTER, AUG, null),
      (e) => e.code === "NO_CASH_EMPLOYEES" && e.message === "No employees with Cash payment mode found for this payroll month."
    );
  });

  it("needs the export permission", async () => {
    const { service } = setup([emp(1)]);
    await assert.rejects(service.cashPaymentFile(actor(), AUG, null), (e) => e.code === "EXPORT_FORBIDDEN");
    const noSalary = { ...EXPORTER, permissions: EXPORTER.permissions.filter((p) => p !== "view_salary") };
    await assert.rejects(service.cashPaymentFile(noSalary, AUG, null), (e) => e.code === "DATASET_FORBIDDEN");
  });
});

describe("route POST /cash-payment/xlsx", () => {
  async function serve(svc) {
    const app = express();
    app.use(express.json());
    const branchScope = { actorFor: async () => EXPORTER, listFilters: async () => ({ ok: true, store_ids: null }), refuse: () => {} };
    app.use("/r", buildRoutes(svc, { requireAll: () => (q, s, n) => n() }, branchScope).getRouter());
    const server = await new Promise((resolve) => {
      const sv = app.listen(0, () => resolve(sv));
    });
    const post = (body) =>
      new Promise((resolve) => {
        const req = http.request(
          { port: server.address().port, path: "/r/cash-payment/xlsx", method: "POST", headers: { "content-type": "application/json" } },
          (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
          }
        );
        req.end(JSON.stringify(body));
      });
    return { server, post };
  }

  it("requires the payroll read keys and export_reports", () => {
    const keys = {};
    const permissions = {
      requireAll: (...ks) => {
        const mw = (req, res, next) => next();
        mw.keys = ks;
        return mw;
      },
    };
    const routes = buildRoutes({}, permissions, { actorFor: async () => ({}), listFilters: async () => ({ ok: true, store_ids: null }) });
    for (const layer of routes.getRouter().stack) keys[`${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`] = layer.route.stack[0].handle.keys;
    const k = keys["POST /cash-payment/xlsx"];
    assert.ok(k, "route exists");
    for (const key of [...READ, "export_reports"]) assert.ok(k.includes(key), key);
  });

  it("downloads the workbook with its filename, and returns the refusal as JSON", async () => {
    const { service } = setup([emp(1)]);
    const { server, post } = await serve(service);
    try {
      const ok = await post(AUG);
      assert.equal(ok.status, 200);
      assert.equal(ok.headers["content-type"], "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      assert.equal(ok.headers["content-disposition"], 'attachment; filename="Cash Payment - Aug 2026.xlsx"');
      assert.equal(ok.body.slice(0, 2).toString(), "PK");

      const none = await post({ year: 2026, month: 9 });
      assert.equal(none.status, 409);
      assert.equal(JSON.parse(none.body).msg, cash.MESSAGES.NOT_FINALIZED);

      assert.equal((await post({ ...AUG, field_keys: ["net_pay"] })).status, 400, "the month only");
    } finally {
      server.close();
    }
  });
});
