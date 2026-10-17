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
 * THE EMPLOYEE DECLARATION (business owner's final wording).
 *
 * PAYABLE (Net Pay zero or above): a declaration that the employee has
 * RECEIVED the Full & Final Settlement amount. RECOVERABLE (Net Pay below
 * zero): a separate acknowledgement of the amount recoverable - never a
 * declaration of payment received.
 *
 * THE AMOUNT IN THE TEXT IS THE PUBLISHED PAYROLL SNAPSHOT'S OWN Net Pay and
 * its amount in words, formatted into {amount} / {words} when the snapshot is
 * frozen - not a second calculation.
 *
 * PRINTED, NOT SIGNED. The statement is published with the declaration
 * unsigned; the employee signs and dates it only after actually receiving
 * payment. Publishing marks nothing as paid or acknowledged, and Accounts'
 * payment confirmation (confirm_fnf_payment) is a separate step.
 *
 * Frozen into each published snapshot, so a later wording change never alters
 * a statement already issued.
 */
const FNF_DECLARATION_HEADING = "Employee Declaration";
const FNF_DECLARATION =
  "I hereby declare that I have received {amount} ({words}), being my Full & Final Settlement amount stated " +
  "above, as calculated in the monthly payroll for my final month of service.";
const FNF_DECLARATION_SIGNING = "To be signed by the employee only after the amount has been received.";

const FNF_RECOVERABLE_HEADING = "Employee Acknowledgement of Recoverable Amount";
const FNF_RECOVERABLE_ACKNOWLEDGEMENT =
  "I acknowledge that, as calculated in the monthly payroll for my final month of service, {amount} ({words}) " +
  "stated above is recoverable from me.";
const FNF_RECOVERABLE_SIGNING = "To be signed by the employee in acknowledgement of the recoverable amount.";

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
  FNF_DECLARATION_HEADING,
  FNF_DECLARATION,
  FNF_DECLARATION_SIGNING,
  FNF_RECOVERABLE_HEADING,
  FNF_RECOVERABLE_ACKNOWLEDGEMENT,
  FNF_RECOVERABLE_SIGNING,
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
