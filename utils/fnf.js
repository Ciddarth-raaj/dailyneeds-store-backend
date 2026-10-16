/**
 * FULL & FINAL SETTLEMENT - the pure rules.
 *
 * No database, no clock, no Express. Every function takes plain values and
 * returns plain values, for the reason `utils/payrun_eligibility.js` gives:
 * the rules that decide money have to be provable without MySQL.
 */
const { monthWindow } = require("./payrun_eligibility");
const {
  SETTLEMENT_STATUS,
  SETTLEMENT_STAGE,
  SETTLEMENT_STAGE_LABEL,
} = require("../constants/fnf");

/** `YYYY-MM-DD` or null. */
function dateOnly(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  const m = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/**
 * IS THIS THE EMPLOYEE'S F&F MONTH? True when the last working day falls
 * INSIDE the payroll month. An exit before the month means they are not in
 * its population at all; an exit after it means they were still working.
 *
 * THE DATE IS THE PAYRUN SNAPSHOT'S `resignation_date` - frozen at
 * initialization, and the same date `exitedByMonthEnd` and the calculation's
 * post-exit rules read - so the document type of a published month can never
 * disagree with the figures it carries.
 */
function isExitMonth({ year, month, resignation_date }) {
  const exit = dateOnly(resignation_date);
  if (!exit) return false;
  const { from, to } = monthWindow(Number(year), Number(month));
  return exit >= from && exit <= to;
}

/* -------------------------------------------------- amount in words */

const ONES = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen",
];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function belowHundred(n) {
  if (n < 20) return ONES[n];
  return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ""}`;
}

function belowThousand(n) {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  return [h ? `${ONES[h]} Hundred` : "", rest ? belowHundred(rest) : ""].filter(Boolean).join(" ");
}

/** A non-negative integer in Indian grouping words: crore, lakh, thousand. */
function integerInWords(value) {
  let n = Math.floor(Math.abs(Number(value) || 0));
  if (n === 0) return "Zero";
  const parts = [];
  const crore = Math.floor(n / 10000000);
  n %= 10000000;
  const lakh = Math.floor(n / 100000);
  n %= 100000;
  const thousand = Math.floor(n / 1000);
  n %= 1000;
  if (crore) parts.push(`${integerInWords(crore)} Crore`);
  if (lakh) parts.push(`${belowHundred(lakh)} Lakh`);
  if (thousand) parts.push(`${belowHundred(thousand)} Thousand`);
  if (n) parts.push(belowThousand(n));
  return parts.join(" ");
}

/**
 * "5031.00" -> "Five Thousand Thirty One Rupees Only". Paise, when any, are
 * spelled too. The SIGN IS NOT SPELLED: a negative F&F is printed as an
 * amount recoverable from the employee, and the caller says which.
 */
function amountInWords(amount) {
  if (amount === null || amount === undefined || amount === "") return null;
  const text = String(amount).replace("-", "");
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const [whole, frac = "0"] = text.split(".");
  const paise = Number(frac.padEnd(2, "0").slice(0, 2));
  const rupees = `${integerInWords(Number(whole))} Rupees`;
  return paise > 0 ? `${rupees} and ${belowHundred(paise)} Paise Only` : `${rupees} Only`;
}

/* -------------------------------------------- the settlement stage */

/**
 * WHERE AN EXIT'S F&F IS, for a screen. Derived from the payroll's own state
 * and the stored settlement status on every read; never stored.
 *
 *   SETTLED        HR recorded the payment (stored status)
 *   PUBLISHED      the F&F document is published
 *   APPROVED       the exit month is approved & locked
 *   IN_PAYROLL     the exit month is initialized (calculated or not)
 *   NOT_IN_PAYROLL no payrun row for the exit month yet
 */
function settlementStage({ settlement_status = null, initialized = false, calc_status = null } = {}) {
  let stage;
  if (settlement_status === SETTLEMENT_STATUS.SETTLED) stage = SETTLEMENT_STAGE.SETTLED;
  else if (calc_status === "PUBLISHED") stage = SETTLEMENT_STAGE.PUBLISHED;
  else if (calc_status === "APPROVED_LOCKED") stage = SETTLEMENT_STAGE.APPROVED;
  else if (initialized) stage = SETTLEMENT_STAGE.IN_PAYROLL;
  else stage = SETTLEMENT_STAGE.NOT_IN_PAYROLL;
  return { stage, stage_label: SETTLEMENT_STAGE_LABEL[stage] };
}

module.exports = {
  dateOnly,
  isExitMonth,
  integerInWords,
  amountInWords,
  settlementStage,
};
