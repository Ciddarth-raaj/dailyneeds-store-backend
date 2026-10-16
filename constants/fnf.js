/**
 * FULL & FINAL SETTLEMENT, EXIT INTERVIEW AND REHIRE ELIGIBILITY - the
 * vocabulary.
 *
 * ONE PLACE FOR THE STRINGS THAT CROSS THE WIRE, as `constants/payrun.js` and
 * `constants/payrun_adjustments.js` are for their stages. NOTHING HERE
 * CALCULATES: what an F&F component does to the money is declared here as
 * data and applied by `utils/payrun_calculation.js#computeCalculation` - the
 * SAME engine that prices every month. There is no second payroll engine.
 *
 * ========================================== WHAT AN F&F MONTH IS ==========
 *
 * An employee's F&F month is the payroll month their LAST WORKING DAY falls
 * in - read from the payrun snapshot's `resignation_date`, which is the date
 * the Resign action records and the one every payroll stage already uses
 * (`utils/payrun_eligibility.js#exitedByMonthEnd`). That month is calculated,
 * approved and published by the ordinary payrun; the only differences are:
 *
 *   - F&F earnings / recoveries may be entered for it (below), and
 *   - the published document is a Full & Final Settlement statement rather
 *     than a Salary Payslip.
 */

/** What an F&F component does to the money. The same three kinds as Adjustments V1. */
const FNF_KIND = {
  ADDITION: "ADDITION",
  DEDUCTION: "DEDUCTION",
};

const FNF_COMPONENT = {
  LEAVE_ENCASHMENT: "LEAVE_ENCASHMENT",
  NOTICE_PAY: "NOTICE_PAY",
  GRATUITY: "GRATUITY",
  NOTICE_PERIOD_RECOVERY: "NOTICE_PERIOD_RECOVERY",
};

/**
 * THE F&F CATALOGUE. Closed and named, for the reason Adjustments V1 gives:
 * "Other F&F Deduction 4,000" on a settlement is an argument, not an
 * explanation. Advance and shortage recovery are NOT here - they already
 * exist as Adjustments and are recovered through them, so an F&F month cannot
 * recover the same advance twice under two names.
 *
 * AMOUNTS ARE ENTERED, NEVER DERIVED. Leave balance, gratuity eligibility
 * (five years' continuous service) and the notice shortfall are not modelled
 * anywhere in this system, so the F&F stage records the figure HR has worked
 * out and audits who entered it. It does not invent a policy.
 *
 * `pf` / `esi` are FALSE for all four, stated per component. Gratuity and
 * leave encashment are excluded from both wage definitions; pay in lieu of
 * notice and its recovery are treated the same way here. That last point is a
 * BUSINESS DECISION TO CONFIRM (see the F&F review report) - the flag is where
 * it changes, not a branch in the engine.
 */
const FNF_COMPONENTS = [
  {
    key: FNF_COMPONENT.LEAVE_ENCASHMENT,
    label: "Leave Encashment",
    kind: FNF_KIND.ADDITION,
    pf: false,
    esi: false,
    help: "Unused leave paid out at exit. Added to net pay. No PF, no ESI.",
  },
  {
    key: FNF_COMPONENT.NOTICE_PAY,
    label: "Notice Pay (in lieu)",
    kind: FNF_KIND.ADDITION,
    pf: false,
    esi: false,
    help: "Paid by the company in lieu of notice. Added to net pay. No PF, no ESI.",
  },
  {
    key: FNF_COMPONENT.GRATUITY,
    label: "Gratuity",
    kind: FNF_KIND.ADDITION,
    pf: false,
    esi: false,
    help: "Gratuity payable at exit. Added to net pay. No PF, no ESI.",
  },
  {
    key: FNF_COMPONENT.NOTICE_PERIOD_RECOVERY,
    label: "Notice Period Recovery",
    kind: FNF_KIND.DEDUCTION,
    pf: false,
    esi: false,
    help: "Recovered for notice not served. Deducted from net pay. Does not reduce PF or ESI wages.",
  },
];

const FNF_COMPONENT_KEYS = FNF_COMPONENTS.map((c) => c.key);
const FNF_COMPONENT_BY_KEY = FNF_COMPONENTS.reduce((map, c) => {
  map[c.key] = c;
  return map;
}, {});

/** The largest single F&F amount accepted. Larger is a typing error, not a settlement. */
const FNF_AMOUNT_MAX = 10000000;
const FNF_REMARKS_MAX = 500;

/** The F&F item audit log's verbs. */
const FNF_ITEM_AUDIT_ACTION = {
  SET_AMOUNT: "SET_AMOUNT",
  CLEAR_AMOUNT: "CLEAR_AMOUNT",
};

/* ================================================== THE DOCUMENT ======== */

/** Which document a published snapshot is. Stored on `payrun_payslip.document_type`. */
const DOCUMENT_TYPE = {
  PAYSLIP: "PAYSLIP",
  FNF: "FNF",
};

/** The renderer an F&F snapshot was frozen for. */
const FNF_TEMPLATE_VERSION = "fnf-v1";

const FNF_DECLARATION =
  "I, the undersigned, hereby state that I have received the above said amount as my full and final " +
  "settlement out of my own free will and choice on tendering my resignation and I assure that I have no " +
  "grievances, disputes, demands and claims about my legal dues, back wages, reinstatement or " +
  "reemployment against the company.";

/* ======================================= SETTLEMENT COMPLETION ========== */

/**
 * THE STORED SETTLEMENT STATE. Two values: the settlement is either still
 * open, or HR has recorded that the money changed hands.
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
  [SETTLEMENT_STAGE.PUBLISHED]: "F&F published",
  [SETTLEMENT_STAGE.SETTLED]: "Settled",
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
  FNF_KIND,
  FNF_COMPONENT,
  FNF_COMPONENTS,
  FNF_COMPONENT_KEYS,
  FNF_COMPONENT_BY_KEY,
  FNF_AMOUNT_MAX,
  FNF_REMARKS_MAX,
  FNF_ITEM_AUDIT_ACTION,
  DOCUMENT_TYPE,
  FNF_TEMPLATE_VERSION,
  FNF_DECLARATION,
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
