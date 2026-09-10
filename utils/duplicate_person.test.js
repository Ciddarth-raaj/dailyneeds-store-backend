/**
 * Stage 0C / C2 — the non-Aadhaar duplicate warning.
 *
 *   node --test utils/duplicate_person.test.js
 *
 * This is the check that runs when HR skips Aadhaar, and it has two failure
 * modes pulling opposite ways. Miss a returning employee and they get a second
 * employee_id, splitting their service history permanently. Cry wolf on every
 * "Ramesh Kumar" and HR learns to click through, which is worse than having no
 * check at all.
 *
 * So the cases below are mostly about WEIGHT: what is a coincidence, and what
 * is not.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  CONFIDENCE,
  normaliseContact,
  normaliseDob,
  searchableNameTokens,
  scoreCandidate,
  rankCandidates,
} = require("./duplicate_person");

const employee = (over = {}) => ({
  employee_id: 412,
  employee_name: "Ramesh Kumar",
  status: 1,
  dob: "1990-02-01",
  primary_contact_number: "9876543210",
  ...over,
});

const score = (input, candidate) => scoreCandidate(input, candidate);

describe("what counts as a strong signal", () => {
  it("an exact mobile number is HIGH, even under a different name", () => {
    const m = score(
      { employee_name: "R K Sharma", primary_contact_number: "9876543210" },
      employee()
    );
    assert.equal(m.confidence, CONFIDENCE.HIGH);
    assert.ok(m.matched_on.includes("mobile"));
  });

  it("and it matches through spacing, punctuation and a country code", () => {
    for (const typed of ["98765 43210", "+91-98765-43210", "091 9876543210", "9876543210"]) {
      const m = score({ employee_name: "Ramesh Kumar", primary_contact_number: typed }, employee());
      assert.equal(m && m.confidence, CONFIDENCE.HIGH, `"${typed}" should match`);
    }
  });

  it("name AND date of birth together is HIGH", () => {
    const m = score({ employee_name: "Ramesh Kumar", dob: "1990-02-01" }, employee());
    assert.equal(m.confidence, CONFIDENCE.HIGH);
    assert.deepEqual(m.matched_on.sort(), ["dob", "name"]);
  });

  it("dd-mm-yyyy and yyyy-mm-dd are the same date", () => {
    const m = score({ employee_name: "Ramesh Kumar", dob: "01-02-1990" }, employee());
    assert.equal(m.confidence, CONFIDENCE.HIGH);
  });
});

describe("what counts as weak, and stays weak", () => {
  it("a name alone is MEDIUM at best - never HIGH", () => {
    const m = score({ employee_name: "Ramesh Kumar" }, employee({ dob: null, primary_contact_number: null }));
    assert.equal(m.confidence, CONFIDENCE.MEDIUM);
    assert.notEqual(m.confidence, CONFIDENCE.HIGH);
  });

  it("a merely similar name is LOW", () => {
    const m = score({ employee_name: "Ramesh Sharma" }, employee({ dob: null, primary_contact_number: null }));
    assert.equal(m.confidence, CONFIDENCE.LOW);
  });

  it("a shared birthday and nothing else is not a match at all", () => {
    // One employee in 365 shares any given date. A list of them tells HR
    // nothing, so it is dropped rather than shown as a weak match.
    const m = score({ employee_name: "Priya Nair", dob: "1990-02-01" }, employee());
    assert.equal(m, null);
  });

  it("a different person on every field is not a match", () => {
    const m = score(
      { employee_name: "Priya Nair", dob: "1985-07-09", primary_contact_number: "9000000000" },
      employee()
    );
    assert.equal(m, null);
  });

  it("a short or missing mobile is ignored rather than matched loosely", () => {
    assert.equal(normaliseContact("123"), null);
    assert.equal(normaliseContact(null), null);
    assert.equal(normaliseContact(""), null);
  });

  it("an unparseable date is treated as absent, never guessed", () => {
    assert.equal(normaliseDob("sometime in 1990"), null);
    assert.equal(normaliseDob(""), null);
    assert.equal(normaliseDob(null), null);
    assert.equal(normaliseDob("1990-02-01"), "1990-02-01");
  });
});

describe("active and inactive are told apart, because the action differs", () => {
  it("an active match says review, and warns against a second record", () => {
    const m = score({ employee_name: "Ramesh Kumar", dob: "1990-02-01" }, employee({ status: 1 }));
    assert.equal(m.employment_status, "active");
    assert.equal(m.is_active, true);
    assert.equal(m.suggested_action, "review_already_employed");
    assert.match(m.message, /currently employed/);
  });

  it("an inactive match routes to Rejoin on the SAME employee_id", () => {
    const m = score(
      { employee_name: "Ramesh Kumar", dob: "1990-02-01" },
      employee({ status: 0, last_ended_on: "2024-05-31", latest_period_no: 1 })
    );
    assert.equal(m.employment_status, "inactive");
    assert.equal(m.suggested_action, "rejoin");
    assert.equal(m.last_ended_on, "2024-05-31");
    assert.match(m.message, /use Rejoin on that employee ID/);
    assert.equal(m.employee_id, 412, "and it names which one");
  });
});

describe("ranking", () => {
  it("strongest first, and inactive before active among equals", () => {
    const input = { employee_name: "Ramesh Kumar", dob: "1990-02-01", primary_contact_number: "9876543210" };
    const ranked = rankCandidates(input, [
      employee({ employee_id: 1, employee_name: "Ramesh Sharma", dob: null, primary_contact_number: null }), // LOW
      employee({ employee_id: 2, status: 1 }), // HIGH, active
      employee({ employee_id: 3, status: 0 }), // HIGH, inactive
    ]);
    assert.deepEqual(ranked.map((m) => m.employee_id), [3, 2, 1]);
    assert.equal(ranked[0].suggested_action, "rejoin", "the rejoinable one is first");
  });

  it("drops the candidates that turned out to be nothing", () => {
    const ranked = rankCandidates({ employee_name: "Ramesh Kumar" }, [
      employee({ employee_id: 5, employee_name: "Priya Nair", dob: null, primary_contact_number: null }),
    ]);
    assert.deepEqual(ranked, []);
  });

  it("survives an empty candidate list", () => {
    assert.deepEqual(rankCandidates({ employee_name: "X" }, []), []);
    assert.deepEqual(rankCandidates({ employee_name: "X" }, null), []);
  });
});

describe("the SQL net", () => {
  it("searches on distinctive name tokens only", () => {
    // Initials and two-letter fragments match half the workforce.
    assert.deepEqual(searchableNameTokens("Mr. R K Ramesh Kumar"), ["ramesh", "kumar"]);
    assert.deepEqual(searchableNameTokens("R K"), []);
    assert.deepEqual(searchableNameTokens(""), []);
  });
});
