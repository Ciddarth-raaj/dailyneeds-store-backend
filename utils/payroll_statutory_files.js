const epfoEcr = require("./epfo_ecr");
const statutory = require("../config/statutory");

/**
 * Payroll Reports - the two STATUTORY files, validated. Pure.
 *
 * ====================================== INDEPENDENT OF THE VISIBLE REPORT
 *
 * Neither function takes a column list. The ECR and the ESIC contribution
 * file are fixed statutory layouts built from the stored payrun rows; which
 * columns somebody chose to look at in the EPF or ESI report has no way in.
 *
 * ================================================== NOTHING SILENTLY LEFT OUT
 *
 * Every employee the month makes relevant is either READY or BLOCKED, and a
 * blocked employee carries every reason. `ready + blocked = considered`,
 * always. The file can only ever be generated from the ready set, and the
 * service refuses to do even that unless the caller has seen and accepted
 * the blocked list (see `usecase/payroll_report_service.js`).
 *
 * The EPF side wraps `utils/epfo_ecr.js#buildEcr` - the same builder the
 * payrun's own ECR uses - so the two can never disagree on a line. It adds
 * the checks a filing needs that the builder does not make: an invalid (not
 * merely missing) UAN, an unstored NCP figure (which the builder would file
 * as 0), negative wages, and the contribution arithmetic EPFO validates.
 */

const REASON = {
  NOT_CALCULATED: "No approved calculation is stored for this month",
  NOT_APPROVED: "The month is not approved & locked for this employee",
  INCOMPLETE: "The calculation is incomplete",
  PF_PENDING: "PF / EPS status is unresolved for this month",
  UAN_MISSING: "UAN is not recorded",
  UAN_INVALID: "UAN must be exactly 12 digits",
  RECALCULATION_REQUIRED: "EPS / EDLI wages were not stored; recalculate before filing",
  NCP_MISSING: "NCP days were not stored for this month",
  NCP_INVALID: "NCP days are outside the month",
  WAGES_INVALID: "A wage value is missing or negative",
  CONTRIBUTION_MISMATCH: "Contribution does not match the wages",
  ESI_PENDING: "ESI status is unresolved for this month",
  IP_MISSING: "ESI IP number is not recorded",
  IP_INVALID: "ESI IP number must be exactly 10 digits",
  DAYS_INVALID: "Number of days is outside the month",
  ZERO_REASON_MISSING: "Zero days / wages need a reason code",
  ZERO_REASON_INVALID: "Reason code is not a valid ESIC code",
  LWD_MISSING: "Last working day is required for this reason code",
  LWD_INVALID: "Last working day is not a valid date in or before this month",
};

const reason = (code, extra) => ({ code, message: extra ? `${REASON[code]}: ${extra}` : REASON[code] });

const isBlank = (v) => v === null || v === undefined || String(v).trim() === "";
const num = (v) => (isBlank(v) ? null : Number(v));

/* ================================================================= EPF ==== */

/**
 * @param {object} args
 * @param {Array}  args.rows  `{ employee, calculation, live_uan }` - the
 *                 payrun snapshot row, its stored calculation (or null) and
 *                 the employee's current UAN
 * @param {object} args.period periodOf()
 */
function validateEpf({ rows = [], period }) {
  const blocked = new Map();
  const block = (employee, r) => {
    const id = Number(employee.employee_id);
    if (!blocked.has(id)) {
      blocked.set(id, { employee_id: id, employee_name: employee.employee_name || null, reasons: [] });
    }
    blocked.get(id).reasons.push(r);
  };

  // Relevant: a PF member this month, or a PF-applicable snapshot that has
  // no calculation yet. A calculated NOT_APPLICABLE month is not a member.
  const relevant = rows.filter(({ employee, calculation }) => {
    if (calculation) return calculation.pf_status !== "NOT_APPLICABLE";
    return Number(employee.pf_applicable) === 1;
  });

  const prepared = [];
  for (const { employee, calculation, live_uan } of relevant) {
    const snap = String(employee.uan || "").trim();
    const uan = snap !== "" ? snap : String(live_uan || "").trim();
    const row = { employee: { ...employee, uan }, calculation };
    // Pre-checks the builder would miss or merge.
    if (uan !== "" && !/^\d{12}$/.test(uan)) block(employee, reason("UAN_INVALID"));
    if (calculation && calculation.pf_status === "APPLIED") {
      const ncp = num(calculation.ncp_days);
      if (ncp === null) block(employee, reason("NCP_MISSING"));
      else if (!Number.isInteger(ncp) || ncp < 0 || ncp > period.days) block(employee, reason("NCP_INVALID", String(ncp)));
      for (const key of ["total_earnings", "pf_wage", "eps_wage", "edli_wage"]) {
        const v = num(calculation[key]);
        if (v !== null && (!Number.isFinite(v) || v < 0)) {
          block(employee, reason("WAGES_INVALID", key));
          break;
        }
      }
    }
    prepared.push(row);
  }

  const ecr = epfoEcr.buildEcr({ rows: prepared, require_approved: true });
  for (const err of ecr.errors) {
    const employee = prepared.find((r) => Number(r.employee.employee_id) === Number(err.employee_id)).employee;
    // An invalid UAN is reported as invalid, not also as missing.
    if (err.code === "UAN_MISSING" && String(employee.uan || "") !== "") continue;
    block(employee, reason(err.code in REASON ? err.code : "INCOMPLETE"));
  }
  ecr.members.forEach((member) => {
    const problems = epfoEcr.validateEcrMember(member);
    if (problems.length) {
      const employee = prepared.find((r) => Number(r.employee.employee_id) === member.employee_id).employee;
      block(employee, reason("CONTRIBUTION_MISMATCH", problems.join("; ")));
    }
  });

  // `lines` and `members` are index-aligned in buildEcr.
  const ready = [];
  const lines = [];
  ecr.members.forEach((member, i) => {
    if (blocked.has(member.employee_id)) return;
    ready.push(member);
    lines.push(ecr.lines[i]);
  });

  const totals = ready.reduce(
    (t, m) => {
      t.members += 1;
      t.gross_wages += m.gross_wages;
      t.epf_wages += m.epf_wages;
      t.eps_wages += m.eps_wages;
      t.edli_wages += m.edli_wages;
      t.ee_share += m.ee_share;
      t.eps_share += m.eps_share;
      t.er_epf_share += m.er_epf_share;
      return t;
    },
    { members: 0, gross_wages: 0, epf_wages: 0, eps_wages: 0, edli_wages: 0, ee_share: 0, eps_share: 0, er_epf_share: 0 }
  );

  return {
    summary: { considered: relevant.length, ready: ready.length, blocked: blocked.size },
    ready: ready.map((m) => ({ employee_id: m.employee_id, member_name: m.member_name })),
    blocked: [...blocked.values()].sort((a, b) => a.employee_id - b.employee_id),
    lines,
    text: lines.join("\n"),
    totals,
  };
}

/* ================================================================= ESI ==== */

/**
 * ESIC monthly contribution - reason codes for zero working days, as the
 * ESIC contribution template lists them.
 */
const ESIC_REASON = {
  0: "Without Reason",
  1: "On Leave",
  2: "Left Service",
  3: "Retired",
  4: "Out of Coverage",
  5: "Expired",
  6: "Non Implemented Area",
  7: "Compliance by Immediate Employer",
  8: "Suspension of Work",
  9: "Strike / Lockout",
  10: "Retrenchment",
  11: "No Work",
  12: "Does Not Belong To This Employer",
  13: "Duplicate IP",
};
/** The template requires a Last Working Day for these codes, and only these. */
const ESIC_LWD_REQUIRED = new Set([2, 3, 4, 5, 6, 10]);

const ESIC_HEADERS = [
  "IP Number (10 Digits)",
  "IP Name( Only alphabets and space )",
  "No of Days for which wages paid/payable during the month",
  "Total Monthly Wages",
  "Reason Code for Zero workings days(numeric only; provide 0 for all other reasons- Click on the link for reference)",
  " Last Working Day( Format DD/MM/YYYY  or DD-MM-YYYY)",
];

const ipName = (name) =>
  String(name || "")
    .normalize("NFKD")
    .replace(/[^A-Za-z ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();

const isoDate = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const ddmmyyyy = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "");

/**
 * The reason code and last working day for one employee: derived from the
 * payrun snapshot where the facts are there (somebody who left), otherwise
 * from an explicit override supplied with the download. Never guessed.
 */
function esicReasonFor({ days, wages, resignation_date, override, period }) {
  const left = isoDate(resignation_date);
  const leftByMonthEnd = left && left <= period.to;
  if (override && override.reason_code !== undefined && override.reason_code !== null && override.reason_code !== "") {
    return {
      reason_code: Number(override.reason_code),
      last_working_day: isoDate(override.last_working_day) || (Number(override.reason_code) === 2 && leftByMonthEnd ? left : null),
      reason_source: "OVERRIDE",
    };
  }
  if (leftByMonthEnd && left >= period.from) return { reason_code: 2, last_working_day: left, reason_source: "PAYRUN_SNAPSHOT" };
  if ((days === 0 || wages === 0) && leftByMonthEnd) return { reason_code: 2, last_working_day: left, reason_source: "PAYRUN_SNAPSHOT" };
  if (days === 0 || wages === 0) return { reason_code: null, last_working_day: null, reason_source: null };
  return { reason_code: 0, last_working_day: null, reason_source: "DEFAULT" };
}

const within = (a, b, tolerance = 1) => Math.abs(a - b) <= tolerance;

/**
 * @param {object} args
 * @param {Array}  args.rows       `{ employee, calculation, live_ip }`
 * @param {object} args.period
 * @param {object} [args.overrides] employee_id -> { reason_code, last_working_day }
 */
function validateEsi({ rows = [], period, overrides = {} }) {
  const blocked = new Map();
  const block = (employee, r) => {
    const id = Number(employee.employee_id);
    if (!blocked.has(id)) blocked.set(id, { employee_id: id, employee_name: employee.employee_name || null, reasons: [] });
    blocked.get(id).reasons.push(r);
  };

  const relevant = rows.filter(({ employee, calculation }) => {
    if (calculation) return calculation.esi_status !== "NOT_APPLICABLE";
    return Number(employee.esi_applicable) === 1;
  });

  const records = [];
  const reasonsById = new Map();
  for (const { employee, calculation, live_ip } of relevant) {
    const id = Number(employee.employee_id);
    if (!calculation) {
      block(employee, reason("NOT_CALCULATED"));
      continue;
    }
    if (calculation.status !== "APPROVED_LOCKED") block(employee, reason("NOT_APPROVED"));
    if (Number(calculation.is_complete) !== 1) block(employee, reason("INCOMPLETE"));
    if (calculation.esi_status !== "APPLIED") block(employee, reason("ESI_PENDING"));

    const snap = String(employee.esi_number || "").trim();
    const ip = snap !== "" ? snap : String(live_ip || "").trim();
    if (ip === "") block(employee, reason("IP_MISSING"));
    else if (!/^\d{10}$/.test(ip)) block(employee, reason("IP_INVALID"));

    const days = num(calculation.salary_days);
    if (days === null || !Number.isInteger(days) || days < 0 || days > period.days) {
      block(employee, reason("DAYS_INVALID", days === null ? "blank" : String(days)));
    }
    const wages = num(calculation.esi_wage);
    if (wages === null || !Number.isFinite(wages) || wages < 0) block(employee, reason("WAGES_INVALID"));

    const derived = esicReasonFor({
      days,
      wages,
      resignation_date: employee.resignation_date,
      override: overrides[id],
      period,
    });
    reasonsById.set(id, derived);
    if (derived.reason_code === null) {
      block(employee, reason("ZERO_REASON_MISSING"));
    } else if (!(derived.reason_code in ESIC_REASON)) {
      block(employee, reason("ZERO_REASON_INVALID", String(derived.reason_code)));
    } else if (ESIC_LWD_REQUIRED.has(derived.reason_code)) {
      if (!derived.last_working_day) block(employee, reason("LWD_MISSING", ESIC_REASON[derived.reason_code]));
      else if (derived.last_working_day > period.to) block(employee, reason("LWD_INVALID"));
    }

    // The contribution arithmetic, within a rupee of rounding. An employee
    // share of 0 is allowed: the low-wage exemption charges the employer only.
    if (wages !== null && wages > 0 && calculation.esi_status === "APPLIED") {
      const ee = num(calculation.employee_esi) || 0;
      const er = num(calculation.employer_esi) || 0;
      const eeExpected = (wages * statutory.esi.employeeRatePercent) / 100;
      const erExpected = (wages * statutory.esi.employerRatePercent) / 100;
      if ((ee !== 0 && !within(ee, eeExpected)) || !within(er, erExpected)) {
        block(employee, reason("CONTRIBUTION_MISMATCH", `employee ${ee}, employer ${er} on wages ${wages}`));
      }
    }

    records.push({
      employee_id: id,
      ip_number: ip,
      ip_name: ipName(employee.employee_name),
      days: days === null ? 0 : days,
      wages: wages === null ? 0 : Math.round(wages * 100) / 100,
      reason_code: derived.reason_code,
      last_working_day: derived.last_working_day,
    });
  }

  const ready = records.filter((r) => !blocked.has(r.employee_id)).sort((a, b) => a.employee_id - b.employee_id);
  return {
    summary: { considered: relevant.length, ready: ready.length, blocked: blocked.size },
    ready: ready.map((r) => ({ employee_id: r.employee_id, ip_name: r.ip_name })),
    blocked: [...blocked.values()].sort((a, b) => a.employee_id - b.employee_id),
    reasons: reasonsById,
    // The fixed ESIC layout, ready members only.
    headers: ESIC_HEADERS,
    file_rows: ready.map((r) => [
      r.ip_number,
      r.ip_name,
      r.days,
      r.wages,
      r.reason_code,
      ESIC_LWD_REQUIRED.has(r.reason_code) ? ddmmyyyy(r.last_working_day) : "",
    ]),
    totals: ready.reduce(
      (t, r) => ({ members: t.members + 1, wages: Math.round((t.wages + r.wages) * 100) / 100 }),
      { members: 0, wages: 0 }
    ),
  };
}

/** One line for a validation status cell. */
const statusText = (validation, employeeId) => {
  const b = validation.blocked.find((x) => x.employee_id === Number(employeeId));
  if (b) return `Blocked: ${b.reasons.map((r) => r.message).join("; ")}`;
  return validation.ready.some((x) => x.employee_id === Number(employeeId)) ? "Ready" : null;
};

module.exports = {
  REASON,
  ESIC_REASON,
  ESIC_LWD_REQUIRED,
  ESIC_HEADERS,
  validateEpf,
  validateEsi,
  esicReasonFor,
  ipName,
  ddmmyyyy,
  statusText,
};
