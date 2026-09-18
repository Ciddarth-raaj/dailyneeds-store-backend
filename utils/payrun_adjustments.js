const {
  COMPONENT,
  COMPONENT_KIND,
  COMPONENTS,
  COMPONENT_KEYS,
  COMPONENT_BY_KEY,
  ADJUSTMENT_STATE,
  REMARKS_MAX_LENGTH,
} = require("../constants/payrun_adjustments");

/**
 * Payrun Adjustments V1 - every rule, and all of them pure.
 *
 * THE SAME DIVISION `utils/payrun_eligibility.js` KEEPS. Nothing in this file
 * touches a database, a request or a clock. It takes plain objects and returns
 * plain objects, so every rule below is provable by `node --test` without a
 * MySQL connection - and a rule that needs a database to be exercised is a
 * rule that gets exercised once, by hand, in a browser.
 *
 * THIS FILE IS THE CALCULATION CONTRACT. It does NOT calculate a payslip, a
 * gross, a PF contribution or a net pay: that is the later calculation stage's
 * job and `utils/salary_engine.js`'s. What it does is state, in one place and
 * in code, exactly what the adjustments STAGE contributes to that calculation:
 *
 *   net pay delta = + Incentive + Bonus + Arrears
 *                   - Advance Recovery - Shortage Recovery
 *
 *   pf wage delta  = 0, always
 *   esi wage delta = 0, always
 *   gross delta    = 0 - an adjustment is not a change to what somebody earns
 *   Balance Advance contributes NOTHING to any of the above
 *
 * WHY THE CONTRACT EXISTS BEFORE THE ENGINE THAT CONSUMES IT. The alternative
 * is that the calculation stage, whenever it is built, reads six component
 * rows and decides for itself which ones are additions - which is the same
 * decision made a second time, in a second place, by somebody who was not in
 * the room for it. `computeContract` is what that stage will call, and the
 * tests below it are what stop its answer changing quietly.
 *
 * MONEY IS HANDLED IN INTEGER PAISE INTERNALLY. Adding 0.1 and 0.2 in
 * floating point gives 0.30000000000000004, and a payroll total built by
 * adding six such numbers across six hundred employees drifts by rupees. Every
 * amount is parsed to paise, summed as integers, and divided once at the end.
 */

/* ======================================================= reading an amount */

/**
 * ONE CELL, TURNED INTO AN AMOUNT OR INTO A REFUSAL.
 *
 * THE SHAPE IS `{ status, ... }` RATHER THAN A THROW, because this is called
 * once per cell per row of a spreadsheet and every refusal has to arrive on
 * the preview beside its row number. An exception would stop at the first bad
 * cell, and the person would fix one typo per upload.
 *
 * WHAT IS ACCEPTED, AND WHY EACH:
 *
 *   blank / null / ""   NO VALUE for this component. Not zero-that-was-typed,
 *                       not a confirmation of anything - simply nothing said.
 *   0, "0", "0.00"      ALSO no value, and this is the rule the specification
 *                       names explicitly. A zero incentive and an empty
 *                       incentive cell are the same statement, so neither
 *                       stores a row; storing a 0.00 component would put a
 *                       meaningless line on a payslip.
 *   "1,250.50"          thousands separators, because every Indian
 *                       spreadsheet has them and refusing them would mean
 *                       refusing most real files
 *   "₹1,250" / "1250 "  a currency symbol or whitespace somebody pasted in
 *   1250.5 (a number)   Excel gives numbers as numbers
 *
 * WHAT IS REFUSED:
 *
 *   a negative number   the SIGN IS THE COMPONENT'S JOB. "Advance Recovery
 *                       500" already means 500 comes off; "-500" would mean
 *                       either the same thing or its opposite depending on who
 *                       is reading, and a payroll figure that depends on that
 *                       is not a figure.
 *   "abc", "1.2.3"      not a number
 *   "1e5"               deliberately refused. It parses as 100000 and nobody
 *                       typing an incentive means that; it is the signature of
 *                       a cell that was mangled, and a hundred thousand rupee
 *                       silent success is the worst possible outcome.
 *   more than 2 decimals a rupee has two paise digits. Rounding somebody's
 *                       pay silently is not this layer's decision to make.
 */
function parseAmount(raw) {
  if (raw === null || raw === undefined) return { status: "EMPTY" };
  if (typeof raw === "boolean") return { status: "INVALID" };

  let text;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return { status: "INVALID" };
    text = String(raw);
  } else {
    text = String(raw).trim();
  }
  if (text === "") return { status: "EMPTY" };

  // A currency symbol, spaces and thousands separators are noise around the
  // number, not part of it. Everything else must be the number itself.
  const cleaned = text.replace(/[₹,\s]/g, "");
  if (cleaned === "") return { status: "EMPTY" };

  if (/^-/.test(cleaned)) return { status: "NEGATIVE" };
  if (!/^\+?\d+(\.\d+)?$/.test(cleaned)) return { status: "INVALID" };

  const unsigned = cleaned.replace(/^\+/, "");
  const [whole, fraction = ""] = unsigned.split(".");
  if (fraction.length > 2) return { status: "TOO_PRECISE" };
  if (whole.length > 9) return { status: "TOO_LARGE" };

  const paise = Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
  if (!Number.isSafeInteger(paise)) return { status: "TOO_LARGE" };

  // ZERO IS NOT A VALUE. See the note above - this is where "0 means no value"
  // is decided, once, for the importer and the manual editor alike.
  if (paise === 0) return { status: "EMPTY" };

  return { status: "OK", paise, amount: paise / 100 };
}

/** Paise back to the two-decimal string a DECIMAL(12,2) column takes. */
function toAmount(paise) {
  return Number((paise / 100).toFixed(2));
}

/** The refusal sentence for a cell, in the words the person needs. */
function amountError(label, status, raw) {
  const shown = raw === null || raw === undefined ? "" : String(raw).trim();
  switch (status) {
    case "NEGATIVE":
      return `${label} '${shown}' is negative. Enter the amount as a positive number - a recovery is already a deduction.`;
    case "TOO_PRECISE":
      return `${label} '${shown}' has more than two decimal places.`;
    case "TOO_LARGE":
      return `${label} '${shown}' is too large to be a monthly adjustment.`;
    default:
      return `${label} '${shown}' is not an amount.`;
  }
}

/* =================================================== the calculation contract */

/**
 * WHAT THE ADJUSTMENTS STAGE CONTRIBUTES TO A MONTH'S CALCULATION.
 *
 * THE ONE FUNCTION THE LATER CALCULATION STAGE CALLS. It takes this employee's
 * stored component amounts - in any order, with any of the six present or
 * absent - and returns the deltas. It does not know what their gross is, what
 * they earned, or what their PF wage would be, and it must not: an adjustment
 * is a delta, and a function that knew the base would eventually be asked to
 * apply it.
 *
 * THE SUMS ARE IN PAISE, and `additions`, `deductions` and the rest are
 * rupees, rounded once at the end. Summing rupees as floats and rounding at
 * the end is the same arithmetic done badly.
 *
 * `pf_wage_delta` AND `esi_wage_delta` ARE COMPUTED, NOT HARD-CODED TO ZERO.
 * They sum only the components whose catalogue entry says `pf: true` /
 * `esi: true`, of which V1 has none - so today they are always 0, and a test
 * asserts exactly that. Writing `return 0` would have been shorter and would
 * have silently ignored the flags the day a seventh component set one.
 *
 * BALANCE ADVANCE REACHES NOTHING BUT `informational`. It is INFORMATIONAL, so
 * it is not an addition and not a deduction; the switch below has no branch
 * that could add it to a total, which is stronger than remembering not to.
 */
function computeContract(amountsByComponent = {}) {
  let additions = 0;
  let deductions = 0;
  let informational = 0;
  let pf = 0;
  let esi = 0;

  const byComponent = {};

  COMPONENT_KEYS.forEach((key) => {
    const parsed = parseAmount(amountsByComponent[key]);
    const paise = parsed.status === "OK" ? parsed.paise : 0;
    byComponent[key] = toAmount(paise);
    if (paise === 0) return;

    const spec = COMPONENT_BY_KEY[key];
    if (spec.kind === COMPONENT_KIND.ADDITION) additions += paise;
    else if (spec.kind === COMPONENT_KIND.DEDUCTION) deductions += paise;
    else informational += paise;

    /*
     * THE STATUTORY DELTAS FOLLOW THE FLAGS, AND ONLY AN ADDITION COULD EVER
     * MOVE THEM. A deduction that reduced a PF wage would be reducing an
     * employee's own pension over an advance repayment; an informational
     * figure that moved one would be worse, since nothing on any screen says
     * it is a figure at all. So the guard is on the KIND as well as the flag,
     * and both have to agree before a rupee reaches a statutory base.
     */
    if (spec.kind === COMPONENT_KIND.ADDITION) {
      if (spec.pf) pf += paise;
      if (spec.esi) esi += paise;
    }
  });

  return {
    by_component: byComponent,
    additions: toAmount(additions),
    deductions: toAmount(deductions),
    informational: toAmount(informational),
    /** + Incentive + Bonus + Arrears - Advance Recovery - Shortage Recovery */
    net_pay_delta: toAmount(additions - deductions),
    /**
     * ZERO IN V1, BY CONSTRUCTION. An adjustment is not a change to what
     * somebody EARNED, so the month's gross and earned gross are untouched by
     * this stage; the calculation stage adds `net_pay_delta` after them.
     */
    gross_delta: 0,
    earned_gross_delta: 0,
    pf_wage_delta: toAmount(pf),
    esi_wage_delta: toAmount(esi),
    has_adjustment: additions + deductions + informational > 0,
  };
}

/* ============================================================== the state */

/**
 * WHICH OF THE THREE STATES ONE INITIALIZED EMPLOYEE IS IN.
 *
 * THE ORDER IS THE RULE, and it is the transition the specification asks to be
 * defined explicitly: an adjustment BEATS a confirmation. Somebody confirmed
 * as having none who is later given an Incentive is HAS_ADJUSTMENT from that
 * moment, whatever a stale flag says. The repository also clears the flag in
 * the same transaction as the write - belt and braces, deliberately, because
 * these two facts living in two tables is exactly the situation where they
 * drift.
 *
 * AND THE FALL-THROUGH IS PENDING, WHICH IS WHY NEW EMPLOYEES NEED NO JOB.
 * An employee initialized five minutes ago has no component rows and no
 * confirmation row, so they land on the last line below. There is no backfill,
 * no nightly task and no "open the adjustments stage" event that has to have
 * happened: the population is read fresh, and anybody in it who has not been
 * dealt with is pending by arithmetic.
 */
function deriveState({ amounts = {}, confirmed_no_adjustment = false } = {}) {
  const contract = computeContract(amounts);
  if (contract.has_adjustment) return ADJUSTMENT_STATE.HAS_ADJUSTMENT;
  if (confirmed_no_adjustment === true) return ADJUSTMENT_STATE.NO_ADJUSTMENT_CONFIRMED;
  return ADJUSTMENT_STATE.NO_ADJUSTMENT_PENDING_CONFIRMATION;
}

/**
 * THE MONTH'S COMPLETION, COUNTED OVER THE CURRENT INITIALIZED POPULATION.
 *
 * `initialized_count` IS THE LENGTH OF WHAT WAS PASSED IN, and what is passed
 * in is read from `payrun_employee` at the moment of the request. It is never
 * a stored total, never a count taken when somebody exported a template, and
 * never the number of rows in an uploaded file. That is the whole of the
 * dynamic-population requirement: 220 finished plus 3 newly initialized is
 * 223 initialized and 3 pending, without anything being re-opened.
 *
 * `is_complete` IS `pending == 0`, AND IT IS REPORTED, NOT ENFORCED. This will
 * later be a prerequisite of payrun finalization; finalization is not built
 * here, so nothing consumes it yet and this function deliberately does not
 * pretend to gate anything.
 */
function summarizeStates(rows = []) {
  const summary = {
    initialized_count: rows.length,
    has_adjustment_count: 0,
    no_adjustment_confirmed_count: 0,
    pending_adjustment_confirmation_count: 0,
  };
  rows.forEach((row) => {
    if (row.adjustment_state === ADJUSTMENT_STATE.HAS_ADJUSTMENT) summary.has_adjustment_count += 1;
    else if (row.adjustment_state === ADJUSTMENT_STATE.NO_ADJUSTMENT_CONFIRMED) {
      summary.no_adjustment_confirmed_count += 1;
    } else summary.pending_adjustment_confirmation_count += 1;
  });
  summary.completed_count =
    summary.has_adjustment_count + summary.no_adjustment_confirmed_count;
  summary.is_complete = summary.pending_adjustment_confirmation_count === 0;
  return summary;
}

/* ============================================================ the template */

/**
 * THE EXPORT TEMPLATE'S COLUMNS, in the order the specification fixes them:
 * the three reference columns, the six components, then Remarks.
 *
 * ONE EMPLOYEE PER ROW AND ONE COMPONENT PER COLUMN, which is the shape of the
 * question being asked. A row per employee-component - six rows per person,
 * two hundred employees, twelve hundred rows - is a file nobody can read,
 * sort or total, and the first thing anybody would do with it is pivot it back
 * into this shape by hand.
 */
function templateColumns() {
  return [
    { key: "employee_id", label: "Employee ID", kind: "reference" },
    { key: "employee_name", label: "Employee Name", kind: "reference" },
    { key: "location", label: "Location", kind: "reference" },
    ...COMPONENTS.map((c) => ({
      key: c.key,
      label: c.label,
      kind: "amount",
      component_kind: c.kind,
      pf: c.pf,
      esi: c.esi,
      help: c.help,
    })),
    { key: "remarks", label: "Remarks", kind: "text" },
  ];
}

/** Header labels compared without case, spacing or punctuation getting in the way. */
function normalizeHeader(label) {
  return String(label === null || label === undefined ? "" : label)
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ");
}

/**
 * READ AN UPLOADED FILE'S HEADER ROW.
 *
 * THE RULE ON UNKNOWN COLUMNS IS THE STRICTEST ONE HERE, and the specification
 * demands it: a column this feature does not own must NEVER silently create a
 * payroll component. Two ways to honour that were available - ignore the
 * column, or refuse the file - and refusing is the right one. An ignored
 * "Loan Recovery" column is a person who typed recoveries into two hundred
 * rows, saw "200 rows imported", and will find out in a month that none of it
 * was stored. A refusal that names the column is a two-minute fix.
 *
 * EMPLOYEE ID IS THE ONLY REQUIRED COLUMN. Name and Location are reference
 * columns; a file without them is harder to read but not ambiguous, and the
 * component columns are optional because an import that only carries Incentive
 * is a perfectly ordinary thing to do.
 *
 * A REPEATED COLUMN IS REFUSED. Two "Bonus" columns is a file where the answer
 * depends on which one the parser happened to keep.
 */
function readHeader(headers = []) {
  const wanted = new Map();
  templateColumns().forEach((c) => wanted.set(normalizeHeader(c.label), c));

  const seen = new Map();
  const unknown = [];
  const duplicated = [];

  headers.forEach((raw) => {
    const label = normalizeHeader(raw);
    if (label === "") return;
    const column = wanted.get(label);
    if (!column) {
      if (!unknown.includes(String(raw).trim())) unknown.push(String(raw).trim());
      return;
    }
    if (seen.has(column.key)) {
      if (!duplicated.includes(column.label)) duplicated.push(column.label);
      return;
    }
    seen.set(column.key, { ...column, header: String(raw) });
  });

  return {
    columns: [...seen.values()],
    componentColumns: [...seen.values()].filter((c) => c.kind === "amount"),
    hasEmployeeId: seen.has("employee_id"),
    hasRemarks: seen.has("remarks"),
    unknown,
    duplicated,
  };
}

/** A cell out of a parsed row, found by the header label however it was spelled. */
function cellOf(row, header) {
  if (!row || typeof row !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(row, header)) return row[header];
  const wanted = normalizeHeader(header);
  const key = Object.keys(row).find((k) => normalizeHeader(k) === wanted);
  return key === undefined ? undefined : row[key];
}

/** An employee id out of a cell, or null. Excel gives "1234" and 1234 alike. */
function parseEmployeeId(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (text === "") return null;
  if (!/^\d+$/.test(text.replace(/\.0+$/, ""))) return null;
  const n = Number(text.replace(/\.0+$/, ""));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Remarks, trimmed and bounded. Empty becomes null - "" is not a remark. */
function parseRemarks(raw) {
  if (raw === null || raw === undefined) return { status: "OK", value: null };
  const text = String(raw).trim();
  if (text === "") return { status: "OK", value: null };
  if (text.length > REMARKS_MAX_LENGTH) {
    return { status: "TOO_LONG", value: null };
  }
  return { status: "OK", value: text };
}

/**
 * IS THIS ROW COMPLETELY EMPTY? A spreadsheet that has been scrolled through
 * carries trailing rows of empty strings, and refusing a file because rows
 * 201-240 have no Employee ID would make every real export unusable.
 *
 * AN EMPTY ROW IS SKIPPED, NOT REPORTED AS INVALID, and it is emphatically NOT
 * a confirmation of anything: skipping a row says nothing about the employee
 * whose row it might have been, which is the same rule blank cells follow.
 */
function isEmptyRow(row, header) {
  return header.columns.every((column) => {
    const value = cellOf(row, column.header);
    return value === null || value === undefined || String(value).trim() === "";
  });
}

module.exports = {
  parseAmount,
  toAmount,
  amountError,
  computeContract,
  deriveState,
  summarizeStates,
  templateColumns,
  normalizeHeader,
  readHeader,
  cellOf,
  parseEmployeeId,
  parseRemarks,
  isEmptyRow,
  COMPONENT,
  COMPONENT_KIND,
};
