const { compareNames, tokenise } = require("./name_match");

/**
 * Stage 0C / C2 — "have we got this person already?", without an Aadhaar.
 *
 * A verified Aadhaar answers this exactly: the fingerprint is unique, so the
 * same person cannot become two employee_ids. When HR skips Aadhaar, nothing
 * answers it exactly, and the failure this exists to prevent is the expensive
 * one: a returning employee gets a second employee_id, and their service
 * history splits in two permanently.
 *
 * SO THIS IS A WARNING, NOT A GATE. It never merges, never rejoins, and never
 * refuses a create. HR is shown who it found and decides. That is deliberate:
 * a name-based check that blocked would be wrong often - "Ramesh Kumar" is not
 * rare - and a check that cries wolf gets clicked through, which is worse than
 * no check at all.
 *
 * WEIGHTING. What matters is how much of a coincidence the match would be:
 *
 *   HIGH    exact mobile number, or a matching name AND date of birth.
 *           Two people sharing a mobile number is possible but worth a look;
 *           sharing a name and a birth date is not a coincidence.
 *   MEDIUM  a matching date of birth with a name that nearly agrees, or a
 *           name that matches exactly where no other field is available.
 *   LOW     a name alone, loosely. Shown, ranked last, and never dressed up
 *           as more than it is.
 *
 * A date of birth ALONE is not a match at all: roughly one employee in 365
 * shares any given birthday, and a list of them tells HR nothing.
 */

const CONFIDENCE = { HIGH: "high", MEDIUM: "medium", LOW: "low" };
const RANK = { high: 3, medium: 2, low: 1 };

/** Digits only, so "98765 43210" and "+91-98765-43210" compare equal. */
function normaliseContact(value) {
  if (value === null || value === undefined) return null;
  const digits = String(value).replace(/\D/g, "");
  if (digits.length < 10) return null;
  // Indian mobiles are ten digits; a stored country code should not stop two
  // spellings of the same number from matching.
  return digits.slice(-10);
}

/** YYYY-MM-DD, or nothing. Anything ambiguous is treated as absent. */
function normaliseDob(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const t = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = t.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/**
 * Name tokens worth searching on: the distinctive ones. Single letters are
 * initials and match half the workforce; very short tokens are noise.
 */
function searchableNameTokens(name) {
  return tokenise(name).filter((t) => t.length >= 3);
}

/**
 * Scores ONE candidate against what HR typed.
 *
 * Returns null when nothing meaningful lines up, so the caller can simply
 * filter - a candidate the SQL net caught but that turns out to share only a
 * birthday should not be shown at all.
 */
function scoreCandidate(input, candidate) {
  const matchedOn = [];

  const inputContact = normaliseContact(input.primary_contact_number);
  const candidateContact = normaliseContact(candidate.primary_contact_number);
  const contactMatch = Boolean(inputContact && candidateContact && inputContact === candidateContact);
  if (contactMatch) matchedOn.push("mobile");

  const inputDob = normaliseDob(input.dob);
  const candidateDob = normaliseDob(candidate.dob);
  const dobMatch = Boolean(inputDob && candidateDob && inputDob === candidateDob);
  if (dobMatch) matchedOn.push("dob");

  const nameComparison =
    input.employee_name && candidate.employee_name
      ? compareNames(input.employee_name, candidate.employee_name)
      : { verdict: "REVIEW", reason: "no name to compare", score: 0 };
  const nameMatch = nameComparison.verdict === "MATCH";
  const nameNear = nameComparison.verdict === "REVIEW" && nameComparison.score >= 0.5;
  if (nameMatch || nameNear) matchedOn.push("name");

  let confidence = null;
  let reason = "";

  if (contactMatch) {
    confidence = CONFIDENCE.HIGH;
    reason = nameMatch
      ? "the same mobile number and the same name"
      : "the same mobile number";
  } else if (nameMatch && dobMatch) {
    confidence = CONFIDENCE.HIGH;
    reason = "the same name and the same date of birth";
  } else if (nameNear && dobMatch) {
    confidence = CONFIDENCE.MEDIUM;
    reason = "a similar name and the same date of birth";
  } else if (nameMatch) {
    confidence = CONFIDENCE.MEDIUM;
    reason = "the same name";
  } else if (nameNear) {
    confidence = CONFIDENCE.LOW;
    reason = "a similar name";
  } else {
    // A shared birthday and nothing else is a coincidence, not a person.
    return null;
  }

  const active = Number(candidate.status) === 1;
  return {
    employee_id: candidate.employee_id,
    employee_name: candidate.employee_name,
    employment_status: active ? "active" : "inactive",
    is_active: active,
    confidence,
    matched_on: matchedOn,
    reason,
    name_match_score: Number(nameComparison.score.toFixed(3)),
    designation_name: candidate.designation_name || null,
    outlet_nickname: candidate.outlet_nickname || null,
    latest_period_no: candidate.latest_period_no === undefined ? null : candidate.latest_period_no,
    latest_period_state: candidate.latest_period_state || null,
    last_ended_on: candidate.last_ended_on || null,
    // The whole reason this exists: an inactive match is a Rejoin, not a
    // second employee_id.
    suggested_action: active ? "review_already_employed" : "rejoin",
    message: active
      ? `Employee ${candidate.employee_id} is currently employed and matches on ${matchedOn.join(" and ")}. ` +
        "Check this is not the same person before creating a second employee ID."
      : `Employee ${candidate.employee_id} has left and matches on ${matchedOn.join(" and ")}. ` +
        "If this is the same person, use Rejoin on that employee ID rather than creating a new one.",
  };
}

/**
 * Scores every candidate, drops the ones that turned out to be nothing, and
 * orders by how much attention each deserves: strongest first, and among
 * equals the inactive ones first, because those are the ones with a Rejoin
 * waiting behind them.
 */
function rankCandidates(input, candidates) {
  return (candidates || [])
    .map((c) => scoreCandidate(input, c))
    .filter((m) => m !== null)
    .sort((a, b) => {
      if (RANK[b.confidence] !== RANK[a.confidence]) return RANK[b.confidence] - RANK[a.confidence];
      if (a.is_active !== b.is_active) return a.is_active ? 1 : -1;
      return a.employee_id - b.employee_id;
    });
}

module.exports = {
  CONFIDENCE,
  normaliseContact,
  normaliseDob,
  searchableNameTokens,
  scoreCandidate,
  rankCandidates,
};
