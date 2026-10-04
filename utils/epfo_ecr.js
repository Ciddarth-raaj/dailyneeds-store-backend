/**
 * THE EPFO ECR (Electronic Challan cum Return) FOR ONE WAGE MONTH - pure.
 *
 * Built from STORED payrun calculations and nothing else: no figure is
 * recalculated here. One line per member per month, in the ECR 2.0 text
 * layout, fields separated by `#~#`:
 *
 *   UAN #~# MEMBER NAME #~# GROSS WAGES #~# EPF WAGES #~# EPS WAGES #~#
 *   EDLI WAGES #~# EPF CONTRI REMITTED (EE) #~# EPS CONTRI REMITTED #~#
 *   EPF EPS DIFF REMITTED (ER) #~# NCP DAYS #~# REFUND OF ADVANCES
 *
 * SEPTEMBER 2026 IS ONE ECR. The EPFO FAQ on the ceiling revision requires
 * the month to be filed in a single ECR with the contribution calculated for
 * the two periods; the stored calculation already holds the SUM of the two
 * periods (see `utils/pf_period.js`), so the member still has exactly one
 * line, whose wages and contributions are the two periods added together.
 *
 * WHOLE RUPEES. Wages are rounded to the nearest rupee; contributions are
 * already whole rupees in the calculation. The EPF-EPS difference is the
 * stored employer EPF share, which the engine computed as the employer total
 * less EPS - it is never re-derived from a percentage here.
 *
 * WHAT IS REFUSED RATHER THAN FILED. An ECR is a statutory return: a line
 * built from a guess is a filing error. Members with a pending PF question, a
 * missing UAN, an incomplete calculation, or (by default) a month that is not
 * yet approved are listed in `errors` and left out of `lines`; the caller
 * decides whether a file with errors may be downloaded at all.
 */

const SEP = "#~#";

const toPaise = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
/** Nearest whole rupee, half away from zero, from a rupee value. */
const wholeRupee = (value) => {
  const p = toPaise(value);
  if (p === null) return null;
  const sign = p < 0 ? -1 : 1;
  return sign * Math.floor((Math.abs(p) + 50) / 100);
};

/** The member name as the ECR wants it: one line, no separator characters. */
function cleanName(name) {
  return String(name || "")
    .replace(/#~#/g, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

/**
 * @param {object}  args
 * @param {Array}   args.rows       `{ employee, calculation }` pairs - the
 *                                  payrun snapshot row and its stored calculation
 * @param {boolean} [args.require_approved=true]
 * @returns {{ lines, text, errors, totals, members }}
 */
function buildEcr({ rows = [], require_approved = true } = {}) {
  const lines = [];
  const members = [];
  const errors = [];
  const totals = {
    members: 0,
    gross_wages: 0,
    epf_wages: 0,
    eps_wages: 0,
    edli_wages: 0,
    ee_share: 0,
    eps_share: 0,
    er_epf_share: 0,
    // The challan heads beyond the member lines: employer EDLI and admin.
    edli_contribution: 0,
    admin_charge: 0,
    total_remittance: 0,
  };

  rows
    .slice()
    .sort((a, b) => Number(a.employee.employee_id) - Number(b.employee.employee_id))
    .forEach(({ employee = {}, calculation = null }) => {
      const id = Number(employee.employee_id);
      const name = employee.employee_name;
      const refuse = (code, message) => errors.push({ employee_id: id, employee_name: name || null, code, message });

      if (!calculation) return refuse("NOT_CALCULATED", "No calculation is stored for this month");
      if (calculation.pf_status === "NOT_APPLICABLE") return; // not a member: no line, not an error
      if (calculation.pf_status !== "APPLIED") {
        return refuse("PF_PENDING", "The PF contribution is unresolved for this month");
      }
      if (Number(calculation.is_complete) !== 1) {
        return refuse("INCOMPLETE", "The calculation is incomplete and cannot be filed");
      }
      if (require_approved && calculation.status !== "APPROVED_LOCKED") {
        return refuse("NOT_APPROVED", "The month is not approved for this employee");
      }
      const uan = String(employee.uan || "").trim();
      if (!/^\d{12}$/.test(uan)) return refuse("UAN_MISSING", "A 12-digit UAN is not recorded");
      if (
        calculation.eps_wage === null ||
        calculation.eps_wage === undefined ||
        calculation.edli_wage === null ||
        calculation.edli_wage === undefined
      ) {
        return refuse(
          "RECALCULATION_REQUIRED",
          "The calculation predates the EPS / EDLI wage columns; recalculate before filing"
        );
      }

      const member = {
        employee_id: id,
        uan,
        member_name: cleanName(name),
        gross_wages: wholeRupee(calculation.total_earnings),
        epf_wages: wholeRupee(calculation.pf_wage),
        eps_wages: wholeRupee(calculation.eps_wage),
        edli_wages: wholeRupee(calculation.edli_wage),
        ee_share: wholeRupee(calculation.employee_pf),
        eps_share: wholeRupee(calculation.employer_eps),
        er_epf_share: wholeRupee(calculation.employer_epf),
        ncp_days: Math.max(0, Math.round(Number(calculation.ncp_days) || 0)),
        refund_of_advances: 0,
        edli_contribution: wholeRupee(calculation.edli) || 0,
        admin_charge: wholeRupee(calculation.pf_admin_charge) || 0,
        pf_scenario: calculation.pf_scenario || null,
        pf_ceiling_version: calculation.pf_ceiling_version || null,
      };
      members.push(member);
      lines.push(
        [
          member.uan,
          member.member_name,
          member.gross_wages,
          member.epf_wages,
          member.eps_wages,
          member.edli_wages,
          member.ee_share,
          member.eps_share,
          member.er_epf_share,
          member.ncp_days,
          member.refund_of_advances,
        ].join(SEP)
      );
      totals.members += 1;
      totals.gross_wages += member.gross_wages;
      totals.epf_wages += member.epf_wages;
      totals.eps_wages += member.eps_wages;
      totals.edli_wages += member.edli_wages;
      totals.ee_share += member.ee_share;
      totals.eps_share += member.eps_share;
      totals.er_epf_share += member.er_epf_share;
      totals.edli_contribution += member.edli_contribution;
      totals.admin_charge += member.admin_charge;
      totals.total_remittance +=
        member.ee_share + member.eps_share + member.er_epf_share + member.edli_contribution + member.admin_charge;
    });

  return { lines, text: lines.join("\n"), errors, totals, members };
}

/**
 * SANITY CHECKS A RETURN SHOULD PASS before anybody uploads it - the same
 * relationships the EPFO portal validates, within a rupee of rounding:
 * EE share = 12% of EPF wages, EPS = 8.33% of EPS wages, EPS wages <= EPF
 * wages, and EPF-EPS difference = EE share - EPS share.
 */
function validateEcrMember(member, rates = { employee: 12, eps: 8.33 }) {
  const problems = [];
  const near = (a, b) => Math.abs(a - b) <= 1;
  if (!near(member.ee_share, Math.round((member.epf_wages * rates.employee) / 100))) {
    problems.push("EE share is not 12% of EPF wages");
  }
  if (!near(member.eps_share, Math.round((member.eps_wages * rates.eps) / 100))) {
    problems.push("EPS share is not 8.33% of EPS wages");
  }
  if (member.eps_wages > member.epf_wages) problems.push("EPS wages exceed EPF wages");
  if (member.edli_wages > member.epf_wages) problems.push("EDLI wages exceed EPF wages");
  if (!near(member.er_epf_share, member.ee_share - member.eps_share)) {
    problems.push("EPF-EPS difference is not EE share less EPS share");
  }
  return problems;
}

module.exports = { buildEcr, validateEcrMember, cleanName, SEP };
