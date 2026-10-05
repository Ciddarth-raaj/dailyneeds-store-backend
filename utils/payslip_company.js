/**
 * WHICH COMPANY A PAYSLIP IS ISSUED BY - decided from the existing
 * `company_details` records, never from a hardcoded name.
 *
 * PURE: the rows and the environment are arguments.
 *
 *   1. PAYSLIP_COMPANY_ID set     -> that record; it must exist and be active.
 *   2. otherwise                  -> the ONE active record ("Active for
 *                                    Payslip" on Master → Company Details is
 *                                    `status = 1`). Several active records are
 *                                    ambiguous and are refused rather than
 *                                    guessed between.
 *   3. no usable record           -> PAYSLIP_COMPANY_NAME (and _ADDRESS) if
 *                                    somebody configured them on purpose;
 *                                    otherwise Publish is refused with a
 *                                    message saying what to configure.
 *
 * PAYSLIP_COMPANY_NAME / PAYSLIP_COMPANY_ADDRESS, when set, override the
 * record's name / address - an EMERGENCY override only. Company Details is
 * the normal source of truth; none of these are needed in normal operation.
 *
 * The result is frozen into each payslip's snapshot at Publish, so a later
 * edit of the company record never changes a payslip already released.
 */
class PayslipCompanyError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = "ValidationError";
    this.code = "PAYSLIP_COMPANY_NOT_CONFIGURED";
    // NONE | MULTIPLE | ID_INVALID - what the screens say about it.
    this.reason = reason;
  }
}

/** The words the Payroll screen shows while Publish is unavailable. */
const NOT_CONFIGURED_MESSAGE = "Payslip publishing is unavailable until Company Details is configured.";
const MULTIPLE_MESSAGE =
  "More than one company is marked Active for Payslip in Company Details. Choose the payslip company in Master → Company Details before publishing.";

const text = (v) => {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t === "" ? null : t;
};
const isActive = (row) => Number(row.status) === 1;

function resolvePayslipCompany(rows, env = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const wantedId = text(env.PAYSLIP_COMPANY_ID);
  let row = null;
  if (wantedId !== null) {
    row = list.find((r) => String(r.company_id) === wantedId && isActive(r)) || null;
    if (!row) {
      throw new PayslipCompanyError(
        `PAYSLIP_COMPANY_ID=${wantedId} does not name an active company in Company Details`,
        "ID_INVALID"
      );
    }
  } else {
    const active = list.filter(isActive);
    if (active.length > 1) {
      throw new PayslipCompanyError(MULTIPLE_MESSAGE, "MULTIPLE");
    }
    row = active[0] || null;
  }
  const name = text(env.PAYSLIP_COMPANY_NAME) || (row && text(row.company_name));
  if (!name) {
    throw new PayslipCompanyError(
      `${NOT_CONFIGURED_MESSAGE} Add the company in Master → Company Details and mark it Active for Payslip.`,
      "NONE"
    );
  }
  return {
    name,
    address: text(env.PAYSLIP_COMPANY_ADDRESS) || (row && text(row.reg_address)) || null,
    pf_establishment_code: row ? text(row.pf_number) : null,
    esi_establishment_code: row ? text(row.esi_number) : null,
    source: row ? `company_details:${row.company_id}` : "env",
  };
}

/**
 * CAN PAYSLIPS BE PUBLISHED RIGHT NOW? The same decision Publish makes, as
 * data for the Payroll screen and Company Details - never a second rule.
 *
 * `configured: false` disables every Publish affordance; the server refuses
 * Publish on its own regardless of what a screen drew.
 */
function payslipCompanyStatus(rows, env = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const activeCount = list.filter(isActive).length;
  try {
    const company = resolvePayslipCompany(list, env);
    const match = /^company_details:(\d+)$/.exec(company.source || "");
    return {
      configured: true,
      reason: null,
      message: null,
      active_count: activeCount,
      company: {
        company_id: match ? Number(match[1]) : null,
        name: company.name,
        has_pf_establishment_code: Boolean(company.pf_establishment_code),
        has_esi_establishment_code: Boolean(company.esi_establishment_code),
        source: match ? "company_details" : "env",
      },
    };
  } catch (err) {
    if (!(err instanceof PayslipCompanyError)) throw err;
    return {
      configured: false,
      reason: err.reason || "NONE",
      message: err.reason === "MULTIPLE" ? MULTIPLE_MESSAGE : NOT_CONFIGURED_MESSAGE,
      detail: err.message,
      active_count: activeCount,
      company: null,
    };
  }
}

module.exports = {
  resolvePayslipCompany,
  payslipCompanyStatus,
  PayslipCompanyError,
  NOT_CONFIGURED_MESSAGE,
  MULTIPLE_MESSAGE,
};
