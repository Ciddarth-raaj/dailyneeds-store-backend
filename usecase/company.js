const { validateCompanyDetails, presentCompany } = require("../utils/company_details");
const { payslipCompanyStatus } = require("../utils/payslip_company");

/**
 * Master → Company Details.
 *
 * Editing a company here NEVER touches a published payslip: Publish copies
 * the company into each payslip's frozen snapshot (`payrun_payslip`), and
 * nothing in this usecase reads or writes that table.
 */
class companyUsecase {
  /**
   * @param companyRepo  repository/company.js
   * @param companyEnv   () => the PAYSLIP_COMPANY_* emergency overrides, so the
   *                     status shown here is the one Publish will reach
   */
  constructor(companyRepo, companyEnv = () => ({})) {
    this.companyRepo = companyRepo;
    this.companyEnv = companyEnv;
  }

  async get(company_id) {
    return this.companyRepo.get(company_id);
  }

  /** Every company, and whether payslips can be published from them. */
  async list() {
    const rows = await this.companyRepo.list();
    return {
      companies: rows.map(presentCompany),
      payslip: payslipCompanyStatus(rows, this.companyEnv() || {}),
    };
  }

  async create(body) {
    const { values, payslip_active } = validateCompanyDetails(body);
    const company_id = await this.companyRepo.create(values, { payslip_active });
    return { company_id };
  }

  async update(company_id, body) {
    const { values, payslip_active } = validateCompanyDetails(body);
    const found = await this.companyRepo.update(company_id, values, { payslip_active });
    if (!found) throw notFound();
    return { company_id };
  }

  async setPayslipCompany(company_id) {
    const found = await this.companyRepo.setPayslipCompany(company_id);
    if (!found) throw notFound();
    return { company_id };
  }

  async updateStatus(file) {
    if (Number(file.status) === 1) {
      const found = await this.companyRepo.setPayslipCompany(file.company_id);
      if (!found) throw notFound();
    } else {
      await this.companyRepo.updateStatus(file);
    }
    return 200;
  }
}

function notFound() {
  const err = new Error("No such company");
  err.name = "NotFoundError";
  return err;
}

module.exports = (companyRepo, companyEnv) => {
  return new companyUsecase(companyRepo, companyEnv);
};
