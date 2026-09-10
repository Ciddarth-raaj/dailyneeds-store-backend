/**
 * Stage 0C / C2 — comparing a name at a bank with a name on a record.
 *
 * The temptation is `a === b`. That is wrong often enough to be dangerous in
 * both directions: it rejects "R. Kumar" against "RAMESH KUMAR", and it would
 * happily pass two different people who happen to be spelled alike.
 *
 * Indian names as banks hold them differ from HR records in predictable ways:
 *
 *   case and spacing        "ramesh  kumar"  / "RAMESH KUMAR"
 *   initials                "R KUMAR"        / "Ramesh Kumar"
 *   expanded initials       "R. K. Sharma"   / "Ramesh Kumar Sharma"
 *   honorifics              "MR RAMESH KUMAR"
 *   surname order           "KUMAR RAMESH"
 *   punctuation             "D'Souza" / "DSOUZA", "Smith-Jones"
 *   missing middle name     "Ramesh Kumar"   / "Ramesh Prasad Kumar"
 *
 * So this returns a VERDICT, not a boolean, and the uncertain verdict is the
 * common one:
 *
 *   MATCH     the same person, as far as a name can say so
 *   REVIEW    plausibly the same person; a human should look
 *   MISMATCH  no meaningful overlap; do not present this as verified
 *
 * MISMATCH never becomes VERIFIED, not even by HR confirmation - if the bank
 * says the account belongs to someone else entirely, that is a different
 * account. REVIEW is exactly the case where HR is allowed to confirm.
 */

/** Titles and suffixes banks prepend; never part of the name itself. */
const HONORIFICS = new Set([
  "mr", "mrs", "ms", "miss", "dr", "shri", "smt", "sri", "kum", "md",
  "prof", "late", "m/s", "messrs",
]);

/**
 * Lower-cases, strips punctuation and honorifics, collapses whitespace.
 * "Mr. R.K. D'Souza-Nair" becomes ["r", "k", "dsouza", "nair"].
 */
function tokenise(name) {
  if (name === null || name === undefined) return [];
  return String(name)
    .toLowerCase()
    // An apostrophe joins ("d'souza" -> "dsouza"); a hyphen or dot separates.
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t !== "" && !HONORIFICS.has(t));
}

/** An initial is a single letter standing in for a whole name. */
const isInitial = (token) => token.length === 1;

/**
 * Does `a` account for `b`, allowing an initial to stand for a full word?
 * "r" covers "ramesh"; "ramesh" covers "ramesh"; "ramesh" does not cover "raj".
 */
function covers(a, b) {
  if (a === b) return true;
  if (isInitial(a) && b.startsWith(a)) return true;
  if (isInitial(b) && a.startsWith(b)) return true;
  return false;
}

/**
 * How many tokens of `needle` are accounted for somewhere in `haystack`,
 * each haystack token being usable once.
 */
function overlap(needle, haystack) {
  const pool = [...haystack];
  let found = 0;
  for (const token of needle) {
    const i = pool.findIndex((candidate) => covers(token, candidate));
    if (i >= 0) {
      pool.splice(i, 1);
      found += 1;
    }
  }
  return found;
}

/**
 * Compares two names, order-insensitively.
 *
 * The rule, in words: every token of the shorter name must be accounted for
 * in the longer one. If it is, and at least one of those matches was a whole
 * word rather than an initial, that is a MATCH - "R Kumar" against "Ramesh
 * Kumar" is the same person. If every match was an initial, or a token is
 * unaccounted for, it is REVIEW. If barely anything lines up, MISMATCH.
 */
function compareNames(a, b) {
  const left = tokenise(a);
  const right = tokenise(b);

  if (left.length === 0 || right.length === 0) {
    return { verdict: "REVIEW", reason: "one of the names is empty", score: 0 };
  }

  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  const matched = overlap(shorter, longer);
  const score = matched / shorter.length;

  // Was anything matched on a whole word, or only on single letters?
  const substantive = shorter.filter((t) => !isInitial(t));
  const substantiveMatched = overlap(substantive, longer);

  if (matched === shorter.length) {
    if (substantive.length > 0 && substantiveMatched === substantive.length) {
      // Every token accounted for, including every full word.
      const extra = longer.length - shorter.length;
      if (extra === 0) return { verdict: "MATCH", reason: "names agree", score: 1 };
      // A middle name present on one side only is ordinary.
      if (extra <= 2) {
        return { verdict: "MATCH", reason: `names agree; ${extra} extra name part(s)`, score: 1 };
      }
      return { verdict: "REVIEW", reason: "several extra name parts", score };
    }
    return { verdict: "REVIEW", reason: "matched only on initials", score };
  }

  if (score >= 0.5) {
    return { verdict: "REVIEW", reason: "names partially agree", score };
  }
  return { verdict: "MISMATCH", reason: "names do not agree", score };
}

/**
 * The bank's name against everything we hold - the employee record and, when
 * there is one, the verified Aadhaar name. The BEST verdict wins: a bank name
 * that matches the Aadhaar but not a shortened HR spelling is a match, and
 * the Aadhaar is the more authoritative of the two.
 */
function compareNameAtBank(nameAtBank, { employeeName = null, aadhaarName = null } = {}) {
  const candidates = [];
  if (employeeName) candidates.push({ source: "employee_name", ...compareNames(nameAtBank, employeeName) });
  if (aadhaarName) candidates.push({ source: "aadhaar_name", ...compareNames(nameAtBank, aadhaarName) });

  if (candidates.length === 0) {
    return { verdict: "REVIEW", reason: "no name to compare against", score: 0, compared: [] };
  }

  // Best verdict wins; on a tie the Aadhaar name is reported, because it is
  // the verified one and therefore the more authoritative of the two.
  const rank = { MATCH: 2, REVIEW: 1, MISMATCH: 0 };
  const weight = (c) => rank[c.verdict] * 2 + (c.source === "aadhaar_name" ? 1 : 0);
  const best = candidates.reduce((a, b) => (weight(b) > weight(a) ? b : a));
  return { verdict: best.verdict, reason: best.reason, score: best.score, matched_against: best.source, compared: candidates };
}

module.exports = { compareNames, compareNameAtBank, tokenise, HONORIFICS };
