/**
 * COMPANY DETAILS - what an administrator may write to `company_details`.
 *
 * PURE: the request body in, the row values out, or a ValidationError naming
 * every field that is wrong. The table is the 2021 one
 * (20210929103343-added-company-details + 20211004184520-adds-logo); nothing
 * here adds a column, and the limits are the columns' own:
 *
 *   company_name    VARCHAR(45)  NOT NULL   Company Name           required
 *   reg_address     LONGTEXT     NOT NULL   Registered / Payroll Address  required
 *   contact_number  VARCHAR(45)  NOT NULL   Phone
 *   gst_number      VARCHAR(45)  NOT NULL   GSTIN
 *   pan_number      VARCHAR(45)  NOT NULL   PAN
 *   tan_number      VARCHAR(45)  NOT NULL   TAN
 *   pf_number       VARCHAR(45)  NOT NULL   PF Establishment Code
 *   esi_number      VARCHAR(45)  NOT NULL   ESI Establishment Code
 *   status          TINYINT      DEFAULT 1  Active for Payslip
 *
 * The optional columns are NOT NULL with no default, so an empty field is
 * stored as '' - which `utils/payslip_company.js` already reads as absent.
 *
 * PF / ESI ESTABLISHMENT CODES ARE OPTIONAL HERE. Whether they are needed is
 * decided per payslip at Publish: an employee whose month has PF (or ESI)
 * applicable is not published while the code is missing
 * (`utils/payslip_snapshot.js`), and one without it never needs it.
 */
const ADDRESS_MAX = 500;
const COLUMN_MAX = 45;

const FIELDS = [
  { key: "company_name", label: "Company Name", required: true, max: COLUMN_MAX },
  { key: "reg_address", label: "Address", required: true, max: ADDRESS_MAX },
  {
    key: "contact_number",
    label: "Phone",
    max: 20,
    pattern: /^\+?[0-9][0-9 \-()]{5,18}$/,
    hint: "digits, spaces, '+', '-' or brackets",
  },
  {
    key: "gst_number",
    label: "GSTIN",
    upper: true,
    pattern: /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/,
    hint: "15 characters, e.g. 33AAAAA0000A1Z5",
  },
  {
    key: "pan_number",
    label: "PAN",
    upper: true,
    pattern: /^[A-Z]{5}[0-9]{4}[A-Z]$/,
    hint: "10 characters, e.g. AAAAA0000A",
  },
  {
    key: "tan_number",
    label: "TAN",
    upper: true,
    pattern: /^[A-Z]{4}[0-9]{5}[A-Z]$/,
    hint: "10 characters, e.g. AAAA00000A",
  },
  {
    key: "pf_number",
    label: "PF Establishment Code",
    upper: true,
    max: COLUMN_MAX,
    pattern: /^[A-Z0-9][A-Z0-9/\- ]{4,44}$/,
    hint: "letters, digits, '/' or '-', e.g. TN/MAS/0012345",
  },
  {
    key: "esi_number",
    label: "ESI Establishment Code",
    max: COLUMN_MAX,
    pattern: /^[0-9][0-9\- ]{9,44}$/,
    hint: "digits, e.g. 51000123450001001",
  },
];

class CompanyDetailsValidationError extends Error {
  constructor(errors) {
    super(errors.map((e) => e.message).join("; "));
    this.name = "ValidationError";
    this.code = "COMPANY_DETAILS_INVALID";
    this.errors = errors;
  }
}

const clean = (v) => (v === null || v === undefined ? "" : String(v).trim().replace(/\s+/g, " "));
const cleanAddress = (v) =>
  v === null || v === undefined
    ? ""
    : String(v)
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map((line) => line.trim())
        .join("\n")
        .trim();

const truthy = (v) => v === true || v === 1 || v === "1" || v === "true";

/**
 * @param {object} body  the request body
 * @returns {{ values: object, payslip_active: boolean }} the row columns
 * @throws {CompanyDetailsValidationError}
 */
function validateCompanyDetails(body = {}) {
  const input = body && typeof body === "object" ? body : {};
  const values = {};
  const errors = [];
  for (const f of FIELDS) {
    let v = f.key === "reg_address" ? cleanAddress(input[f.key]) : clean(input[f.key]);
    if (f.upper) v = v.toUpperCase();
    values[f.key] = v;
    if (v === "") {
      if (f.required) errors.push({ field: f.key, message: `${f.label} is required` });
      continue;
    }
    const max = f.max || COLUMN_MAX;
    if (v.length > max) {
      errors.push({ field: f.key, message: `${f.label} must be at most ${max} characters` });
      continue;
    }
    if (f.pattern && !f.pattern.test(v)) {
      errors.push({ field: f.key, message: `${f.label} is not valid (${f.hint})` });
    }
  }
  if (errors.length) throw new CompanyDetailsValidationError(errors);
  return { values, payslip_active: truthy(input.payslip_active) };
}

/** A row as the Company Details screen shows it. */
function presentCompany(row) {
  if (!row) return null;
  const out = { company_id: Number(row.company_id) };
  for (const f of FIELDS) out[f.key] = row[f.key] === null || row[f.key] === undefined ? "" : String(row[f.key]);
  out.payslip_active = Number(row.status) === 1;
  out.has_logo = Boolean(row.logo);
  out.created_at = row.created_at || null;
  return out;
}

module.exports = {
  FIELDS,
  ADDRESS_MAX,
  validateCompanyDetails,
  presentCompany,
  CompanyDetailsValidationError,
};
