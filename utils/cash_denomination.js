/**
 * Cash denominations - how many of each note / coin pay one whole-rupee amount.
 *
 * GREEDY, LARGEST FIRST. Indian currency (500, 200, 100, 50, 20, 10, 5, 2, 1)
 * is a canonical coin system, so taking as many of the largest denomination
 * as fit and carrying the remainder down gives the fewest pieces, and with a
 * ₹1 coin at the bottom every whole-rupee amount is reachable exactly.
 *
 * WHOLE RUPEES ONLY. Cash cannot be paid in paise, and this module does not
 * round: a fractional or negative amount is refused, never adjusted. Net pay
 * is already rounded to the rupee by the payroll calculation
 * (`utils/payrun_calculation.js#roundToRupeePaise`); a figure that is not a
 * whole rupee here is a payroll problem to fix there, not here.
 *
 * Pure: no database, no clock. Every result is checked to add back up to the
 * amount it came from before it is returned.
 */

const DENOMINATIONS = Object.freeze([500, 200, 100, 50, 20, 10, 5, 2, 1]);

class DenominationError extends Error {
  constructor(message) {
    super(message);
    this.name = "DenominationError";
  }
}

const isWholeRupees = (amount) => typeof amount === "number" && Number.isSafeInteger(amount) && amount >= 0;

/** The rupee value of a set of counts: Σ denomination × count. */
function valueOf(counts) {
  return DENOMINATIONS.reduce((sum, d) => sum + d * (Number(counts[d]) || 0), 0);
}

/**
 * The note / coin count for one amount, as `{ 500: n, 200: n, ..., 1: n }`.
 * Every denomination is present, zero where none is needed.
 */
function breakdown(amount) {
  if (!isWholeRupees(amount)) {
    throw new DenominationError(`Cash amount must be a whole, non-negative number of rupees (got ${amount})`);
  }
  const counts = {};
  let remainder = amount;
  for (const d of DENOMINATIONS) {
    counts[d] = Math.floor(remainder / d);
    remainder -= counts[d] * d;
  }
  if (remainder !== 0 || valueOf(counts) !== amount) {
    throw new DenominationError(`Denomination breakup of ${amount} does not reconcile`);
  }
  return counts;
}

/**
 * The total count of each denomination over many breakups, with its rupee
 * amount: `[{ denomination, count, amount }]` in denomination order.
 */
function totals(breakups) {
  return DENOMINATIONS.map((d) => {
    const count = breakups.reduce((sum, b) => sum + (Number(b[d]) || 0), 0);
    return { denomination: d, count, amount: count * d };
  });
}

module.exports = { DENOMINATIONS, DenominationError, isWholeRupees, breakdown, totals, valueOf };
