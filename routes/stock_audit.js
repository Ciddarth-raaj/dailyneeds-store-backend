const express = require("express");
const respondError = require("../utils/http");
const P = require("../constants/stock_audit_permissions");
const { DEFAULT_POLICY } = require("../utils/stock_audit_policy");

/**
 * /stock-audit - every Stock Audit & Premier League screen.
 *
 * ONE permission key per decision (constants/stock_audit_permissions.js),
 * checked first; then the caller's STORE SCOPE:
 *   - view_stock_audit_all_stores (or administrator) -> the five programme stores
 *   - otherwise -> only the caller's own branch(es), from the shared employee
 *     branch-scope resolver. A query naming another store is refused.
 *   - view_own_stock_audit_performance alone -> only the caller's own figures
 * The warehouse is never a programme store.
 *
 * NOT ENABLED (answer 501 on purpose): incentive approval, revocation,
 * payroll posting. Nothing here writes to payroll or to RetailPilot.
 */
const NOT_ENABLED = (what) => (req, res) => res.status(501).json({ code: 501, msg: `${what} is not enabled. It needs separate authorisation before it can be switched on.` });

class StockAuditRoutes {
  /** @param deps { usecase, permissions, branchScope } */
  constructor(deps) {
    this.deps = deps;
    this.router = express.Router();
    this.init();
  }

  /** The stores this caller may see: null = all programme stores. */
  async scope(req, requestedOutlet) {
    const { permissions, branchScope } = this.deps;
    const programme = DEFAULT_POLICY.programme.outletIds;
    const want = requestedOutlet == null || requestedOutlet === "" ? null : Number(requestedOutlet);
    if (want != null && !programme.includes(want)) return { ok: false, code: 400, msg: "Not a programme store (the warehouse is excluded)" };
    if (await permissions.has(req, P.VIEW_ALL_STORES)) return { ok: true, outlets: want != null ? [want] : null };
    const r = await branchScope.resolve(req);
    if (!r || !r.store_ids) {
      // an HR-wide branch scope is not a Stock Audit company-wide key
      return { ok: false, code: 403, msg: "Company-wide Stock Audit needs view_stock_audit_all_stores" };
    }
    const own = r.store_ids.map(Number).filter((o) => programme.includes(o));
    if (want != null) return own.includes(want) ? { ok: true, outlets: [want] } : { ok: false, code: 403, msg: "This store is outside your branch scope" };
    return { ok: true, outlets: own };
  }

  init() {
    const { usecase: U, permissions } = this.deps;
    const router = this.router;
    const need = (...keys) => permissions.require(...keys);
    const by = (req) => (req.auth ? req.auth.employeeId : req.decoded && req.decoded.employee_id) ?? null;
    const handle = (fn) => async (req, res) => {
      try {
        const data = await fn(req, res);
        if (!res.headersSent) res.json({ code: 200, data });
      } catch (err) {
        if (err && Number.isInteger(err.status)) return res.status(err.status).json({ code: err.status, msg: err.message });
        respondError(res, err);
      }
    };
    const scoped = (fn) =>
      handle(async (req, res) => {
        const s = await this.scope(req, req.query.outlet_id);
        if (!s.ok) {
          res.status(s.code).json({ code: s.code, msg: s.msg });
          return null;
        }
        return fn(req, s.outlets);
      });
    const period = (req) => (req.query.period ? String(req.query.period) : null);

    // ---------------------------------------------------------------- monitoring
    router.get("/meta", need(P.VIEW_STORE, P.VIEW_ALL_STORES, P.VIEW_OWN_PERFORMANCE, P.VIEW_SAPL, P.DOWNLOAD_HR_PDF, P.IMPORT_ALLOTMENT),
      handle(async (req) => {
        const s = await this.scope(req, null).catch(() => ({ ok: false }));
        return U.meta({ outlets: s.ok ? s.outlets : [] });
      }));
    router.get("/stores", need(P.VIEW_STORE, P.VIEW_ALL_STORES), scoped((req, outlets) => U.stores({ period: period(req), outlets })));
    router.get("/stores/:outlet_id", need(P.VIEW_STORE, P.VIEW_ALL_STORES),
      handle(async (req, res) => {
        const s = await this.scope(req, req.params.outlet_id);
        if (!s.ok) return void res.status(s.code).json({ code: s.code, msg: s.msg });
        return U.store({ period: period(req), outletId: Number(req.params.outlet_id), outlets: s.outlets });
      }));
    router.get("/employees", need(P.VIEW_STORE, P.VIEW_ALL_STORES),
      scoped((req, outlets) => U.employees({ period: period(req), outlets, search: req.query.search, page: req.query.page, size: req.query.size, sort: req.query.sort })));
    router.get("/employees/:rp_user_id", need(P.VIEW_STORE, P.VIEW_ALL_STORES), scoped((req, outlets) => U.employee({ period: period(req), rpUserId: req.params.rp_user_id, outlets })));
    router.get("/employees/:rp_user_id/articles", need(P.VIEW_STORE, P.VIEW_ALL_STORES),
      scoped((req, outlets) => U.articles({ period: period(req), rpUserId: req.params.rp_user_id, outlets, page: req.query.page, size: req.query.size })));

    // self-service: the caller's own RetailPilot ids only, whatever is asked
    router.get("/my", need(P.VIEW_OWN_PERFORMANCE),
      handle(async (req) => {
        const ids = await U.ownRpIds(by(req));
        if (!ids.length) return { mapped: false, employees: [] };
        const list = [];
        for (const id of ids) {
          const e = await U.employee({ period: period(req), rpUserId: id, selfRpIds: ids });
          if (e) list.push(e);
        }
        return { mapped: true, employees: list };
      }));
    router.get("/my/:rp_user_id/articles", need(P.VIEW_OWN_PERFORMANCE),
      handle(async (req) => U.articles({ period: period(req), rpUserId: req.params.rp_user_id, selfRpIds: await U.ownRpIds(by(req)), page: req.query.page, size: req.query.size })));

    router.get("/verifications", need(P.VIEW_STORE, P.VIEW_ALL_STORES), scoped((req, outlets) => U.verifications({ period: period(req), outlets, page: req.query.page, size: req.query.size })));
    router.get("/variances", need(P.VIEW_STORE, P.VIEW_ALL_STORES),
      scoped((req, outlets) => U.variances({ period: period(req), outlets, kind: req.query.kind || null, page: req.query.page, size: req.query.size })));
    router.post("/stores/:outlet_id/independent-verification", need(P.REVIEW_VERIFICATION),
      handle(async (req, res) => {
        if (!(await permissions.has(req, P.VIEW_ALL_STORES))) return void res.status(403).json({ code: 403, msg: "Independent verification is done by someone outside the store" });
        return U.recordStoreVerification({ period: period(req), outletId: Number(req.params.outlet_id), done: req.body.done === true, comment: req.body.comment, by: by(req), byOutletId: req.auth ? req.auth.storeId : null });
      }));

    // ---------------------------------------------------------------- incentives (figures only)
    router.get("/management", need(P.VIEW_STORE, P.VIEW_ALL_STORES), scoped((req, outlets) => U.management({ period: period(req), outlets })));
    router.get("/operations-manager", need(P.VIEW_ALL_STORES), handle((req) => U.operationsManager({ period: period(req) })));
    router.get("/approvals", need(P.APPROVE_INCENTIVES, P.CALCULATE_INCENTIVES), scoped((req, outlets) => U.approvals({ period: period(req), outlets })));
    router.post("/approvals/:id/approve", need(P.APPROVE_INCENTIVES), NOT_ENABLED("Incentive approval"));
    router.post("/approvals/:id/reject", need(P.APPROVE_INCENTIVES), NOT_ENABLED("Incentive approval"));
    router.post("/incentives/:id/revoke", need(P.REVOKE_INCENTIVES), NOT_ENABLED("Incentive revocation"));
    router.post("/payroll/post", need(P.PROCESS_PAYROLL), NOT_ENABLED("Payroll posting"));
    router.get("/policy-versions", need(P.MANAGE_POLICY, P.CALCULATE_INCENTIVES), handle(() => U.policyVersions()));

    // ---------------------------------------------------------------- allotment import
    router.get("/allotment/uploads", need(P.IMPORT_ALLOTMENT, P.VIEW_ALL_STORES), handle(() => U.uploads()));
    router.get("/allotment/uploads/:batch_id", need(P.IMPORT_ALLOTMENT), handle((req) => U.upload(Number(req.params.batch_id))));
    router.post("/allotment/validate", need(P.IMPORT_ALLOTMENT), handle((req) => U.validateUpload({ period_code: req.body.period_code, files: req.body.files, by: by(req) })));
    router.post("/allotment/uploads/:batch_id/confirm", need(P.IMPORT_ALLOTMENT), handle((req) => U.confirmUpload(Number(req.params.batch_id), by(req))));
    router.post("/allotment/uploads/:batch_id/discard", need(P.IMPORT_ALLOTMENT), handle((req) => U.discardUpload(Number(req.params.batch_id))));

    // ---------------------------------------------------------------- mapping, cycles, sync
    router.get("/mapping", need(P.MANAGE_EMPLOYEE_MAPPING), scoped((req, outlets) => U.mapping({ outlets })));
    router.get("/mapping/employees", need(P.MANAGE_EMPLOYEE_MAPPING), scoped((req, outlets) => U.employeeChoices({ outlets })));
    router.put("/mapping/:rp_user_id", need(P.MANAGE_EMPLOYEE_MAPPING),
      handle((req) => U.setMapping({ rp_user_id: req.params.rp_user_id, employee_id: req.body.employee_id == null ? null : Number(req.body.employee_id), note: req.body.note, by: by(req) })));
    router.get("/cycles", need(P.MANAGE_CYCLES, P.VIEW_STORE, P.VIEW_ALL_STORES, P.IMPORT_ALLOTMENT), handle(() => U.cycles()));
    router.post("/cycles", need(P.MANAGE_CYCLES), handle((req) => U.createPeriod({ ...req.body, by: by(req) })));
    router.put("/cycles/:period_code", need(P.MANAGE_CYCLES), handle((req) => U.updatePeriod(String(req.params.period_code), req.body || {})));
    router.get("/sync", need(P.RUN_SYNC, P.VIEW_ALL_STORES), handle(() => U.syncRuns()));
    router.post("/sync", need(P.RUN_SYNC), handle((req) => U.startSync({ kind: String(req.body.kind || "INCREMENTAL"), by: by(req) })));

    // ---------------------------------------------------------------- Premier League
    router.get("/sapl/standings", need(P.VIEW_SAPL), handle((req) => U.standings({ period: period(req) })));
    router.get("/sapl/seasons", need(P.VIEW_SAPL), handle(() => U.seasons()));
    router.post("/sapl/seasons", need(P.MANAGE_SAPL), handle((req) => U.createSeason({ ...req.body, by: by(req) })));
    router.put("/sapl/seasons/:season_id", need(P.MANAGE_SAPL), handle((req) => U.updateSeason(Number(req.params.season_id), req.body || {})));
    router.post("/sapl/seasons/:season_id/snapshot", need(P.MANAGE_SAPL), handle(async (req) => {
      const s = (await U.seasons()).find((x) => x.season_id === Number(req.params.season_id));
      return U.snapshotStandings({ period: s ? s.period_code : null });
    }));
    router.post("/sapl/seasons/:season_id/verify", need(P.MANAGE_SAPL), handle((req) => U.verifySeason(Number(req.params.season_id), by(req))));
    router.post("/sapl/seasons/:season_id/finalize", need(P.MANAGE_SAPL), handle((req) => U.finalizeSeason(Number(req.params.season_id), by(req))));
    router.post("/sapl/seasons/:season_id/prize/draft", need(P.MANAGE_SAPL_PRIZE), handle((req) => U.draftPrize(Number(req.params.season_id), by(req))));
    router.get("/sapl/seasons/:season_id/prize", need(P.MANAGE_SAPL_PRIZE), handle((req) => U.prizeShares(Number(req.params.season_id))));

    // ---------------------------------------------------------------- HR daily PDFs (data; the PDF is drawn in the browser)
    router.get("/hr/report", need(P.DOWNLOAD_HR_PDF), handle((req) => U.hrReport({ period: period(req), date: req.query.date ? String(req.query.date) : null })));
  }

  getRouter() {
    return this.router;
  }
}

module.exports = (deps) => new StockAuditRoutes(deps);
