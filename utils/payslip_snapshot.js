/**
 * THE PAYSLIP SNAPSHOT - built once, at Publish, from the STORED approved
 * calculation, and never again.
 *
 * PURE. No database, no clock, no environment, no logging. Every input is an
 * argument, which is what lets the "no recalculation" and "exact figures"
 * rules be tested without MySQL.
 *
 * ================================================ IT CALCULATES NO PAYROLL
 *
 * Every figure below is COPIED from `payrun_employee_calculation` as it was
 * approved. Nothing is priced, prorated or re-derived from attendance,
 * Salary Master, OT or adjustments. The only arithmetic is:
 *
 *   1. the presentation split of the stored Salary Earnings across the frozen
 *      structure components (Basic / HRA / Conveyance / Special Allowance) -
 *      see `balancedComponents`: each is its share in whole rupees, and ONE
 *      balancing component (Special Allowance) carries whatever paise remain,
 *      so the lines add up to the stored Salary Earnings EXACTLY;
 *   2. CHECKS - the earnings lines must add up to the stored Total Earnings,
 *      the deductions to the stored Total Deductions, and earnings minus
 *      deductions plus the stored rounding to the stored Net Pay. A snapshot
 *      that does not add up is REFUSED, never published.
 *
 * ================================================== WHAT IT NEVER CARRIES
 *
 * The full bank account number and the full PAN never enter the snapshot -
 * they are masked here, before anything is stored. Employer statutory
 * contributions are not on the employee-facing payslip.
 */
const crypto = require("crypto");
const {
  SNAPSHOT_SCHEMA_VERSION,
  TEMPLATE_VERSION,
  MONTH_SHORT,
  monthLabel,
} = require("../constants/payslip");

class SnapshotError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PayslipSnapshotError";
    this.code = code;
  }
}

/* ------------------------------------------------------------ money */

/** A stored DECIMAL (string or number) to integer paise; null stays null. */
function toPaise(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/** Integer paise to the snapshot's money format: a fixed 2-decimal string. */
function money(paise) {
  if (paise === null || paise === undefined) return null;
  const negative = paise < 0;
  const abs = Math.abs(paise);
  const text = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
  return negative && abs !== 0 ? `-${text}` : text;
}

const moneyOf = (value) => money(toPaise(value));
const paiseOr0 = (value) => toPaise(value) || 0;

/* ------------------------------------------------------- identifiers */

/** Bank account: last 4 digits only. */
function maskAccount(account) {
  if (account === null || account === undefined) return null;
  const clean = String(account).replace(/[\s-]/g, "");
  if (clean === "") return null;
  if (clean.length <= 4) return "XXXX";
  return `XXXXXX${clean.slice(-4)}`;
}

/** PAN: the last four characters only (e.g. ABCDE1234F -> XXXXXX234F). */
function maskPan(pan) {
  if (pan === null || pan === undefined) return null;
  const clean = String(pan).replace(/\s/g, "").toUpperCase();
  if (clean === "") return null;
  if (clean.length <= 4) return "XXXX";
  return `XXXXXX${clean.slice(-4)}`;
}

const textOrNull = (value) => {
  if (value === null || value === undefined) return null;
  const t = String(value).trim();
  return t === "" ? null : t;
};

const isOne = (value) => value === true || Number(value) === 1;

/* -------------------------------------------- the component split */

/**
 * Split `totalPaise` across `weights` (paise), largest remainder, so the parts
 * are whole paise and add up to the total exactly. Null when the weights
 * cannot describe a split (missing or non-positive total).
 */
function splitByWeights(totalPaise, weights) {
  if (totalPaise === null) return null;
  if (weights.some((w) => w === null || w < 0)) return null;
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return null;
  const raw = weights.map((w) => (totalPaise * w) / sum);
  const parts = raw.map((r) => Math.floor(r));
  let left = totalPaise - parts.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; left > 0 && k < order.length; k += 1, left -= 1) parts[order[k].i] += 1;
  return parts;
}

/**
 * THE SALARY COMPONENTS, AS AN EMPLOYEE READS THEM.
 *
 * The approved calculation stores ONE figure - Salary Earnings - and the
 * month's structure says how it divides (Basic / HRA / Conveyance / Special
 * Allowance). An exact paise-proportional split is correct but prints figures
 * like HRA 4,999.98 for a 5,000 HRA. So:
 *
 *   1. every component except the balancing one is its proportional share of
 *      the stored Salary Earnings, ROUNDED TO WHOLE RUPEES (half up);
 *   2. the BALANCING COMPONENT - Special Allowance, or the last component with
 *      a structure value when Special Allowance is zero - is Salary Earnings
 *      minus the others, so it carries every residual paisa;
 *   3. the four therefore add up to the stored Salary Earnings EXACTLY.
 *
 * Deterministic: the same stored figures always give the same lines. Nothing
 * else moves - Total Earnings, PF, ESI and Net Pay are the stored values.
 * If balancing would make the balancing component negative (only possible
 * with a near-zero balancing component), the exact paise split is used
 * instead and the basis says so.
 */
function balancedComponents(totalPaise, weights) {
  if (totalPaise === null) return null;
  if (weights.some((w) => w === null || w < 0)) return null;
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return null;
  let balancing = weights[3] > 0 ? 3 : -1;
  if (balancing === -1) {
    for (let i = weights.length - 1; i >= 0; i -= 1) {
      if (weights[i] > 0) {
        balancing = i;
        break;
      }
    }
  }
  const parts = weights.map((w, i) =>
    i === balancing || w === 0 ? 0 : Math.round((totalPaise * w) / sum / 100) * 100
  );
  const rest = totalPaise - parts.reduce((a, b) => a + b, 0);
  if (rest < 0) {
    return { parts: splitByWeights(totalPaise, weights), basis: "SALARY_EARNINGS_EXACT_PAISE_SPLIT", balancing: null };
  }
  parts[balancing] = rest;
  return { parts, basis: "WHOLE_RUPEE_COMPONENTS_BALANCED", balancing };
}

const COMPONENTS = [
  ["basic", "Basic"],
  ["hra", "HRA"],
  ["conveyance", "Conveyance"],
  ["special_allowance", "Special Allowance"],
];

/** Last four characters of a statutory number; the rest masked. */
function maskTail(value) {
  if (value === null || value === undefined) return null;
  const clean = String(value).replace(/\s/g, "");
  if (clean === "") return null;
  if (clean.length <= 4) return "XXXX";
  return `${"X".repeat(Math.min(clean.length - 4, 8))}${clean.slice(-4)}`;
}

/* ------------------------------------------------------ the snapshot */

function parseJsonList(value) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value;
  if (Buffer.isBuffer(value)) value = value.toString("utf8");
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      return [];
    }
  }
  return [];
}

const line = (key, label, paise, optional = false) => ({ key, label, amount: money(paise), optional });

/**
 * @param {object} args
 * @param {object} args.period       { year, month }
 * @param {object} args.calculation  the stored `payrun_employee_calculation` row (APPROVED_LOCKED)
 * @param {object} args.employee     the month's `payrun_employee` snapshot row
 * @param {object} [args.extras]     { department_name, account_no, pan_no, bank_name } read at Publish
 * @param {object} args.company      { name, address, pf_establishment_code, esi_establishment_code, source }
 * @returns {object} the snapshot (plain JSON)
 */
function buildPayslipSnapshot({ period, calculation, employee, extras = {}, company = {} }) {
  const c = calculation;
  if (!period || !monthLabel(period.year, period.month)) {
    throw new SnapshotError("SNAPSHOT_INPUT_MISSING", "No payroll month to publish");
  }
  if (!c || !employee) throw new SnapshotError("SNAPSHOT_INPUT_MISSING", "No stored calculation to publish");
  if (!textOrNull(company && company.name)) {
    throw new SnapshotError("SNAPSHOT_COMPANY_MISSING", "No company details are configured for payslips");
  }
  if (Number(c.employee_id) !== Number(employee.employee_id)) {
    throw new SnapshotError("SNAPSHOT_EMPLOYEE_MISMATCH", "The calculation and the employee do not match");
  }

  /* ---- earnings, from stored figures only ---- */
  const salaryEarnings = toPaise(c.salary_earnings);
  if (salaryEarnings === null) {
    throw new SnapshotError("SNAPSHOT_INCOMPLETE", "The stored calculation has no salary earnings");
  }
  const weights = [employee.basic, employee.hra, employee.conveyance, employee.special_allowance].map(toPaise);
  const split = balancedComponents(salaryEarnings, weights);
  const salaryLines = split
    ? COMPONENTS.map(([key, label], i) => line(key, label, split.parts[i]))
    : [line("salary_earnings", "Salary Earnings", salaryEarnings)];

  const extraDay = paiseOr0(c.extra_day_amount);
  const ot = paiseOr0(c.ot_amount);
  const incentive = paiseOr0(c.incentive);
  const bonus = paiseOr0(c.bonus);
  const arrears = paiseOr0(c.arrears);
  const earningsLines = [
    ...salaryLines,
    line("extra_day_amount", "Extra Days", extraDay, true),
    line("ot_amount", "Overtime (OT)", ot, true),
    line("incentive", "Incentive", incentive, true),
    line("bonus", "Bonus", bonus, true),
    line("arrears", "Arrears", arrears, true),
  ];
  const earningsSum = salaryEarnings + extraDay + ot + incentive + bonus + arrears;
  const totalEarnings = toPaise(c.total_earnings);
  if (totalEarnings === null || earningsSum !== totalEarnings) {
    throw new SnapshotError("SNAPSHOT_EARNINGS_MISMATCH", "The stored earnings do not add up to the stored total");
  }

  /* ---- deductions ---- */
  const missing = paiseOr0(c.missing_hours_deduction);
  const pf = paiseOr0(c.employee_pf);
  const esi = paiseOr0(c.employee_esi);
  const advance = paiseOr0(c.advance_recovery);
  const shortage = paiseOr0(c.shortage_recovery);
  const deductionLines = [
    line("missing_hours_deduction", "Missing Hours Deduction", missing, true),
    line("employee_pf", "Employee PF", pf, true),
    line("employee_esi", "Employee ESI", esi, true),
    line("advance_recovery", "Advance Recovery", advance, true),
    line("shortage_recovery", "Other Deductions (Shortage Recovery)", shortage, true),
  ];
  const deductionsSum = missing + pf + esi + advance + shortage;
  const totalDeductions = toPaise(c.total_employee_deductions);
  if (totalDeductions === null || deductionsSum !== totalDeductions) {
    throw new SnapshotError("SNAPSHOT_DEDUCTIONS_MISMATCH", "The stored deductions do not add up to the stored total");
  }

  /* ---- final: the stored rounded Net Pay, verified, never recomputed ---- */
  const netPay = toPaise(c.net_pay);
  const rounding = toPaise(c.net_pay_rounding) || 0;
  const beforeRounding = totalEarnings - totalDeductions;
  if (netPay === null || beforeRounding + rounding !== netPay) {
    throw new SnapshotError("SNAPSHOT_NET_PAY_MISMATCH", "The stored Net Pay does not match its earnings, deductions and rounding");
  }

  const pfApplicable = isOne(c.pf_applicable);
  const esiApplicable = isOne(c.esi_applicable);
  const payType = textOrNull(c.pay_type) || textOrNull(employee.pay_type);
  const otGroups = parseJsonList(c.ot_groups).map((g) => ({
    approved_ot_hours: g.approved_ot_hours === undefined ? null : Number(g.approved_ot_hours),
    ot_hourly_rate: moneyOf(g.ot_hourly_rate),
    ot_amount: moneyOf(g.ot_amount),
  }));
  const nrmMinutes = c.effective_nrm_minutes === null || c.effective_nrm_minutes === undefined
    ? null
    : Number(c.effective_nrm_minutes);

  return {
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    template_version: TEMPLATE_VERSION,
    // AS IT WAS AT PUBLISH: a later edit of the company record never
    // changes a payslip already released.
    company: {
      name: textOrNull(company.name),
      address: textOrNull(company.address),
      pf_establishment_code: textOrNull(company.pf_establishment_code),
      esi_establishment_code: textOrNull(company.esi_establishment_code),
      source: textOrNull(company.source),
    },
    period: {
      year: Number(period.year),
      month: Number(period.month),
      label: monthLabel(period.year, period.month),
    },
    employee: {
      employee_id: Number(employee.employee_id),
      employee_name: textOrNull(employee.employee_name),
      designation_name: textOrNull(employee.designation_name),
      store_name: textOrNull(employee.store_name),
      department_name: textOrNull(extras.department_name),
      date_of_joining: textOrNull(employee.date_of_joining),
      pay_type: payType,
      bank_name: payType === "BANK" ? textOrNull(extras.bank_name) : null,
      bank_account_masked: payType === "BANK" ? maskAccount(extras.account_no) : null,
      pan_masked: maskPan(extras.pan_no),
    },
    attendance: {
      salary_days: c.salary_days === null || c.salary_days === undefined ? null : Number(c.salary_days),
      monthly_gross: moneyOf(c.monthly_gross),
      daily_rate: moneyOf(c.daily_rate),
      nrm_hours: nrmMinutes === null ? null : Math.round((nrmMinutes / 60) * 100) / 100,
      missing_hours: Math.round((Number(c.missing_hours_minutes || 0) / 60) * 100) / 100,
      missing_hours_deduction: money(missing),
      extra_days: c.extra_days === null || c.extra_days === undefined ? null : Number(c.extra_days),
      extra_day_amount: money(extraDay),
      approved_ot_hours: Number(c.approved_ot_hours || 0),
      ot_hourly_rate: moneyOf(c.ot_hourly_rate),
      ot_amount: money(ot),
      ot_groups: otGroups,
    },
    earnings: {
      lines: earningsLines,
      salary_earnings: money(salaryEarnings),
      component_basis: split ? split.basis : "SALARY_EARNINGS_SINGLE_LINE",
      balancing_component: split && split.balancing !== null ? COMPONENTS[split.balancing][0] : null,
      total: money(totalEarnings),
    },
    deductions: {
      lines: deductionLines,
      total: money(totalDeductions),
    },
    statutory: {
      pf_applicable: pfApplicable,
      // MASKED ON THE EMPLOYEE-FACING PAYSLIP: the last four characters
      // identify the number to its owner; the full values stay on the
      // month's payrun snapshot for payroll's own use.
      uan_masked: pfApplicable ? maskTail(employee.uan) : null,
      pf_number_masked: pfApplicable ? maskTail(employee.pf_number) : null,
      pf_wage: pfApplicable ? moneyOf(c.pf_wage) : null,
      /*
       * A MONTH CUT BY A PF CEILING CHANGE SHOWS ITS PERIODS. September 2026
       * was charged on the 15,000 ceiling for 01-16 and on 25,000 for 17-30;
       * the employee's single PF deduction above is the sum of the two, and
       * the payslip says so rather than showing one figure nobody can check.
       * Empty for an ordinary month.
       */
      pf_periods: pfApplicable
        ? (() => {
            const periods = parseJsonList(c.pf_segments);
            return periods.length > 1
              ? periods.map((p) => ({
                  from: textOrNull(p.from),
                  to: textOrNull(p.to),
                  monthly_wage_ceiling: moneyOf(p.monthly_wage_ceiling),
                  pf_wage: moneyOf(p.pf_wage),
                  employee_pf: moneyOf(p.employee_pf),
                }))
              : [];
          })()
        : [],
      pf_ceiling_version: pfApplicable ? textOrNull(c.pf_ceiling_version) : null,
      esi_applicable: esiApplicable,
      esi_number_masked: esiApplicable ? maskTail(employee.esi_number) : null,
      esi_wage: esiApplicable ? moneyOf(c.esi_wage) : null,
    },
    final: {
      net_pay_before_rounding: money(beforeRounding),
      net_pay_rounding: money(rounding),
      net_pay: money(netPay),
    },
    informational: {
      balance_advance: moneyOf(c.balance_advance),
    },
    source: {
      payrun_employee_id: Number(c.payrun_employee_id),
      payrun_calculation_id: Number(c.payrun_calculation_id),
      calculation_version: Number(c.calculation_version),
      calculation_revision: Number(c.calculation_revision),
      calculation_hash: String(c.calculation_hash),
      approved_at: textOrNull(c.approved_at),
    },
  };
}

/* ----------------------------------------------------- serialization */

/** Deterministic JSON: object keys sorted at every level. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

const sha256 = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");

/** The text that is stored and the hash stored beside it. */
function freezeSnapshot(snapshot) {
  const text = canonicalJson(snapshot);
  return { text, sha256: sha256(text) };
}

/**
 * Read a stored snapshot back, REFUSING one whose bytes no longer match the
 * hash frozen beside them. A tampered payslip is never shown.
 */
function readFrozenSnapshot(text, expectedSha256) {
  if (typeof text !== "string" || sha256(text) !== expectedSha256) {
    throw new SnapshotError("SNAPSHOT_INTEGRITY", "This payslip failed its integrity check");
  }
  return JSON.parse(text);
}

/* ---------------------------------------------------------- filename */

/** Payslip_Sep-2026_101_C-Saravanan.pdf - ASCII letters, digits and '-' only. */
function payslipFilename(snapshot) {
  const m = Number(snapshot && snapshot.period && snapshot.period.month);
  const y = Number(snapshot && snapshot.period && snapshot.period.year);
  const id = Number(snapshot && snapshot.employee && snapshot.employee.employee_id);
  const name = String((snapshot && snapshot.employee && snapshot.employee.employee_name) || "")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const mon = Number.isInteger(m) && m >= 1 && m <= 12 ? MONTH_SHORT[m - 1] : "Month";
  const year = Number.isInteger(y) ? y : "";
  const parts = [`Payslip_${mon}-${year}`, Number.isInteger(id) && id > 0 ? String(id) : null, name || null];
  return `${parts.filter(Boolean).join("_")}.pdf`;
}

module.exports = {
  SnapshotError,
  toPaise,
  money,
  maskAccount,
  maskPan,
  splitByWeights,
  balancedComponents,
  maskTail,
  buildPayslipSnapshot,
  canonicalJson,
  sha256,
  freezeSnapshot,
  readFrozenSnapshot,
  payslipFilename,
};
