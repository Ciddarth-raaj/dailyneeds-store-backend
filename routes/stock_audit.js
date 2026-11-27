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
    const NONE = (branchScope.EMPLOYEE_BRANCH_SCOPE && branchScope.EMPLOYEE_BRANCH_SCOPE.NONE) || "NONE";
    if (!r || r.kind === NONE) return { ok: false, code: 403, msg: "You have no branch assignment" };
    if (!r.store_ids) {
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
    // ACTIVATION SWITCH: off unless STOCK_AUDIT_ENABLED=true on the server. A
    // deployment therefore exposes nothing until the module is switched on.
    router.use((req, res, next) => (this.deps.enabled === false ? res.status(503).json({ code: 503, msg: "Stock Audit is not enabled on this server" }) : next()));
    // STAGED ACCESS: while restricted, only administrators and the listed
    // designations (HR) get in - before any permission key is even looked at.
    router.use((req, res, next) => {
      const a = this.deps.access;
      if (!a || a.mode === "all") return next();
      const d = req.decoded || {};
      const admin = Number(d.user_type) === Number(permissions.ADMIN_USER_TYPE);
      if (admin || (a.designationIds || []).includes(Number(d.designation_id))) return next();
      return res.status(503).json({ code: 503, msg: "Stock Audit is not open to you yet (staged rollout)" });
    });
    const need = (...keys) => permissions.require(...keys);
    const isAdmin = (req) => Number((req.decoded || {}).user_type) === Number(permissions.ADMIN_USER_TYPE);
    // seasons (and the internal audit cycles behind them) are created and changed by administrators only
    const adminOnly = (req, res, next) => (isAdmin(req) ? next() : res.status(403).json({ code: 403, msg: "Only an administrator can create or change a season" }));
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
        return U.meta({ outlets: s.ok ? s.outlets : [], canManageSeasons: isAdmin(req) });
      }));
    router.get("/stores", need(P.VIEW_STORE, P.VIEW_ALL_STORES), scoped((req, outlets) => U.stores({ period: period(req), outlets })));
    router.get("/stores/:outlet_id", need(P.VIEW_STORE, P.VIEW_ALL_STORES),
      handle(async (req, res) => {
        const s = await this.scope(req, req.params.outlet_id);
        if (!s.ok) return void res.status(s.code).json({ code: s.code, msg: s.msg });
        return U.store({ period: period(req), outletId: Number(req.params.outlet_id), outlets: s.outlets });
      }));
    router.get("/employees", need(P.VIEW_STORE, P.VIEW_ALL_STORES),
      scoped((req, outlets) => U.employees({ period: period(req), outlets, search: req.query.search, page: req.query.page, size: req.query.size, sort: req.query.sort, mapped: req.query.mapped === "true" ? true : req.query.mapped === "false" ? false : null })));
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
    // the internal cycles behind each season: an administrators' technical reference (screens use /meta seasons)
    router.get("/cycles", adminOnly, handle(() => U.cycles()));
    // read-only technical reference: a season creates and changes its own internal cycles
    const seasonOnly = (req, res) => res.status(410).json({ code: 410, msg: "Audit cycles are created and changed with their season (Season Master)" });
    router.post("/cycles", adminOnly, seasonOnly);
    router.put("/cycles/:period_code", adminOnly, seasonOnly);
    router.get("/sync", need(P.RUN_SYNC, P.VIEW_ALL_STORES), handle(() => U.syncRuns()));
    router.post("/sync", need(P.RUN_SYNC),
      handle(async (req, res) => {
        // a second switch for the RetailPilot sync (STOCK_AUDIT_SYNC_ENABLED=true); never scheduled from here
        if (this.deps.syncEnabled === false) return void res.status(503).json({ code: 503, msg: "The RetailPilot stock audit sync is not enabled on this server" });
        return U.startSync({ kind: String(req.body.kind || "INCREMENTAL"), by: by(req) });
      }));

    // ---------------------------------------------------------------- eligible headcount, exclusions, responsible persons
    const inStore = (fn) =>
      handle(async (req, res) => {
        const s = await this.scope(req, req.params.outlet_id);
        if (!s.ok) return void res.status(s.code).json({ code: s.code, msg: s.msg });
        return fn(req, Number(req.params.outlet_id));
      });
    router.get("/eligibility", need(P.MANAGE_CYCLES, P.APPROVE_EXCLUSIONS, P.VIEW_STORE, P.VIEW_ALL_STORES), scoped((req, outlets) => U.eligibility({ period: period(req), outlets })));
    router.post("/eligibility/:outlet_id/snapshot", need(P.MANAGE_CYCLES), inStore((req, outletId) => U.takeSnapshot({ period: period(req), outletId, by: by(req) })));
    router.post("/eligibility/:outlet_id/employees", need(P.MANAGE_CYCLES),
      inStore((req, outletId) => U.addToSnapshot({ period: period(req), outletId, employeeId: Number(req.body.employee_id), note: req.body.note, by: by(req) })));
    router.post("/eligibility/:outlet_id/exclusions", need(P.MANAGE_CYCLES),
      inStore((req, outletId) => U.requestExclusion({ period: period(req), outletId, employeeId: Number(req.body.employee_id), reason: req.body.reason, by: by(req) })));
    router.post("/exclusions/:id/approve", need(P.APPROVE_EXCLUSIONS), handle((req) => U.decideExclusion({ id: Number(req.params.id), approve: true, note: req.body.note, by: by(req) })));
    router.post("/exclusions/:id/reject", need(P.APPROVE_EXCLUSIONS), handle((req) => U.decideExclusion({ id: Number(req.params.id), approve: false, note: req.body.note, by: by(req) })));
    router.post("/exclusions/:id/withdraw", need(P.MANAGE_CYCLES), handle((req) => U.withdrawExclusion({ id: Number(req.params.id), by: by(req) })));
    router.get("/roles", need(P.MANAGE_ROLES, P.VIEW_STORE, P.VIEW_ALL_STORES), scoped((req, outlets) => U.roles({ period: period(req), outlets })));
    router.put("/roles", need(P.MANAGE_ROLES),
      handle(async (req, res) => {
        const role = String(req.body.role || "");
        // the period's Operations Manager is a company-wide choice
        const s = role === "OPERATIONS_MANAGER" ? (await permissions.has(req, P.VIEW_ALL_STORES) ? { ok: true } : { ok: false, code: 403, msg: "Assigning the Operations Manager needs view_stock_audit_all_stores" }) : await this.scope(req, req.body.outlet_id);
        if (!s.ok) return void res.status(s.code).json({ code: s.code, msg: s.msg });
        return U.assignRole({ period: period(req), outletId: req.body.outlet_id, role, employeeId: Number(req.body.employee_id), reason: req.body.reason, by: by(req) });
      }));
    router.get("/settings", need(P.MANAGE_POLICY, P.MANAGE_ROLES, P.MANAGE_CYCLES), handle(() => U.settingsView()));
    router.put("/settings", need(P.MANAGE_POLICY), handle((req) => U.updateSettings(req.body || {}, by(req))));

    // ---------------------------------------------------------------- Premier League
    router.get("/sapl/standings", need(P.VIEW_SAPL), handle((req) => U.standings({ period: period(req) })));
    router.get("/sapl/seasons", need(P.VIEW_SAPL), handle(() => U.seasons()));
    router.post("/sapl/seasons", adminOnly, handle((req) => U.createSeason({ ...req.body, by: by(req) })));
    router.put("/sapl/seasons/:season_id", adminOnly, handle((req) => U.updateSeason(Number(req.params.season_id), req.body || {})));
    router.post("/sapl/seasons/:season_id/snapshot", need(P.MANAGE_SAPL), handle(async (req) => {
      const s = (await U.seasons()).find((x) => x.season_id === Number(req.params.season_id));
      return U.snapshotStandings({ period: s ? s.period_code : null });
    }));
    router.post("/sapl/seasons/:season_id/verify", adminOnly, handle((req) => U.verifySeason(Number(req.params.season_id), by(req))));
    router.post("/sapl/seasons/:season_id/finalize", adminOnly, handle((req) => U.finalizeSeason(Number(req.params.season_id), by(req))));
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
