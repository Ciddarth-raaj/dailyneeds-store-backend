/**
 * FULL & FINAL SETTLEMENT, EXIT INTERVIEW AND REHIRE ELIGIBILITY - the
 * vocabulary.
 *
 * ONE PLACE FOR THE STRINGS THAT CROSS THE WIRE, as `constants/payrun.js` and
 * `constants/payrun_adjustments.js` are for their stages. NOTHING HERE
 * CALCULATES: the F&F month is priced by `utils/payrun_calculation.js` - the
 * SAME engine, unchanged, that prices every month. There is no second engine.
 *
 * ========================================== WHAT AN F&F MONTH IS ==========
 *
 * An employee's F&F month is the payroll month their LAST WORKING DAY falls
 * in - read from the payrun snapshot's `resignation_date`, which is the date
 * the Resign action records and the one every payroll stage already uses
 * (`utils/payrun_eligibility.js#exitedByMonthEnd`). That month is calculated,
 * approved and published by the ordinary payrun; the only differences are:
 *
 *   - the published document is a Full & Final Settlement statement rather
 *     than a Salary Payslip, and
 *   - its payment is confirmed by Accounts (settlement completion, below).
 */

/*
 * NO F&F EARNING / RECOVERY COMPONENTS. By the business owner's decision
 * (review round 2) there are no extra fields for leave encashment, gratuity,
 * notice pay or notice-period recovery: the exit month is paid exactly as the
 * ordinary payrun pays it (salary days, approved OT, PF / ESI, the existing
 * Adjustments - advance and shortage recovery included). Gratuity and any
 * statutory dues outside the payrun are listed for clarification in the
 * review report; nothing here pays or withholds them.
 */

/* ================================================== THE DOCUMENT ======== */

/** Which document a published snapshot is. Stored on `payrun_payslip.document_type`. */
const DOCUMENT_TYPE = {
  PAYSLIP: "PAYSLIP",
  FNF: "FNF",
};

/** The renderer an F&F snapshot was frozen for. */
const FNF_TEMPLATE_VERSION = "fnf-v1";

/*
 * THE EMPLOYEE ACKNOWLEDGEMENT - a PAYROLL-PAYMENT acknowledgement only.
 *
 * It acknowledges the payroll amount this statement shows - the published
 * monthly payroll's own Net Pay - and nothing else. It contains NO waiver: no
 * release of legal dues, disputes, back wages, reinstatement or reemployment
 * claims. Gratuity, leave encashment and other separately payable statutory
 * dues are outside this statement (paid by Accounts outside DNDS), and the
 * statement says so in its note.
 *
 * Frozen into each published snapshot, so a later wording change never alters
 * a statement already issued. Wording for HR / legal approval.
 */
const FNF_ACKNOWLEDGEMENT_HEADING = "Employee Acknowledgement";

/** Net Pay zero or above: the employee is paid. */
const FNF_ACKNOWLEDGEMENT =
  "I acknowledge receipt of the net amount stated above, being my salary and other payroll dues for my last " +
  "month of service as calculated in the monthly payroll. This acknowledgement covers only the payroll amounts " +
  "shown in this statement.";

/** Net Pay below zero: the payroll deductions exceed the earnings. */
const FNF_ACKNOWLEDGEMENT_RECOVERABLE =
  "I acknowledge that, as calculated in the monthly payroll for my last month of service, the net amount stated " +
  "above is shown as recoverable from me. This acknowledgement covers only the payroll amounts shown in this " +
  "statement.";

/** Printed on every F&F statement, payable or recoverable. */
const FNF_STATUTORY_NOTE =
  "Gratuity, leave encashment and any other statutory dues payable separately are outside this payroll " +
  "statement. They are not included in the amount above and are settled separately by Accounts.";

/* ======================================= SETTLEMENT COMPLETION ========== */

/**
 * THE STORED SETTLEMENT STATE. Two values: the settlement is either still
 * open, or Accounts has confirmed that the money was actually paid
 * (`confirm_fnf_payment`). Publishing the statement is NOT payment.
 */
const SETTLEMENT_STATUS = {
  PENDING: "PENDING",
  SETTLED: "SETTLED",
};

/**
 * THE STAGE A SCREEN SHOWS - derived on every read from the payroll's own
 * state plus the stored settlement status, never stored, so it cannot drift
 * from the payrun.
 */
const SETTLEMENT_STAGE = {
  NOT_IN_PAYROLL: "NOT_IN_PAYROLL",
  IN_PAYROLL: "IN_PAYROLL",
  APPROVED: "APPROVED",
  PUBLISHED: "PUBLISHED",
  SETTLED: "SETTLED",
};

const SETTLEMENT_STAGE_LABEL = {
  [SETTLEMENT_STAGE.NOT_IN_PAYROLL]: "Not in payroll yet",
  [SETTLEMENT_STAGE.IN_PAYROLL]: "In payroll",
  [SETTLEMENT_STAGE.APPROVED]: "Approved & locked",
  [SETTLEMENT_STAGE.PUBLISHED]: "Published - payment not confirmed",
  [SETTLEMENT_STAGE.SETTLED]: "Paid (confirmed by Accounts)",
};

const PAYMENT_MODE = {
  BANK: "BANK",
  CASH: "CASH",
};

const SETTLEMENT_EVENT = {
  SETTLED: "SETTLED",
  REOPENED: "REOPENED",
};

const SETTLEMENT_REFERENCE_MAX = 100;
const SETTLEMENT_REASON_MAX = 500;

/* ============================================ EXIT INTERVIEW ============ */

const EXIT_REASON = {
  BETTER_OPPORTUNITY: "BETTER_OPPORTUNITY",
  COMPENSATION: "COMPENSATION",
  WORK_ENVIRONMENT: "WORK_ENVIRONMENT",
  MANAGER_RELATIONSHIP: "MANAGER_RELATIONSHIP",
  WORKING_HOURS: "WORKING_HOURS",
  PERSONAL_FAMILY: "PERSONAL_FAMILY",
  RELOCATION: "RELOCATION",
  HEALTH: "HEALTH",
  HIGHER_STUDIES: "HIGHER_STUDIES",
  TERMINATED: "TERMINATED",
  ABSCONDED: "ABSCONDED",
  OTHER: "OTHER",
};

const EXIT_REASON_LABEL = {
  BETTER_OPPORTUNITY: "Better opportunity",
  COMPENSATION: "Salary / compensation",
  WORK_ENVIRONMENT: "Work environment",
  MANAGER_RELATIONSHIP: "Manager / supervisor",
  WORKING_HOURS: "Working hours / shifts",
  PERSONAL_FAMILY: "Personal / family",
  RELOCATION: "Relocation",
  HEALTH: "Health",
  HIGHER_STUDIES: "Higher studies",
  TERMINATED: "Terminated by company",
  ABSCONDED: "Absconded",
  OTHER: "Other",
};

/**
 * THE SHORT INTERVIEW: four 1-5 ratings, two yes/no questions and two free
 * texts. Short on purpose - it is filled in on a phone at an outlet.
 */
const INTERVIEW_RATINGS = [
  { key: "rating_job_satisfaction", label: "Job satisfaction" },
  { key: "rating_manager_support", label: "Support from manager" },
  { key: "rating_work_environment", label: "Work environment" },
  { key: "rating_compensation", label: "Salary & benefits" },
];

const YES_NO = { YES: "YES", NO: "NO" };
const INTERVIEW_TEXT_MAX = 1000;

/* ======================================== REHIRE ELIGIBILITY ============ */

const REHIRE_ELIGIBILITY = {
  YES: "YES",
  NO: "NO",
  CONDITIONAL: "CONDITIONAL",
};

const REHIRE_ELIGIBILITY_LABEL = {
  YES: "Fit for rehire",
  NO: "Not fit for rehire",
  CONDITIONAL: "Conditional",
};

const REHIRE_NOTE_MAX = 500;

module.exports = {
  DOCUMENT_TYPE,
  FNF_TEMPLATE_VERSION,
  FNF_ACKNOWLEDGEMENT_HEADING,
  FNF_ACKNOWLEDGEMENT,
  FNF_ACKNOWLEDGEMENT_RECOVERABLE,
  FNF_STATUTORY_NOTE,
  SETTLEMENT_STATUS,
  SETTLEMENT_STAGE,
  SETTLEMENT_STAGE_LABEL,
  PAYMENT_MODE,
  SETTLEMENT_EVENT,
  SETTLEMENT_REFERENCE_MAX,
  SETTLEMENT_REASON_MAX,
  EXIT_REASON,
  EXIT_REASON_LABEL,
  INTERVIEW_RATINGS,
  YES_NO,
  INTERVIEW_TEXT_MAX,
  REHIRE_ELIGIBILITY,
  REHIRE_ELIGIBILITY_LABEL,
  REHIRE_NOTE_MAX,
};
