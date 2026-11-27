/**
 * Stock Audit & Premier League - what every screen reads and the few
 * actions it can take. Calculations live in utils (pure); this loads the
 * data, applies the caller's store scope and caches one period's figures
 * briefly (they are recomputed after every write).
 *
 * NOT here, on purpose: incentive approval, revocation and payroll posting.
 * Those stay disabled until they are separately authorised - the screens
 * show the figures and "approval not enabled".
 */
const S = require("../utils/stock_audit_status");
const { DEFAULT_POLICY, PROGRAMME, CONFIRMED } = require("../utils/stock_audit_policy");
const { computePeriod } = require("../utils/stock_audit_progress");
const A = require("../utils/stock_audit_allotment");
const L = require("../utils/stock_audit_sapl");
const { istDate } = require("../utils/stock_audit_activity");
const { codeError } = require("../repository/stock_audit");

const CACHE_MS = 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD_RE = /^[A-Za-z0-9_-]{2,16}$/;
const MAX_FILES = 400;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Designation IDS (DNDS designation table, read in production 27 Nov 2026).
 * Defaults only: HR changes them in the module settings (with history).
 *   eligible counting staff: 2 Customer Service Associate, 4 Cashier
 *   roles: 9 Supervisor, 3 Store Manager, 27 Operations Manager
 */
const DEFAULT_SETTINGS = Object.freeze({
  eligible_designation_ids: [2, 4],
  role_designation_ids: { SUPERVISOR: [9], STORE_MANAGER: [3], OPERATIONS_MANAGER: [27] },
});
const ROLES = ["SUPERVISOR", "STORE_MANAGER", "OPERATIONS_MANAGER"];

const page = (list, p = 1, size = 20) => {
  const n = Math.min(Math.max(Number(size) || 20, 1), 200);
  const pages = Math.max(1, Math.ceil(list.length / n));
  const cur = Math.min(Math.max(Number(p) || 1, 1), pages);
  return { rows: list.slice((cur - 1) * n, cur * n), total: list.length, page: cur, size: n, pages };
};
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
/** IST date -> UTC instant of its midnight */
const istMidnightUtc = (date) => new Date(Date.parse(`${date}T00:00:00+05:30`)).toISOString().slice(0, 23).replace("T", " ");

class StockAuditUsecase {
  constructor(repo, { policy = DEFAULT_POLICY, now = () => new Date(), sync = null } = {}) {
    this.repo = repo;
    this.policy = policy;
    this.now = now;
    this.sync = sync;
    this.cache = new Map();
  }

  invalidate() {
    this.cache.clear();
  }

  today() {
    return istDate(this.now().toISOString());
  }

  /** Programme stores (Branch Master) - the warehouse is never one. */
  async programmeStores() {
    const all = await this.repo.rpOutlets();
    return all.filter((o) => this.policy.programme.outletIds.includes(o.outlet_id));
  }

  async currentPeriod(requested) {
    const periods = await this.repo.periods();
    if (requested) {
      if (!periods.find((p) => p.period_code === requested)) throw codeError(404, `Audit period ${requested} not found`);
      return requested;
    }
    const today = this.today();
    const open = periods.find((p) => p.start_date <= today && p.end_date >= today) || periods[0];
    return open ? open.period_code : null;
  }

  // ---------------------------------------------------------------- the period's figures
  async period(periodCode) {
    const code = await this.currentPeriod(periodCode);
    if (!code) return null;
    const hit = this.cache.get(code);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const value = await this._compute(code);
    this.cache.set(code, { at: Date.now(), value });
    return value;
  }

  /**
   * @param opts.asOfDate an IST date in the past: figures as they stood at
   *   the end of that day (audits and recounts up to then). The allotment is
   *   the CURRENT revision - earlier revisions are kept but not replayed.
   */
  async _compute(code, { asOfDate = null } = {}) {
    const stores = await this.programmeStores();
    const cycles = (await this.repo.cycles(code)).filter((c) => this.policy.programme.outletIds.includes(c.outlet_id));
    const cycleIds = cycles.map((c) => c.cycle_id);
    const outletIds = cycles.map((c) => c.outlet_id);
    const from = cycles.length ? istMidnightUtc(cycles.map((c) => c.start_date).sort()[0]) : null;
    const to = cycles.length ? istMidnightUtc(addDays(cycles.map((c) => c.end_date).sort().pop(), 1)) : null;
    const settings = await this.settings();
    const [sessions, allotment, allotmentCycles, people, rpNames, verifications, reviews, verifiedStores, assignments, headcount, lastSync] = await Promise.all([
      from ? this.repo.sessions(outletIds, from, to) : [],
      this.repo.allotmentRows(cycleIds),
      this.repo.allotmentCycles(cycleIds),
      this.repo.people(),
      this.repo.rpNames(),
      this.repo.verifications(cycleIds),
      this.repo.reviews(cycleIds),
      this.repo.storeVerifications(cycleIds),
      this.repo.roleAssignments(code),
      this.headcount(cycles, settings),
      this.repo.lastSuccess(),
    ]);
    // responsible persons: ONLY the assigned ones (never guessed from a designation name)
    const roleHolders = new Map();
    for (const o of outletIds) {
      const held = (role) => {
        const a = assignments.find((x) => x.outlet_id === o && x.role === role);
        return a ? { employee_id: a.employee_id, name: a.employee_name } : null;
      };
      roleHolders.set(o, { SUPERVISOR: held("SUPERVISOR"), STORE_MANAGER: held("STORE_MANAGER") });
    }
    const omA = assignments.find((x) => x.role === "OPERATIONS_MANAGER");
    const omHolder = omA ? { employee_id: omA.employee_id, name: omA.employee_name } : null;
    const independentVerification = new Map(cycles.filter((c) => verifiedStores.has(c.cycle_id)).map((c) => [c.outlet_id, verifiedStores.get(c.cycle_id)]));
    const cut = asOfDate ? new Date(Date.parse(`${asOfDate}T23:59:59.999+05:30`)).toISOString() : null;
    const upTo = (t) => !cut || (t != null && String(t) <= cut);
    const result = computePeriod(
      {
        cycles,
        stores: stores.filter((s) => outletIds.includes(s.outlet_id)),
        sessions: cut ? sessions.filter((s) => upTo(s.finalized_at || s.started_at)) : sessions,
        allotment,
        allotmentCycles,
        people,
        rpNames,
        verifications: cut ? verifications.filter((v) => upTo(v.recount_at)) : verifications,
        reviews,
        roleHolders,
        omHolder,
        headcount,
        independentVerification,
        today: asOfDate || this.today(),
        asOf: cut || this.now().toISOString(),
      },
      this.policy
    );
    return { period_code: code, cycles, last_sync: lastSync ? lastSync.finished_at : null, sessions, ...result };
  }

  // ---------------------------------------------------------------- settings, headcount, exclusions, roles
  async settings() {
    const out = {};
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
      const row = await this.repo.getSetting(k);
      out[k] = row ? row.value : v;
    }
    return out;
  }

  async settingsView() {
    const [values, designations] = await Promise.all([this.settings(), this.repo.designations()]);
    const history = {};
    for (const k of Object.keys(DEFAULT_SETTINGS)) history[k] = await this.repo.settingHistory(k);
    return { values, defaults: DEFAULT_SETTINGS, designations, history };
  }

  async updateSettings(values, by) {
    const ids = (v) => Array.isArray(v) && v.length > 0 && v.every((x) => Number.isInteger(x) && x > 0);
    if (values.eligible_designation_ids !== undefined) {
      if (!ids(values.eligible_designation_ids)) throw codeError(400, "eligible_designation_ids: a list of designation ids");
      await this.repo.setSetting("eligible_designation_ids", values.eligible_designation_ids, by);
    }
    if (values.role_designation_ids !== undefined) {
      const r = values.role_designation_ids || {};
      if (!ROLES.every((k) => ids(r[k]))) throw codeError(400, "role_designation_ids: designation ids for SUPERVISOR, STORE_MANAGER and OPERATIONS_MANAGER");
      await this.repo.setSetting("role_designation_ids", { SUPERVISOR: r.SUPERVISOR, STORE_MANAGER: r.STORE_MANAGER, OPERATIONS_MANAGER: r.OPERATIONS_MANAGER }, by);
    }
    this.invalidate();
    return this.settingsView();
  }

  /**
   * Eligible headcount per store cycle: the frozen snapshot when taken, else
   * the live active staff with an eligible designation (provisional). Approved
   * exclusions are removed either way.
   */
  async headcount(cycles, settings) {
    const cycleIds = cycles.map((c) => c.cycle_id);
    const [snaps, snapRows, excl, live] = await Promise.all([
      this.repo.snapshots(cycleIds),
      this.repo.snapshotEmployees(cycleIds),
      this.repo.exclusions(cycleIds),
      this.repo.activeStaff(cycles.map((c) => c.outlet_id), settings.eligible_designation_ids),
    ]);
    const out = new Map();
    for (const c of cycles) {
      const snapped = snaps.some((x) => x.cycle_id === c.cycle_id);
      const base = snapped ? snapRows.filter((r) => r.cycle_id === c.cycle_id) : live.filter((e) => e.outlet_id === c.outlet_id);
      const approved = excl.filter((x) => x.cycle_id === c.cycle_id && x.status === "APPROVED");
      const out_ = new Set(approved.map((x) => x.employee_id));
      out.set(c.outlet_id, {
        snapshot: snapped,
        eligible: base.filter((e) => !out_.has(e.employee_id)).map((e) => ({ employee_id: e.employee_id, name: e.name, designation_id: e.designation_id })),
        excluded: approved.map((x) => ({ employee_id: x.employee_id, name: x.employee_name, reason: x.reason, decided_by: x.decided_by_name })),
      });
    }
    return out;
  }

  async _cycleFor(period, outletId) {
    const code = await this.currentPeriod(period);
    const c = (await this.repo.cycles(code)).find((x) => x.outlet_id === Number(outletId));
    if (!c) throw codeError(404, "No cycle for this store in the audit period");
    return c;
  }

  /** Headcount screen: per store - snapshot state, eligible list, exclusions with history. */
  async eligibility({ period, outlets }) {
    const code = await this.currentPeriod(period);
    if (!code) return { period_code: null, stores: [] };
    const settings = await this.settings();
    const cycles = this._scope((await this.repo.cycles(code)).filter((c) => this.policy.programme.outletIds.includes(c.outlet_id)), outlets);
    const [hc, snaps, excl, stores] = await Promise.all([this.headcount(cycles, settings), this.repo.snapshots(cycles.map((c) => c.cycle_id)), this.repo.exclusions(cycles.map((c) => c.cycle_id)), this.programmeStores()]);
    const p = await this.period(code);
    return {
      period_code: code,
      eligible_designation_ids: settings.eligible_designation_ids,
      stores: cycles.map((c) => {
        const h = hc.get(c.outlet_id);
        const st = p ? p.stores.find((x) => x.outlet_id === c.outlet_id) : null;
        return {
          outlet_id: c.outlet_id,
          name: (stores.find((x) => x.outlet_id === c.outlet_id) || {}).name,
          cycle_id: c.cycle_id,
          snapshot: snaps.find((x) => x.cycle_id === c.cycle_id) || null,
          eligible: h.eligible,
          participation: st ? st.participation : null,
          participation_detail: st ? st.participation_detail : null,
          exclusions: excl.filter((x) => x.cycle_id === c.cycle_id),
        };
      }),
    };
  }

  async takeSnapshot({ period, outletId, by }) {
    const c = await this._cycleFor(period, outletId);
    const settings = await this.settings();
    const staff = await this.repo.activeStaff([c.outlet_id], settings.eligible_designation_ids);
    const n = await this.repo.takeSnapshot(c.cycle_id, staff, settings.eligible_designation_ids, by);
    this.invalidate();
    return { cycle_id: c.cycle_id, employees: n };
  }

  /** A new joiner (or a transfer in) added to a frozen snapshot: explicit, recorded. */
  async addToSnapshot({ period, outletId, employeeId, note, by }) {
    if (!note || String(note).trim().length < 3) throw codeError(400, "A note is required");
    const c = await this._cycleFor(period, outletId);
    const e = await this.repo.employee(employeeId);
    const settings = await this.settings();
    if (!e || !e.active) throw codeError(400, "Employee not found or not active");
    if (e.outlet_id !== c.outlet_id) throw codeError(400, "The employee is not assigned to this store");
    if (!settings.eligible_designation_ids.includes(e.designation_id)) throw codeError(400, "The employee's designation is not an eligible counting designation");
    try {
      await this.repo.addToSnapshot(c.cycle_id, e, by, String(note).slice(0, 255));
    } catch (err) {
      if (err && err.code === "ER_DUP_ENTRY") throw codeError(409, "Already in the snapshot");
      throw err;
    }
    this.invalidate();
    return { cycle_id: c.cycle_id, employee_id: e.employee_id };
  }

  async requestExclusion({ period, outletId, employeeId, reason, by }) {
    if (!reason || String(reason).trim().length < 5) throw codeError(400, "A reason is required (at least 5 characters)");
    const c = await this._cycleFor(period, outletId);
    const settings = await this.settings();
    const hc = (await this.headcount([c], settings)).get(c.outlet_id);
    if (!hc.eligible.some((e) => e.employee_id === Number(employeeId))) throw codeError(400, "Only an employee in this store's eligible headcount can be excluded");
    try {
      const id = await this.repo.requestExclusion(c.cycle_id, Number(employeeId), String(reason).trim().slice(0, 500), by);
      return { id, status: "REQUESTED" };
    } catch (err) {
      if (err && err.code === "ER_DUP_ENTRY") throw codeError(409, "This employee already has an open or approved exclusion for the cycle");
      throw err;
    }
  }

  /** Approve / reject: never by the requester, never by the employee concerned. */
  async decideExclusion({ id, approve, note, by }) {
    const x = await this.repo.exclusion(id);
    if (!x) throw codeError(404, "Exclusion request not found");
    if (Number(by) === x.requested_by) throw codeError(403, "The person who requested an exclusion cannot decide it");
    if (Number(by) === x.employee_id) throw codeError(403, "Nobody decides their own exclusion");
    const n = await this.repo.decideExclusion(id, approve ? "APPROVED" : "REJECTED", by, note);
    if (!n) throw codeError(409, "This request is already decided");
    this.invalidate();
    return { id, status: approve ? "APPROVED" : "REJECTED" };
  }

  async withdrawExclusion({ id, by }) {
    const x = await this.repo.exclusion(id);
    if (!x) throw codeError(404, "Exclusion request not found");
    if (Number(by) !== x.requested_by) throw codeError(403, "Only the requester can withdraw a request");
    const n = await this.repo.decideExclusion(id, "WITHDRAWN", by, "withdrawn");
    if (!n) throw codeError(409, "Only an open request can be withdrawn");
    return { id, status: "WITHDRAWN" };
  }

  /** Who qualifies for each role (designation id + store + active) and who is assigned. */
  async roles({ period, outlets }) {
    const code = await this.currentPeriod(period);
    if (!code) return { period_code: null, stores: [], operations_manager: null };
    const settings = await this.settings();
    const ids = settings.role_designation_ids;
    const cycles = this._scope((await this.repo.cycles(code)).filter((c) => this.policy.programme.outletIds.includes(c.outlet_id)), outlets);
    const [storeStaff, omCandidates, active, history, stores] = await Promise.all([
      this.repo.activeStaff(cycles.map((c) => c.outlet_id), [...new Set([...ids.SUPERVISOR, ...ids.STORE_MANAGER])]),
      this.repo.activeByDesignation(ids.OPERATIONS_MANAGER),
      this.repo.roleAssignments(code),
      this.repo.roleAssignments(code, { history: true }),
      this.programmeStores(),
    ]);
    const slot = (outletId, role) => {
      const candidates = role === "OPERATIONS_MANAGER" ? omCandidates : storeStaff.filter((e) => e.outlet_id === outletId && ids[role].includes(e.designation_id));
      const a = active.find((x) => x.outlet_id === outletId && x.role === role) || null;
      return {
        role,
        candidates,
        assigned: a,
        // one qualifying person -> suggested; several -> HR / management must choose; none -> nobody qualifies
        state: a ? "ASSIGNED" : candidates.length === 1 ? "ONE_CANDIDATE" : candidates.length > 1 ? "CHOOSE" : "NO_CANDIDATE",
        history: history.filter((x) => x.outlet_id === outletId && x.role === role),
      };
    };
    return {
      period_code: code,
      role_designation_ids: ids,
      stores: cycles.map((c) => ({ outlet_id: c.outlet_id, name: (stores.find((x) => x.outlet_id === c.outlet_id) || {}).name, cycle_id: c.cycle_id, supervisor: slot(c.outlet_id, "SUPERVISOR"), store_manager: slot(c.outlet_id, "STORE_MANAGER") })),
      operations_manager: outlets ? null : slot(0, "OPERATIONS_MANAGER"),
    };
  }

  async assignRole({ period, outletId, role, employeeId, reason, by }) {
    if (!ROLES.includes(role)) throw codeError(400, `role: ${ROLES.join(", ")}`);
    if (Number(employeeId) === Number(by)) throw codeError(403, "Nobody assigns themself as a responsible person");
    const code = await this.currentPeriod(period);
    const settings = await this.settings();
    const e = await this.repo.employee(employeeId);
    if (!e || !e.active) throw codeError(400, "Employee not found or not active");
    if (!settings.role_designation_ids[role].includes(e.designation_id)) throw codeError(400, "The employee's designation does not qualify for this role");
    let cycle = null;
    let outlet = 0;
    if (role !== "OPERATIONS_MANAGER") {
      cycle = await this._cycleFor(code, outletId);
      outlet = cycle.outlet_id;
      if (e.outlet_id !== outlet) throw codeError(400, "The employee is not assigned to this store (Branch Master)");
    }
    try {
      const id = await this.repo.assignRole({ period_code: code, cycle_id: cycle ? cycle.cycle_id : null, outlet_id: outlet, role, employee_id: e.employee_id, designation_id: e.designation_id, reason: reason ? String(reason).slice(0, 500) : null, by });
      this.invalidate();
      return { id, period_code: code, role, outlet_id: outlet, employee_id: e.employee_id };
    } catch (err) {
      if (err && err.code === "ER_DUP_ENTRY") throw codeError(409, "This person already holds a management role in this audit period: one management incentive per person");
      throw err;
    }
  }

  _scope(list, outlets, key = "outlet_id") {
    return outlets ? list.filter((x) => outlets.includes(x[key])) : list;
  }

  // ---------------------------------------------------------------- screens
  async meta({ outlets }) {
    const [stores, periods, last] = await Promise.all([this.repo.rpOutlets(), this.repo.periods(), this.repo.lastSuccess()]);
    const programme = stores.filter((s) => this.policy.programme.outletIds.includes(s.outlet_id));
    const cycles = await this.repo.cycles();
    return {
      source: "LIVE",
      today: this.today(),
      last_sync: last ? last.finished_at : null,
      periods,
      cycles: periods.map((p) => ({ ...p, cycle_id: p.period_code, stores: cycles.filter((c) => c.period_code === p.period_code).map((c) => c.outlet_id) })),
      stores: this._scope(programme, outlets).map((s) => ({ ...s, short: s.name })),
      warehouse: stores.find((s) => this.policy.programme.excludedOutletIds.includes(s.outlet_id)) || null,
      approvals_enabled: false,
      payroll_enabled: false,
    };
  }

  async stores({ period, outlets }) {
    const p = await this.period(period);
    if (!p) return [];
    return this._scope(p.stores, outlets).map((s) => ({ ...s, source: "LIVE" }));
  }

  async store({ period, outletId, outlets }) {
    if (outlets && !outlets.includes(outletId)) throw codeError(403, "This store is outside your branch scope");
    const p = await this.period(period);
    const s = p ? p.stores.find((x) => x.outlet_id === outletId) : null;
    return s ? { ...s, source: "LIVE" } : null;
  }

  async employees({ period, outlets, search = "", page: pg = 1, size = 20, sort = "audited" }) {
    const p = await this.period(period);
    let list = p ? this._scope(p.employees, outlets) : [];
    const needle = String(search || "").trim().toLowerCase();
    if (needle) list = list.filter((e) => `${e.name || ""} ${e.rp_name || ""} ${e.code || ""} ${e.rp_user_id}`.toLowerCase().includes(needle));
    const by = ["audited", "today", "recount_done", "allotted"].includes(sort) ? sort : "audited";
    list = [...list].sort((a, b) => (sort === "name" ? String(a.name || a.rp_name).localeCompare(String(b.name || b.rp_name)) : (b[by] || 0) - (a[by] || 0)));
    return { ...page(list, pg, size), source: "LIVE" };
  }

  /** One employee. `self` = the caller's own RetailPilot ids only. */
  async employee({ period, rpUserId, outlets, selfRpIds = null }) {
    if (selfRpIds && !selfRpIds.includes(rpUserId)) throw codeError(403, "You can only see your own figures");
    const p = await this.period(period);
    const e = p ? p.employees.find((x) => x.rp_user_id === rpUserId && (selfRpIds || !outlets || outlets.includes(x.outlet_id))) : null;
    return e ? { ...e, source: "LIVE" } : null;
  }

  /** The signed-in employee's own RetailPilot ids (from the shared mapping). */
  async ownRpIds(employeeId) {
    const people = await this.repo.people();
    return [...people].filter(([, v]) => v.employee_id === Number(employeeId)).map(([k]) => k);
  }

  async articles({ period, rpUserId, outlets, selfRpIds = null, page: pg = 1, size = 20 }) {
    const e = await this.employee({ period, rpUserId, outlets, selfRpIds });
    if (!e) return { rows: [], total: 0, page: 1, pages: 1, size };
    const p = await this.period(period);
    const elig = p.eligibility.filter((r) => r.outlet_id === e.outlet_id && r.rp_user_id === rpUserId && r.original_session);
    const allot = (await this.repo.allotmentRows(e.cycle_id ? [e.cycle_id] : [])).filter((a) => a.rp_user_id === rpUserId && a.effective === "Y");
    const byArticle = new Map(elig.map((r) => [Number(r.article_id), r]));
    const ids = [...new Set([...allot.map((a) => a.article_id), ...byArticle.keys()])].sort((a, b) => a - b);
    const sessionBySlug = new Map(p.sessions.map((s) => [s.rp_slug, s]));
    const verBySession = new Map();
    for (const v of await this.repo.verifications(e.cycle_id ? [e.cycle_id] : [])) verBySession.set(v.original_session_slug, v);
    const pageOut = page(ids, pg, size);
    const slugs = pageOut.rows.map((a) => byArticle.get(a)).filter(Boolean).map((r) => r.original_session);
    const [counted, names] = await Promise.all([this.repo.countedBySession(slugs), this.repo.articleNames(pageOut.rows)]);
    const allotted = new Set(allot.map((a) => a.article_id));
    return {
      ...pageOut,
      rows: pageOut.rows.map((article) => {
        const r = byArticle.get(article);
        const s = r ? sessionBySlug.get(r.original_session) : null;
        const c = s ? counted.get(s.rp_slug) : null;
        const v = s ? verBySession.get(s.rp_slug) : null;
        const q = s && s.var_qty != null ? s.var_qty : null;
        return {
          article_id: article,
          article_name: names.get(article) || null,
          category: null,
          allotted: allotted.has(article),
          status: s ? "AUDITED" : "PENDING",
          eligibility: r ? r.status : null,
          eligibility_reasons: r ? r.reasons : [],
          audited_at: s ? s.finalized_at : null,
          counted_qty: c ? c.counted : null,
          book_qty_hidden: true,
          variance_kind: q == null ? null : q < 0 ? "Short" : q > 0 ? "Over" : "No variance",
          recount: v ? { verdict: v.verdict, by: v.recount_user, at: v.recount_at, net_movement: v.net_movement_qty == null ? null : Number(v.net_movement_qty) } : null,
          session: s ? s.rp_slug : null,
        };
      }),
    };
  }

  async verifications({ period, outlets, page: pg = 1, size = 20 }) {
    const p = await this.period(period);
    if (!p) return { ...page([], pg, size), status: S.pending(S.REASON.RECOUNT_DATA_PENDING) };
    const rows = await this.repo.verifications(p.cycles.map((c) => c.cycle_id));
    const storeName = new Map(p.stores.map((s) => [s.outlet_id, s.name]));
    const nameOf = new Map(p.employees.map((e) => [e.rp_user_id, e.name || e.rp_name]));
    const list = this._scope(rows, outlets).map((v) => ({
      store: storeName.get(v.outlet_id), outlet_id: v.outlet_id, employee: nameOf.get(v.original_user) || v.original_user,
      original_user: v.original_user, recount_user: v.recount_user, article: String(v.article_id),
      original_qty: v.original_qty == null ? null : Number(v.original_qty), movement_qty: v.net_movement_qty == null ? null : Number(v.net_movement_qty),
      expected_qty: v.expected_qty == null ? null : Number(v.expected_qty), recount_qty: v.recount_qty == null ? null : Number(v.recount_qty),
      verdict: v.verdict === "NOT_INDEPENDENT" ? "UNRESOLVED" : v.verdict, reason: v.verdict_reason, kind: "RANDOM",
      original_at: v.original_at, recount_at: v.recount_at,
    }));
    // No recount has been performed in RetailPilot yet: say so, never show an empty list as "all correct".
    return { ...page(list, pg, size), status: list.length ? S.available(list.length) : S.pending(S.REASON.RECOUNT_DATA_PENDING) };
  }

  async variances({ period, outlets, kind = null, page: pg = 1, size = 20 }) {
    const p = await this.period(period);
    if (!p) return page([], pg, size);
    const storeName = new Map(p.stores.map((s) => [s.outlet_id, s.name]));
    const counters = new Map(p.employees.map((e) => [e.rp_user_id, e.name || e.rp_name]));
    const originals = new Set(p.eligibility.map((r) => r.original_session).filter(Boolean));
    const list = this._scope(p.sessions, outlets)
      .filter((s) => originals.has(s.rp_slug) && s.var_qty != null && Number(s.var_qty) !== 0)
      .map((s) => ({
        store: storeName.get(s.outlet_id), outlet_id: s.outlet_id, article: String(s.article_id), category: null,
        kind: s.var_qty < 0 ? "Short" : "Over", qty: s.var_qty, value: s.var_value == null ? null : s.var_value,
        counted_by: counters.get(s.finalized_by || s.initiated_by) || s.finalized_by || s.initiated_by, audited_at: s.finalized_at,
      }))
      .filter((v) => !kind || v.kind === kind)
      .sort((a, b) => String(b.audited_at).localeCompare(String(a.audited_at)));
    return page(list, pg, size);
  }

  async management({ period, outlets }) {
    const p = await this.period(period);
    if (!p) return [];
    return this._scope(p.management.map((m) => ({ ...m, outlet_id: m.store.outlet_id })), outlets);
  }

  async operationsManager({ period }) {
    const p = await this.period(period);
    return p ? p.operationsManager : null;
  }

  async approvals({ period, outlets }) {
    const p = await this.period(period);
    if (!p) return [];
    const items = [];
    for (const e of this._scope(p.employees, outlets)) {
      if (e.employee_id == null) continue;
      items.push({ id: `E-${e.outlet_id}-${e.rp_user_id}`, type: "Employee incentive", recipient: e.name, recipient_employee_id: e.employee_id, store: e.store, amount: e.estimated, stage: "Approval not enabled", next: "—" });
    }
    for (const m of this._scope(p.management.map((x) => ({ ...x, outlet_id: x.store.outlet_id })), outlets)) {
      items.push({ id: `S-${m.outlet_id}`, type: "Supervisor incentive", recipient: m.supervisor.name, recipient_employee_id: m.supervisor.employee_id, store: m.store.name, amount: m.supervisor.amount, stage: "Approval not enabled", next: "—" });
      items.push({ id: `M-${m.outlet_id}`, type: "Store Manager incentive", recipient: m.storeManager.name, recipient_employee_id: m.storeManager.employee_id, store: m.store.name, amount: m.storeManager.amount, stage: "Approval not enabled", next: "—" });
    }
    return items;
  }

  // ---------------------------------------------------------------- Premier League
  async _season(period) {
    const p = await this.period(period);
    if (!p) return { p: null, season: null };
    const season = (await this.repo.seasons()).find((s) => s.period_code === p.period_code) || null;
    return { p, season };
  }

  async standings({ period }) {
    const { p, season } = await this._season(period);
    if (!p) return [];
    const rules = season ? season.rules : L.defaultRules(this.policy);
    const today = this.today();
    const previous = season ? await this.repo.previousRanks(season.season_id, today) : new Map();
    const final = Boolean(season && ["VERIFIED", "FINAL", "CLOSED"].includes(season.status));
    const rows = L.standings(p.saplKpis, rules, { final, previous });
    const storeById = new Map(p.stores.map((s) => [s.outlet_id, s]));
    return rows.map((r) => ({ ...r, store: { ...storeById.get(r.outlet_id), source: "LIVE" } }));
  }

  /** Store today's provisional standing (idempotent per day). Final ones only after verification. */
  async snapshotStandings({ period }) {
    const { season } = await this._season(period);
    if (!season) throw codeError(404, "No Premier League season for this audit period");
    const rows = await this.standings({ period });
    const final = ["VERIFIED", "FINAL", "CLOSED"].includes(season.status);
    await this.repo.saveStandings(season.season_id, this.today(), rows, final);
    return { saved: rows.length, date: this.today(), final };
  }

  async seasons() {
    const list = await this.repo.seasons();
    const cycles = await this.repo.cycles();
    return list.map((s, i) => ({
      season_id: s.season_id,
      season_no: list.length - i,
      name: s.name,
      period_code: s.period_code,
      start: s.start_date,
      deadline: s.deadline,
      end: null,
      cycles: [s.period_code],
      stores: cycles.filter((c) => c.period_code === s.period_code).map((c) => c.outlet_id),
      prize: s.prize_amount,
      scoring: `${CONFIRMED.sapl.weights.completion} / ${CONFIRMED.sapl.weights.accuracy} / ${CONFIRMED.sapl.weights.recount} / ${CONFIRMED.sapl.weights.participation} (confirmed 27 Nov 2026)`,
      qualification: s.rules && s.rules.qualification && s.rules.qualification.confirmed ? "Confirmed" : "Pending management decision",
      rules: s.rules,
      status: s.status,
      winner: s.winner_outlet_id,
      approval: "NOT_ENABLED",
      distribution: "DRAFT_ONLY",
    }));
  }

  async createSeason({ name, period_code, deadline, prize_amount, by }) {
    const cycles = await this.repo.cycles(period_code);
    if (!cycles.length) throw codeError(400, "Create the audit period first: a season is one audit period");
    if (deadline != null && !DATE_RE.test(deadline)) throw codeError(400, "deadline must be YYYY-MM-DD");
    const start = cycles.map((c) => c.start_date).sort()[0];
    const rules = L.defaultRules(this.policy);
    if (prize_amount != null) rules.prize.amount = Number(prize_amount);
    const v = L.validateRules(rules, this.policy);
    if (!v.ok) throw codeError(400, v.errors.join("; "));
    try {
      const id = await this.repo.createSeason({ name: name || `SAPL ${period_code}`, period_code, start_date: start, deadline: deadline || cycles[0].deadline, prize_amount: rules.prize.amount, rules, created_by: by });
      return { season_id: id };
    } catch (err) {
      if (err && err.code === "ER_DUP_ENTRY") throw codeError(409, "This audit period already has a season");
      throw err;
    }
  }

  /** Configurable rules (qualification, tie-breakers, prize method), the common deadline and prize. Weights stay locked. */
  async updateSeason(seasonId, { deadline, rules, name }) {
    const s = await this.repo.season(seasonId);
    if (!s) throw codeError(404, "Season not found");
    if (["FINAL", "CLOSED"].includes(s.status)) throw codeError(409, "A final season cannot change");
    const fields = {};
    if (name) fields.name = String(name).slice(0, 120);
    if (deadline != null) {
      if (!DATE_RE.test(deadline)) throw codeError(400, "deadline must be YYYY-MM-DD");
      fields.deadline = deadline;
    }
    if (rules) {
      const next = { ...s.rules, ...rules, weights: s.rules.weights };
      const v = L.validateRules(next, this.policy);
      if (!v.ok) throw codeError(400, v.errors.join("; "));
      fields.rules_json = JSON.stringify(next);
      fields.prize_amount = Number(next.prize.amount);
    }
    await this.repo.updateSeason(seasonId, fields);
    this.invalidate();
    return this.repo.season(seasonId);
  }

  /**
   * Independent verification of the season's results, then finalisation by
   * someone else. The same person can never do both.
   */
  async verifySeason(seasonId, by) {
    const s = await this.repo.season(seasonId);
    if (!s) throw codeError(404, "Season not found");
    if (!["OPEN", "AWAITING_VERIFICATION"].includes(s.status)) throw codeError(409, `Season is ${s.status}`);
    if (this.today() <= s.deadline) throw codeError(409, "The common deadline has not passed yet");
    const rows = await this.standings({ period: s.period_code });
    if (rows.some((r) => !r.complete)) throw codeError(409, "Some KPIs are still pending: results cannot be verified");
    await this.repo.updateSeason(seasonId, { status: "VERIFIED", verified_by: by, verified_at: new Date() });
    return { status: "VERIFIED" };
  }

  async finalizeSeason(seasonId, by) {
    const s = await this.repo.season(seasonId);
    if (!s) throw codeError(404, "Season not found");
    if (s.status !== "VERIFIED") throw codeError(409, "Independent verification comes first");
    if (Number(s.verified_by) === Number(by)) throw codeError(403, "The verifier cannot also finalise the season");
    const rows = await this.standings({ period: s.period_code });
    const w = L.winnerOf(rows);
    if (!w.winner) throw codeError(409, `No winner can be decided (${w.reason})`);
    await this.repo.saveStandings(s.season_id, this.today(), rows, true);
    await this.repo.updateSeason(seasonId, { status: "FINAL", finalized_by: by, finalized_at: new Date(), winner_outlet_id: w.winner });
    return { status: "FINAL", winner_outlet_id: w.winner };
  }

  /** Draft prize shares for the winning store, by the season's configured method. Never posted to payroll. */
  async draftPrize(seasonId, by) {
    const s = await this.repo.season(seasonId);
    if (!s) throw codeError(404, "Season not found");
    if (s.status !== "FINAL" || !s.winner_outlet_id) throw codeError(409, "Only a final season with a winner has a prize to share");
    const p = await this.period(s.period_code);
    const team = p.employees.filter((e) => e.outlet_id === s.winner_outlet_id).map((e) => ({ employee_id: e.employee_id, articles_audited: e.audited }));
    const r = L.prizeShares(team, { ...s.rules.prize, amount: s.prize_amount });
    await this.repo.savePrizeShares(s.season_id, s.winner_outlet_id, r.method, r.shares, by);
    return { ...r, status: "DRAFT", payroll: "NOT_ENABLED" };
  }

  async prizeShares(seasonId) {
    return this.repo.prizeShares(seasonId);
  }

  // ---------------------------------------------------------------- allotment import
  async _validationContext(periodCode) {
    const cycles = (await this.repo.cycles(periodCode)).filter((c) => this.policy.programme.outletIds.includes(c.outlet_id));
    if (!cycles.length) throw codeError(400, "This audit period has no store cycles");
    const outlets = await this.repo.rpOutlets();
    const byRp = new Map(outlets.map((o) => [o.rp_id, o]));
    const cycleByOutlet = new Map(cycles.map((c) => [c.outlet_id, c]));
    const people = await this.repo.people();
    const current = new Map();
    const shaOf = new Map();
    for (const f of await this.repo.currentAllotment(cycles.map((c) => c.cycle_id))) {
      const k = `${f.rp_store_id}|${f.rp_user_id}`;
      current.set(k, { revision: f.revision, fp: f.content_sha1, articles: new Map(f.articles.map((a) => [String(a), true])) });
      shaOf.set(k, f.content_sha1);
    }
    const from = istMidnightUtc(cycles.map((c) => c.start_date).sort()[0]);
    const to = istMidnightUtc(addDays(cycles.map((c) => c.end_date).sort().pop(), 1));
    const audits = (await this.repo.sessions(cycles.map((c) => c.outlet_id), from, to))
      .filter((s) => s.status === "FINALIZED")
      .map((s) => ({ rp_store_id: s.rp_store_id, rp_user_id: s.finalized_by || s.initiated_by, article_id: String(s.article_id) }));
    return {
      cycles,
      cycleByOutlet,
      shaOf,
      ctx: {
        cycleStores: new Set(cycles.map((c) => (outlets.find((o) => o.outlet_id === c.outlet_id) || {}).rp_id).filter(Boolean)),
        storeOf: (rp) => (byRp.has(rp) ? { outlet_id: byRp.get(rp).outlet_id, name: byRp.get(rp).name } : null),
        employeeOf: (rp) => (people.has(rp) ? { employee_id: people.get(rp).employee_id, name: people.get(rp).name } : null),
        current,
        audits,
      },
    };
  }

  /**
   * Steps 2-3: upload every auditor's CSV, validate, stage. Nothing reaches
   * the allotment until confirm().
   * @param files [{ name, text }]
   */
  async validateUpload({ period_code, files, by }) {
    if (!PERIOD_RE.test(String(period_code || ""))) throw codeError(400, "Select the audit cycle first");
    if (!Array.isArray(files) || !files.length) throw codeError(400, "No files");
    if (files.length > MAX_FILES) throw codeError(400, `At most ${MAX_FILES} files per upload`);
    for (const f of files) {
      if (typeof f.text !== "string" || typeof f.name !== "string") throw codeError(400, "Each file needs a name and its text");
      if (Buffer.byteLength(f.text, "utf8") > MAX_FILE_BYTES) throw codeError(400, `${f.name} is larger than 5 MB`);
    }
    const { ctx, cycleByOutlet, shaOf } = await this._validationContext(period_code);
    const read = files.map((f) => A.readAuditorFile(f.name, f.text));
    const v = A.validateBatch(read, ctx);
    const staged = v.files.map((f) => {
      const outletId = f.outlet ? f.outlet.outlet_id : null;
      const cycle = outletId != null ? cycleByOutlet.get(outletId) : null;
      return {
        ...f,
        outlet_id: outletId,
        cycle_id: cycle ? cycle.cycle_id : null,
        employee_id: f.employee ? f.employee.employee_id : null,
        current_sha: shaOf.get(`${f.store_id}|${f.auditor_id}`) || null,
        warnings: f.warnings || [],
      };
    });
    // the sha each file's auditor had when validated: confirm() refuses if it changed
    for (const f of staged) f.issues = [...(f.issues || [])];
    const batchId = await this.repo.stageBatch({
      period_code,
      created_by: by,
      summary: { ...v.summary, canConfirm: v.canConfirm, conflicts: v.conflicts.slice(0, 200), expected: Object.fromEntries(staged.map((f, i) => [i, f.current_sha])) },
      files: staged,
    });
    await this.repo.upsertRpUsers(staged.filter((f) => f.auditor_id).map((f) => ({ rp_user_id: f.auditor_id, rp_name: f.auditor_name, rp_store_id: f.store_id })));
    return {
      batch_id: batchId,
      period_code,
      summary: v.summary,
      canConfirm: v.canConfirm,
      conflicts: v.conflicts,
      unmapped: [...new Map(staged.filter((f) => f.status !== "REJECTED" && !f.employee_id && f.auditor_id).map((f) => [f.auditor_id, { rp_user_id: f.auditor_id, rp_name: f.auditor_name, store: f.outlet ? f.outlet.name : f.store_id }])).values()],
      files: staged.map((f) => ({
        name: f.name, status: f.status, store_id: f.store_id, store: f.outlet ? f.outlet.name : null, auditor_id: f.auditor_id, auditor_name: f.auditor_name,
        employee_id: f.employee_id, rows: f.rows, auditable: f.auditable, not_auditable: f.not_auditable, line_errors: f.line_errors, conflicts: f.conflicts || 0,
        revision: f.revision || null, diff: f.diff || null, match: f.match || null, issues: f.issues, warnings: f.warnings,
        errors: f.lines.filter((l) => l.errors.length).slice(0, 50).map((l) => ({ line: l.line, article_id: l.article_id, errors: l.errors })),
      })),
    };
  }

  /** Step 4. One transaction; conflicts caught by the database too. */
  async confirmUpload(batchId, by) {
    const b = await this.repo.batch(batchId);
    if (!b) throw codeError(404, "Upload not found");
    if (b.summary && b.summary.canConfirm === false) throw codeError(409, "This upload has conflicts: correct the files in RetailPilot and upload again");
    const expected = new Map(b.files.map((f, i) => [Number(f.file_id), b.summary && b.summary.expected ? b.summary.expected[i] ?? null : null]));
    // Two confirms racing on the same articles can deadlock in InnoDB: the
    // loser is rolled back whole and tried again, and then meets the unique
    // key (or the changed allotment) and is refused cleanly.
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await this.repo.confirmBatch(batchId, by, expected);
        this.invalidate();
        return { batch_id: batchId, status: "CONFIRMED", applied: r.applied };
      } catch (err) {
        if (err && err.code === "ER_DUP_ENTRY") throw codeError(409, "An auditable article is allotted to two auditors in one store - nothing was imported");
        if (err && (err.code === "ER_LOCK_DEADLOCK" || err.code === "ER_LOCK_WAIT_TIMEOUT") && attempt < 3) continue;
        throw err;
      }
    }
  }

  async discardUpload(batchId) {
    const ok = await this.repo.discardBatch(batchId);
    if (!ok) throw codeError(409, "Only a validated, unconfirmed upload can be discarded");
    return { batch_id: batchId, status: "DISCARDED" };
  }

  async upload(batchId) {
    const b = await this.repo.batch(batchId);
    if (!b) throw codeError(404, "Upload not found");
    return b;
  }

  async uploads() {
    const rows = await this.repo.batches();
    return rows.map((r) => {
      const s = r.summary || {};
      return {
        upload_id: Number(r.batch_id), cycle: r.period_code, file: `${r.file_count} file${r.file_count === 1 ? "" : "s"} · bulk upload`, stores: r.stores || "—",
        files: r.file_count, imported: s.importable || 0, revisions: s.revisions || 0, already: s.already_imported || 0, rejected: s.rejected || 0,
        auditable: s.auditable || 0, not_auditable: s.not_auditable || 0, status: r.status === "CONFIRMED" ? "Imported" : r.status === "DISCARDED" ? "Discarded" : "Validated, not confirmed",
        at: r.confirmed_at || r.created_at, by: r.created_by_name || "—",
      };
    });
  }

  // ---------------------------------------------------------------- mapping
  async mapping({ outlets }) {
    const [users, stores] = await Promise.all([this.repo.rpUsers(), this.repo.rpOutlets()]);
    const storeByRp = new Map(stores.map((s) => [s.rp_id, s]));
    const list = users.map((u) => ({
      rp_user_id: u.rp_user_id, rp_name: u.rp_name, rp_store_id: u.last_rp_store_id,
      store: storeByRp.has(u.last_rp_store_id) ? storeByRp.get(u.last_rp_store_id).name : u.last_rp_store_id,
      outlet_id: storeByRp.has(u.last_rp_store_id) ? storeByRp.get(u.last_rp_store_id).outlet_id : null,
      employee_id: u.employee_id == null ? null : Number(u.employee_id), employee_name: u.employee_name, designation: u.designation,
      mapped: u.employee_id != null, mapped_at: u.mapped_at, mapped_by: u.mapped_by_name,
    }));
    return outlets ? list.filter((u) => u.outlet_id == null || outlets.includes(u.outlet_id)) : list;
  }

  async employeeChoices({ outlets }) {
    const ids = outlets || this.policy.programme.outletIds;
    return this.repo.employeeChoices(ids);
  }

  async setMapping({ rp_user_id, employee_id, note, by }) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(String(rp_user_id || ""))) throw codeError(400, "Not a RetailPilot user id");
    if (employee_id != null) {
      if (Number(employee_id) === Number(by)) throw codeError(403, "You cannot map a RetailPilot user to yourself");
      if (!(await this.repo.employeeExists(employee_id))) throw codeError(400, "Employee not found or not active");
    }
    await this.repo.setStaffMap({ rp_user_id, employee_id: employee_id == null ? null : Number(employee_id), note, updated_by: by });
    this.invalidate();
    return { rp_user_id, employee_id };
  }

  // ---------------------------------------------------------------- cycles
  async createPeriod({ period_code, name, start_date, end_date, deadline, outlet_ids, by }) {
    if (!PERIOD_RE.test(String(period_code || ""))) throw codeError(400, "period_code: 2-16 letters, digits, - or _");
    for (const [k, v] of Object.entries({ start_date, end_date, deadline })) if (!DATE_RE.test(String(v || ""))) throw codeError(400, `${k} must be YYYY-MM-DD`);
    if (!(start_date <= deadline && deadline <= end_date)) throw codeError(400, "start date <= deadline <= end date");
    if (start_date < istDate(this.policy.effectiveFrom)) throw codeError(400, "The programme starts 25 Nov 2026");
    const ids = (outlet_ids && outlet_ids.length ? outlet_ids : this.policy.programme.outletIds).map(Number);
    const bad = ids.filter((o) => !this.policy.programme.outletIds.includes(o));
    if (bad.length) throw codeError(400, `Not a programme store: ${bad.join(", ")} (the warehouse is excluded)`);
    try {
      await this.repo.createPeriod({ period_code, name: name || period_code, start_date, end_date, deadline, outletIds: ids, created_by: by });
    } catch (err) {
      if (err && err.code === "ER_DUP_ENTRY") throw codeError(409, "A store already has a cycle for this period or start date");
      throw err;
    }
    this.invalidate();
    return { period_code, stores: ids.length };
  }

  async updatePeriod(periodCode, { name, end_date, deadline, status }) {
    for (const [k, v] of Object.entries({ end_date, deadline })) if (v != null && !DATE_RE.test(v)) throw codeError(400, `${k} must be YYYY-MM-DD`);
    if (status != null && !["DRAFT", "OPEN", "CLOSED"].includes(status)) throw codeError(400, "status: DRAFT, OPEN or CLOSED (approval is not enabled)");
    const n = await this.repo.updatePeriod(periodCode, { name, end_date, deadline, status });
    if (!n) throw codeError(404, "Audit period not found");
    this.invalidate();
    return { period_code: periodCode, updated: n };
  }

  async cycles() {
    const [periods, cycles] = await Promise.all([this.repo.periods(), this.repo.cycles()]);
    return periods.map((p) => ({ ...p, cycles: cycles.filter((c) => c.period_code === p.period_code) }));
  }

  /** Operations Manager's independent verification of one store's cycle. Never by staff of that store. */
  async recordStoreVerification({ period, outletId, done, comment, by, byOutletId }) {
    const cycles = await this.repo.cycles(await this.currentPeriod(period));
    const c = cycles.find((x) => x.outlet_id === outletId);
    if (!c) throw codeError(404, "No cycle for this store in the period");
    if (byOutletId != null && Number(byOutletId) === Number(outletId)) throw codeError(403, "Verification must be independent of the store's own staff");
    await this.repo.recordStoreVerification(c.cycle_id, by, Boolean(done), comment);
    this.invalidate();
    return { cycle_id: c.cycle_id, independent_verification: Boolean(done) };
  }

  // ---------------------------------------------------------------- HR daily PDFs
  /**
   * Data for the two HR PDFs for one date. Team figures only: no salary and
   * no individual incentive amount leaves this method.
   */
  async hrReport({ period, date }) {
    const today = this.today();
    const d = date || today;
    if (!DATE_RE.test(d)) throw codeError(400, "date must be YYYY-MM-DD");
    if (d > today) throw codeError(400, "A report cannot be for a future date");
    const code = await this.currentPeriod(period);
    if (!code) throw codeError(404, "No audit period yet");
    const p = d === today ? await this.period(code) : await this._compute(code, { asOfDate: d });
    const strip = ({ estimated, provisional, rate, est, approved_c, payment, eligible, not_eligible, ...keep }) => keep;
    const stores = p.stores.map(({ estimated_employee, estimated_employee_pending, estimate_employee, estimate_employee_none, ...s }) => ({ ...s, employees: s.employees.map(strip), source: "LIVE" }));
    const season = (await this.repo.seasons()).find((s) => s.period_code === code) || null;
    const final = Boolean(season && ["VERIFIED", "FINAL", "CLOSED"].includes(season.status) && d === today);
    const storeById = new Map(stores.map((s) => [s.outlet_id, s]));
    const standings = L.standings(p.saplKpis, season ? season.rules : L.defaultRules(this.policy), { final }).map((r) => ({ ...r, store: storeById.get(r.outlet_id) }));
    return {
      date: d,
      cycle: p.cycles[0] ? p.cycles[0].name : code,
      period_code: code,
      generatedAt: this.now().toISOString(),
      lastSync: p.last_sync,
      historical: false,
      allotment_note: d === today ? null : "Allotment shown is the current revision",
      stores,
      standings,
      sample: false,
    };
  }

  // ---------------------------------------------------------------- sync, policy
  async syncRuns() {
    const runs = await this.repo.runs();
    const last = await this.repo.lastSuccess();
    const latest = runs[0] ? await this.repo.issues(runs[0].run_id) : [];
    return {
      runs: runs.map((r) => ({ run_id: r.run_id, kind: r.kind, trigger: r.run_trigger, status: r.status, started_at: r.started_at, finished_at: r.finished_at, counts: r.counts, issues: r.issue_count, error: r.error, resume_after: r.resume_after })),
      issues: latest.map((i) => ({ kind: i.kind, ref: i.rp_ref, detail: i.detail })),
      last_success: last ? last.finished_at : null,
      running: Boolean(this.sync && this.sync.isRunning()),
      schedule: "Not scheduled (manual only)",
    };
  }

  startSync({ kind, by }) {
    if (!this.sync) throw codeError(503, "Sync not available");
    const r = this.sync.start({ kind, trigger: "manual", startedBy: by });
    this.invalidate();
    return r;
  }

  async policyVersions() {
    const rows = await this.repo.ruleSets();
    if (rows.length) return rows;
    return [{ version: 0, status: "DRAFT", note: "Built-in default: confirmed amounts (27 Nov 2026) and proposed thresholds", created: null, by: "system" }];
  }
}

module.exports = (repo, opts) => new StockAuditUsecase(repo, opts);
module.exports.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
