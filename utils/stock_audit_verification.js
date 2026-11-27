/**
 * Stock Audit - counting accuracy from INDEPENDENT RECOUNTS. Pure.
 *
 * WHAT IS COMPARED. The recount against the ORIGINAL PHYSICAL COUNT, carried
 * forward over the genuine stock movements between the two counts:
 *
 *     expected recount = original physical qty + net physical movement between the counts
 *
 *   original 100, 5 sold in between, recount 95 -> expected 95 -> MATCH:
 *   the original counter was right.
 *
 * System (book) stock is NEVER compared with physical stock to judge an
 * employee: no function here takes a book quantity. A genuine shortage that
 * the recount confirms is a match.
 *
 * WHEN IT CANNOT BE DECIDED, IT STAYS UNRESOLVED - never a match, never a
 * mismatch: either quantity missing, movements not available, a movement
 * too close to either count to place it before or after, or times out of
 * order. Unresolved recounts do not count toward the 5% sample.
 *
 * HOW RetailPilot RECORDS RECOUNTS IS NOT KNOWN YET (none performed by
 * 27 Nov 2026). This module takes recounts in a neutral shape; the adapter
 * from RetailPilot's tables is written once real recounts are inspected.
 */

const { compareTs, toUtc } = require("./stock_audit_queries");
const { DEFAULT_POLICY } = require("./stock_audit_policy");

const VERDICT = Object.freeze({
  MATCH: "MATCH",
  MISMATCH: "MISMATCH",
  UNRESOLVED: "UNRESOLVED",
  NOT_INDEPENDENT: "NOT_INDEPENDENT",
});

const UNRESOLVED_REASON = Object.freeze({
  ORIGINAL_QTY_MISSING: "ORIGINAL_QTY_MISSING",
  RECOUNT_QTY_MISSING: "RECOUNT_QTY_MISSING",
  TIMESTAMP_MISSING: "TIMESTAMP_MISSING",
  RECOUNT_BEFORE_ORIGINAL: "RECOUNT_BEFORE_ORIGINAL",
  MOVEMENTS_UNAVAILABLE: "MOVEMENTS_UNAVAILABLE",
  MOVEMENT_TIMING_AMBIGUOUS: "MOVEMENT_TIMING_AMBIGUOUS",
  MOVEMENT_QTY_MISSING: "MOVEMENT_QTY_MISSING",
});

const thousandths = (n) => Math.round(Number(n) * 1000);
const secondsBetween = (a, b) => Math.abs(Date.parse(toUtc(a).iso.slice(0, 23) + "Z") - Date.parse(toUtc(b).iso.slice(0, 23) + "Z")) / 1000;

/**
 * One recount of one article.
 *
 * @param original  { qty, at, user }   the original physical count (qty = counted, all batches)
 * @param recount   { qty, at, user }
 * @param movements [{ qty (signed), ts, action }] for that article, store and
 *                  location, or null when they could not be read
 * @returns { verdict, reason?, expectedQty?, netMovementQty?, independent }
 */
function verifyRecount({ original, recount, movements }, policy = DEFAULT_POLICY) {
  const e = policy.employee;
  const independent = Boolean(original && recount && original.user && recount.user && original.user !== recount.user);
  const out = (verdict, extra = {}) => ({ verdict, independent, ...extra });

  if (e.requireIndependentRecount && !independent) return out(VERDICT.NOT_INDEPENDENT);
  if (!original || original.qty == null || !Number.isFinite(Number(original.qty))) return out(VERDICT.UNRESOLVED, { reason: UNRESOLVED_REASON.ORIGINAL_QTY_MISSING });
  if (!recount || recount.qty == null || !Number.isFinite(Number(recount.qty))) return out(VERDICT.UNRESOLVED, { reason: UNRESOLVED_REASON.RECOUNT_QTY_MISSING });
  if (!original.at || !recount.at) return out(VERDICT.UNRESOLVED, { reason: UNRESOLVED_REASON.TIMESTAMP_MISSING });
  if (compareTs(recount.at, original.at) < 0) return out(VERDICT.UNRESOLVED, { reason: UNRESOLVED_REASON.RECOUNT_BEFORE_ORIGINAL });
  if (!Array.isArray(movements)) return out(VERDICT.UNRESOLVED, { reason: UNRESOLVED_REASON.MOVEMENTS_UNAVAILABLE });

  const exclude = new Set(e.movements.excludeActions);
  const window = e.movements.ambiguityWindowSeconds;
  let net = 0;
  for (const m of movements) {
    if (exclude.has(m.action)) continue;
    if (m.qty == null || !Number.isFinite(Number(m.qty))) return out(VERDICT.UNRESOLVED, { reason: UNRESOLVED_REASON.MOVEMENT_QTY_MISSING });
    if (secondsBetween(m.ts, original.at) <= window || secondsBetween(m.ts, recount.at) <= window) {
      return out(VERDICT.UNRESOLVED, { reason: UNRESOLVED_REASON.MOVEMENT_TIMING_AMBIGUOUS, movement: { ts: m.ts, action: m.action, qty: m.qty } });
    }
    if (compareTs(m.ts, original.at) > 0 && compareTs(m.ts, recount.at) < 0) net += thousandths(m.qty);
  }
  const expected = thousandths(original.qty) + net;
  const diff = Math.abs(thousandths(recount.qty) - expected);
  return out(diff <= thousandths(e.match.absQty) ? VERDICT.MATCH : VERDICT.MISMATCH, { expectedQty: expected / 1000, netMovementQty: net / 1000 });
}

/**
 * One article's verdict from all its recounts (each already verified).
 * Only independent recounts can decide; repeat recounts never add sample
 * coverage (one article = one sample) and can never erase an earlier
 * resolved mismatch.
 *
 * @param recounts [{ at, verdict, ... }] for ONE original count
 * @returns { verdict: MATCH | MISMATCH | UNRESOLVED | NONE, decidedBy?, recounts }
 */
function articleVerdict(recounts = [], policy = DEFAULT_POLICY) {
  const independent = recounts.filter((r) => r.verdict !== VERDICT.NOT_INDEPENDENT);
  if (!independent.length) return { verdict: "NONE", recounts: recounts.length };
  const ordered = [...independent].sort((a, b) => compareTs(a.at, b.at));
  const resolved = ordered.filter((r) => r.verdict === VERDICT.MATCH || r.verdict === VERDICT.MISMATCH);
  if (!resolved.length) return { verdict: VERDICT.UNRESOLVED, recounts: recounts.length };
  if (policy.employee.recountVerdict === "any_mismatch") {
    const bad = resolved.find((r) => r.verdict === VERDICT.MISMATCH);
    return { verdict: bad ? VERDICT.MISMATCH : VERDICT.MATCH, decidedBy: (bad || resolved[0]).ref || null, recounts: recounts.length };
  }
  return { verdict: resolved[0].verdict, decidedBy: resolved[0].ref || null, recounts: recounts.length };
}

/**
 * An employee's sample from their articles' verdicts.
 * @param auditedArticles unique articles they counted (the 5% base)
 * @param verdicts        [{ verdict }] one per UNIQUE article recounted
 */
function sampleOf(auditedArticles, verdicts, policy = DEFAULT_POLICY) {
  const verified = verdicts.filter((v) => v.verdict === VERDICT.MATCH || v.verdict === VERDICT.MISMATCH);
  const matched = verified.filter((v) => v.verdict === VERDICT.MATCH).length;
  const unresolved = verdicts.filter((v) => v.verdict === VERDICT.UNRESOLVED).length;
  const required = requiredSample(auditedArticles, policy);
  return { audited: auditedArticles, verified: verified.length, matched, unresolved, required, met: verified.length >= required && required > 0 };
}

/** At least minSamplePct of the employee's unique audited articles, rounded UP; at least 1. */
function requiredSample(uniqueArticles, policy = DEFAULT_POLICY) {
  const n = Number(uniqueArticles) || 0;
  if (n <= 0) return 0;
  return Math.max(1, Math.ceil((n * policy.employee.minSamplePct) / 100));
}

module.exports = { VERDICT, UNRESOLVED_REASON, verifyRecount, articleVerdict, sampleOf, requiredSample };
