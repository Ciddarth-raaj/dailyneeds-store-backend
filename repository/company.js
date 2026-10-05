const logger = require("../utils/logger");

/**
 * `company_details` - Master → Company Details, and the record Payslip
 * Publish takes its issuer from (`utils/payslip_company.js`).
 *
 * "Active for Payslip" is the existing `status` column. Marking one company
 * active clears it on every other row, so the screens can only ever leave
 * exactly one; a database that already holds several (written before this
 * screen) is reported, and Publish refuses it, until somebody chooses.
 */
const COLUMNS = [
  "company_name",
  "reg_address",
  "contact_number",
  "gst_number",
  "pan_number",
  "tan_number",
  "pf_number",
  "esi_number",
];

class CompanyRepository {
  constructor(db) {
    this.db = db;
  }

  _query(code, sql, params) {
    return new Promise((resolve, reject) => {
      this.db.query(sql, params, (err, docs) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.COMPANY",
            code: `REPOSITORY.COMPANY.${code}`,
            description: err.toString(),
            category: "",
            ref: {},
          });
          reject(err);
          return;
        }
        resolve(docs);
      });
    });
  }

  get(company_id) {
    return this._query("GET", "SELECT * FROM company_details where company_id = ?", [company_id]);
  }

  list() {
    return this._query("LIST", "SELECT * FROM company_details ORDER BY company_id", []);
  }

  updateStatus(file) {
    return this._query("UPDATE-STATUS", "UPDATE company_details SET status = ? WHERE company_id = ?", [
      file.status,
      file.company_id,
    ]);
  }

  /** @returns {Promise<number>} the new company_id */
  async create(values, { payslip_active = false } = {}) {
    const res = await this._query(
      "CREATE",
      `INSERT INTO company_details (${COLUMNS.join(", ")}, logo, status) VALUES (${COLUMNS.map(() => "?").join(", ")}, ?, ?)`,
      [...COLUMNS.map((c) => values[c]), values.logo || null, payslip_active ? 1 : 0]
    );
    const id = Number(res.insertId);
    if (payslip_active) await this.clearOtherPayslipCompanies(id);
    return id;
  }

  /** @returns {Promise<boolean>} false when there is no such company */
  async update(company_id, values, { payslip_active = false } = {}) {
    const res = await this._query(
      "UPDATE",
      `UPDATE company_details SET ${COLUMNS.map((c) => `${c} = ?`).join(", ")}, status = ? WHERE company_id = ?`,
      [...COLUMNS.map((c) => values[c]), payslip_active ? 1 : 0, company_id]
    );
    if (Number(res.affectedRows || 0) === 0) return false;
    if (payslip_active) await this.clearOtherPayslipCompanies(company_id);
    return true;
  }

  /** The chosen company becomes the ONLY one Active for Payslip. */
  async setPayslipCompany(company_id) {
    const res = await this._query(
      "SET-PAYSLIP-COMPANY",
      "UPDATE company_details SET status = 1 WHERE company_id = ?",
      [company_id]
    );
    if (Number(res.affectedRows || 0) === 0) return false;
    await this.clearOtherPayslipCompanies(company_id);
    return true;
  }

  clearOtherPayslipCompanies(company_id) {
    return this._query(
      "CLEAR-OTHER-PAYSLIP-COMPANIES",
      "UPDATE company_details SET status = 0 WHERE company_id <> ? AND status <> 0",
      [company_id]
    );
  }
}

module.exports = (db) => {
  return new CompanyRepository(db);
};
module.exports.CompanyRepository = CompanyRepository;
