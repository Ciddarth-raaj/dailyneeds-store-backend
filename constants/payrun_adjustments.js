/**
 * Payrun Adjustments V1 - the vocabulary, and the fixed list of six.
 *
 * ONE PLACE FOR THE STRINGS THAT CROSS THE WIRE, exactly as
 * `constants/payrun.js` is for initialization. A component key is stored in an
 * ENUM, written into a spreadsheet header, typed by a person into that
 * spreadsheet, read back by the importer, sent to a browser and rendered on a
 * screen. That is six places for "Advance Recovery" to be spelled slightly
 * differently, and then one of the six stops matching.
 *
 * NOTHING HERE CALCULATES ANYTHING. What a component DOES - whether it adds,
 * deducts, or does nothing at all - is declared here as data and applied by
 * `utils/payrun_adjustments.js`, which is pure. This file only names things.
 *
 * V1 IS DELIBERATELY CLOSED, AND THE CLOSURE IS THE FEATURE. There is no Loan
 * Recovery, no Other Addition, no Other Deduction and no custom component. A
 * generic component is one nobody can price or explain: "Other Deduction
 * 4,000" on a payslip is an argument, not an explanation, and the day it
 * exists every figure nobody has a column for lands in it. Six named things
 * that each mean one thing is worth more than a flexible schema here.
 */

/**
 * WHAT A COMPONENT DOES TO THE MONEY. Three kinds, and the third is the one
 * that has to be stated rather than assumed.
 *
 *   ADDITION       increases net pay
 *   DEDUCTION      decreases net pay
 *   INFORMATIONAL  does NOTHING. Not to gross, not to earned gross, not to net
 *                  pay, not to PF and not to ESI. It is carried so a payslip
 *                  can print it.
 */
const COMPONENT_KIND = {
  ADDITION: "ADDITION",
  DEDUCTION: "DEDUCTION",
  INFORMATIONAL: "INFORMATIONAL",
};

const COMPONENT = {
  INCENTIVE: "INCENTIVE",
  BONUS: "BONUS",
  ARREARS: "ARREARS",
  ADVANCE_RECOVERY: "ADVANCE_RECOVERY",
  SHORTAGE_RECOVERY: "SHORTAGE_RECOVERY",
  BALANCE_ADVANCE: "BALANCE_ADVANCE",
};

/**
 * THE CATALOGUE - the single declaration of what V1 is, in the order the
 * export template's columns appear.
 *
 * `label` IS THE SPREADSHEET COLUMN HEADING AND THE SCREEN'S LABEL, and they
 * are the same string on purpose: the person who fills in "Advance Recovery"
 * in Excel and the person reading "Advance Recovery" on the preview are the
 * same person, and a mapping table between the two is a mapping table that
 * drifts.
 *
 * `pf` AND `esi` ARE BOTH FALSE FOR EVERY COMPONENT IN V1, and they are
 * written out per component rather than assumed globally. They are not
 * decoration:
 *
 *   for the three ADDITIONS it is a real business decision - an incentive, a
 *   bonus and arrears are paid WITHOUT attracting PF or ESI in V1, and the day
 *   somebody adds a fourth addition that does attract them, the flag is where
 *   that is said rather than a new branch in the engine
 *
 *   for the two RECOVERIES it is close to a tautology and is stated anyway:
 *   recovering money an employee was ALREADY PAID does not change what they
 *   earned this month, so it cannot move a statutory wage. A deduction that
 *   reduced PF wages would be reducing the employee's own pension over an
 *   advance repayment, which is the kind of thing that is only ever found
 *   years later.
 *
 *   for BALANCE_ADVANCE it follows from the kind, and the flags agree with it
 *   rather than contradicting it.
 */
const COMPONENTS = [
  {
    key: COMPONENT.INCENTIVE,
    label: "Incentive",
    kind: COMPONENT_KIND.ADDITION,
    pf: false,
    esi: false,
    help: "Added to net pay. No PF, no ESI.",
  },
  {
    key: COMPONENT.BONUS,
    label: "Bonus",
    kind: COMPONENT_KIND.ADDITION,
    pf: false,
    esi: false,
    help: "Added to net pay. No PF, no ESI.",
  },
  {
    key: COMPONENT.ARREARS,
    label: "Arrears",
    kind: COMPONENT_KIND.ADDITION,
    pf: false,
    esi: false,
    help: "Added to net pay. No PF, no ESI.",
  },
  {
    key: COMPONENT.ADVANCE_RECOVERY,
    label: "Advance Recovery",
    kind: COMPONENT_KIND.DEDUCTION,
    pf: false,
    esi: false,
    help: "Deducted from net pay. Does not reduce PF or ESI wages.",
  },
  {
    key: COMPONENT.SHORTAGE_RECOVERY,
    label: "Shortage Recovery",
    kind: COMPONENT_KIND.DEDUCTION,
    pf: false,
    esi: false,
    help: "Deducted from net pay. Does not reduce PF or ESI wages.",
  },
  {
    key: COMPONENT.BALANCE_ADVANCE,
    label: "Balance Advance",
    kind: COMPONENT_KIND.INFORMATIONAL,
    pf: false,
    esi: false,
    help:
      "Display only. No effect on gross, earned gross, net pay, PF or ESI. " +
      "Shown on the payslip as the remaining advance balance.",
  },
];

const COMPONENT_KEYS = COMPONENTS.map((c) => c.key);

/**
 * THE PAY-AFFECTING COMPONENTS - the five that move money, and the ONE
 * DISTINCTION THE WHOLE ADJUSTMENT STATE TURNS ON.
 *
 * "HAS AN ADJUSTMENT" MEANS "SOMETHING HERE CHANGES WHAT THIS PERSON IS PAID",
 * and Balance Advance does not. It is a figure carried so a payslip can print
 * the employee's remaining advance balance; recording it asserts nothing about
 * whether they have an adjustment this month.
 *
 * SO AN EMPLOYEE MAY HAVE A BALANCE ADVANCE OF 8,500 **AND** BE CONFIRMED AS
 * HAVING NO ADJUSTMENT, and that combination is not a contradiction - it is
 * the ordinary case for anybody repaying an advance in instalments who has
 * nothing unusual in this particular month. Treating the informational figure
 * as an adjustment would force whoever records it to either leave the employee
 * permanently pending or lie about the balance, and it would revoke a
 * confirmation somebody had already given for a reason that changes no figure.
 *
 * DERIVED FROM THE KIND RATHER THAN LISTED BY HAND, so a seventh component
 * joins this set by declaring its kind and not by being remembered here.
 */
const PAY_AFFECTING_KINDS = [COMPONENT_KIND.ADDITION, COMPONENT_KIND.DEDUCTION];
const PAY_AFFECTING_COMPONENT_KEYS = COMPONENTS.filter((c) =>
  PAY_AFFECTING_KINDS.includes(c.kind)
).map((c) => c.key);

/** Does this component key change what somebody is paid? */
function isPayAffecting(key) {
  return PAY_AFFECTING_COMPONENT_KEYS.includes(key);
}
const COMPONENT_BY_KEY = COMPONENTS.reduce((map, c) => {
  map[c.key] = c;
  return map;
}, {});

/**
 * THE REFERENCE COLUMNS OF THE EXPORT TEMPLATE - who the row is about.
 *
 * READ-ONLY, AND THE SERVER TREATS THEM AS SUCH. The name and the location are
 * printed so the person filling the sheet can see who they are typing against;
 * neither is ever written back by an import, and a changed name is a WARNING
 * (the rows were probably sorted or pasted out of line) rather than an
 * instruction to rename anybody. `Employee ID` is the only identity the
 * importer trusts.
 */
const REFERENCE_COLUMNS = [
  { key: "employee_id", label: "Employee ID" },
  { key: "employee_name", label: "Employee Name" },
  { key: "location", label: "Location" },
];

/** The free-text column, one per employee row. */
const REMARKS_COLUMN = { key: "remarks", label: "Remarks" };

const REMARKS_MAX_LENGTH = 500;

/**
 * THE THREE STATES EVERY INITIALIZED EMPLOYEE RESOLVES TO, and they are
 * exclusive in this order.
 *
 *   HAS_ADJUSTMENT                     at least one component amount is stored
 *   NO_ADJUSTMENT_CONFIRMED            somebody explicitly said "none", and
 *                                      that somebody is recorded
 *   NO_ADJUSTMENT_PENDING_CONFIRMATION everything else - which is where every
 *                                      newly initialized employee starts, by
 *                                      arithmetic rather than by a job that
 *                                      has to run
 *
 * HAS_ADJUSTMENT WINS OVER A CONFIRMATION, and that ordering IS the transition
 * the specification asks to be defined: an employee who was confirmed as
 * having none and is later given an Incentive is no longer confirmed-none. The
 * write clears the flag in the same transaction (see the repository), so the
 * two never disagree - but even if a stale flag survived, this order means the
 * state that is REPORTED is the true one.
 *
 * THERE IS NO FOURTH STATE AND NO "NOT APPLICABLE". An employee who is not
 * initialized is not in this population at all; they are not a state of it.
 */
const ADJUSTMENT_STATE = {
  HAS_ADJUSTMENT: "HAS_ADJUSTMENT",
  NO_ADJUSTMENT_CONFIRMED: "NO_ADJUSTMENT_CONFIRMED",
  NO_ADJUSTMENT_PENDING_CONFIRMATION: "NO_ADJUSTMENT_PENDING_CONFIRMATION",
};

/** What the screen puts on the badge. Short; these are read on a phone. */
const ADJUSTMENT_STATE_LABEL = {
  [ADJUSTMENT_STATE.HAS_ADJUSTMENT]: "Has adjustment",
  [ADJUSTMENT_STATE.NO_ADJUSTMENT_CONFIRMED]: "No Adjustment - Confirmed",
  [ADJUSTMENT_STATE.NO_ADJUSTMENT_PENDING_CONFIRMATION]:
    "No Adjustment - Pending Confirmation",
};

/** How a stored amount got there. Recorded on every audit row. */
const CHANGE_SOURCE = {
  MANUAL: "MANUAL",
  IMPORT: "IMPORT",
};

/** The audit log's verbs. */
const AUDIT_ACTION = {
  SET_AMOUNT: "SET_AMOUNT",
  CLEAR_AMOUNT: "CLEAR_AMOUNT",
  SET_REMARKS: "SET_REMARKS",
  CONFIRM_NO_ADJUSTMENT: "CONFIRM_NO_ADJUSTMENT",
  REVOKE_NO_ADJUSTMENT: "REVOKE_NO_ADJUSTMENT",
};

/**
 * THE MOST ROWS ONE IMPORT MAY CARRY. The same ceiling
 * `usecase/employee_bulk_update.js` uses, for the same reason: a file larger
 * than this is a mistake or an export of something else, and refusing it with
 * a sentence is kinder than validating fifty thousand rows and timing out.
 */
const MAX_IMPORT_ROWS = 2000;

module.exports = {
  COMPONENT,
  COMPONENT_KIND,
  COMPONENTS,
  COMPONENT_KEYS,
  COMPONENT_BY_KEY,
  PAY_AFFECTING_COMPONENT_KEYS,
  isPayAffecting,
  REFERENCE_COLUMNS,
  REMARKS_COLUMN,
  REMARKS_MAX_LENGTH,
  ADJUSTMENT_STATE,
  ADJUSTMENT_STATE_LABEL,
  CHANGE_SOURCE,
  AUDIT_ACTION,
  MAX_IMPORT_ROWS,
};
