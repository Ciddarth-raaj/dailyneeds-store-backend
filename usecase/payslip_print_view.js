const { asExitMonthView } = require("../utils/payslip_snapshot");

/**
 * THE DOCUMENT A PUBLISHED PAYSLIP PRINTS AS. An ordinary payslip whose month
 * is the employee's exit month is shown and downloaded as the Full & Final
 * Settlement (`asExitMonthView`). Read-only: the stored snapshot is never
 * changed. A repository without `getExitFacts` (older wiring, tests) prints
 * the snapshot as it was published.
 *
 * @param {object} payslipRepo  repository/payrun_payslip.js
 * @returns {function(object):Promise<object>}
 */
module.exports = (payslipRepo) => async (snapshot) => {
  const src = snapshot && snapshot.source;
  // Only an F&F is already the F&F; an older payslip may carry no document_type at all.
  if (!snapshot || snapshot.document_type === "FNF" || !src) return snapshot;
  if (!payslipRepo || typeof payslipRepo.getExitFacts !== "function") return snapshot;
  const facts = await payslipRepo.getExitFacts({
    payrun_employee_id: src.payrun_employee_id,
    payrun_calculation_id: src.payrun_calculation_id,
  });
  return asExitMonthView(snapshot, facts);
};
