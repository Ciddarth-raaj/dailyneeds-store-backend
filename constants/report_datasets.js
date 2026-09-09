/**
 * Reports — the dataset registry.
 *
 * One dataset is enabled today. Attendance and Payroll are named here as
 * constants ONLY so that template rows carry a meaningful `dataset_key` and
 * so a future dataset plugs into the same template, audit and reconciliation
 * machinery rather than growing its own. Neither is implemented, and neither
 * is selectable: `ENABLED_DATASETS` is the list the API will accept.
 */

const DATASET = {
  EMPLOYEE_MASTER: "EMPLOYEE_MASTER",
  // Declared, not built. Do not add to ENABLED_DATASETS without the dataset.
  ATTENDANCE_DAILY: "ATTENDANCE_DAILY",
  ATTENDANCE_SUMMARY: "ATTENDANCE_SUMMARY",
  PAYROLL_REGISTER: "PAYROLL_REGISTER",
};

const ENABLED_DATASETS = [DATASET.EMPLOYEE_MASTER];

const isEnabledDataset = (key) => ENABLED_DATASETS.includes(key);

module.exports = { DATASET, ENABLED_DATASETS, isEnabledDataset };
