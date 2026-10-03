/**
 * WHICH COMPANY A PAYSLIP IS ISSUED BY - decided from the existing
 * `company_details` records, never from a hardcoded name.
 *
 * PURE: the rows and the environment are arguments.
 *
 *   1. PAYSLIP_COMPANY_ID set     -> that record; it must exist and be active.
 *   2. otherwise                  -> the ONE active record. Several active
 *                                    records are ambiguous and are refused
 *                                    rather than guessed between.
 *   3. no usable record           -> PAYSLIP_COMPANY_NAME (and _ADDRESS) if
 *                                    somebody configured them on purpose;
 *                                    otherwise Publish is refused with a
 *                                    message saying what to configure.
 *
 * PAYSLIP_COMPANY_NAME / PAYSLIP_COMPANY_ADDRESS, when set, override the
 * record's name / address - an intentional override only.
 *
 * The result is frozen into each payslip's snapshot at Publish, so a later
 * edit of the company record never changes a payslip already released.
 */
class PayslipCompanyError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
    this.code = "PAYSLIP_COMPANY_NOT_CONFIGURED";
  }
}

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
        `PAYSLIP_COMPANY_ID=${wantedId} does not name an active company in Company Details`
      );
    }
  } else {
    const active = list.filter(isActive);
    if (active.length > 1) {
      throw new PayslipCompanyError(
        "More than one active company exists in Company Details; set PAYSLIP_COMPANY_ID to choose the payslip issuer"
      );
    }
    row = active[0] || null;
  }
  const name = text(env.PAYSLIP_COMPANY_NAME) || (row && text(row.company_name));
  if (!name) {
    throw new PayslipCompanyError(
      "No company is configured for payslips: add the company in Company Details (or set PAYSLIP_COMPANY_NAME)"
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

module.exports = { resolvePayslipCompany, PayslipCompanyError };
