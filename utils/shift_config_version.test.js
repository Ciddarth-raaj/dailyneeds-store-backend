/**
 * Attendance v2 review fix #2 - the Work Shift configuration version.
 *
 * What matters here is that a version document is a STABLE, order-independent
 * description of a shift: two processes that saw the same configuration must
 * produce the same fingerprint, and a document read back out of MySQL - whose
 * JSON key order and row order are its own business - must fingerprint the
 * same as the one Node built.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildConfigVersion,
  configVersionHash,
  resolveConfigVersionForDate,
  toShiftDefinition,
  normalizeTime,
} = require("../utils/shift_config_version");

const config = (overrides = {}) => ({
  shift_code: "GEN",
  overtime_allowed: 1,
  overtime_minimum_minutes: 30,
  overtime_rounding_method: "NEAREST",
  overtime_rounding_interval_minutes: 15,
  overtime_minimum_threshold_only: 0,
  maximum_ot_minutes_per_day: 120,
  pre_shift_overtime_allowed: 0,
  pre_shift_overtime_minimum_minutes: 0,
  pre_shift_overtime_rounding_method: "NONE",
  pre_shift_overtime_rounding_interval_minutes: 0,
  late_offset_against_overtime: 0,
  early_exit_offset_against_overtime: 0,
  ...overrides,
});

const schedule = (overrides = {}) =>
  Array.from({ length: 7 }, (_, day) => ({
    day_of_week: day,
    is_working_day: 1,
    in_time: "09:00:00",
    out_time: "21:00:00",
    attendance_day_cutoff: "04:00:00",
    break_minutes: 60,
    ot_rate: 1,
    ...overrides,
  }));

describe("building a version document", () => {
  it("keeps only the fields that can change a calculated number", () => {
    const doc = buildConfigVersion(
      config({ shift_name: "General", regularization_limit_per_month: 3, active: 1 }),
      schedule()
    );
    assert.ok(!("shift_name" in doc.config));
    assert.ok(!("regularization_limit_per_month" in doc.config));
    assert.ok(!("active" in doc.config));
    assert.equal(doc.config.overtime_minimum_minutes, 30);
    assert.equal(doc.schedule.length, 7);
  });

  it("normalizes MySQL's strings and tinyints into one canonical form", () => {
    const doc = buildConfigVersion(
      config({ overtime_allowed: "1", overtime_rounding_method: "nearest" }),
      [{ day_of_week: "3", is_working_day: "1", in_time: "09:00", break_minutes: "45", ot_rate: "1.5" }]
    );
    assert.equal(doc.config.overtime_allowed, 1);
    assert.equal(doc.config.overtime_rounding_method, "NEAREST");
    assert.equal(doc.schedule[0].day_of_week, 3);
    assert.equal(doc.schedule[0].in_time, "09:00:00");
    assert.equal(doc.schedule[0].break_minutes, 45);
    assert.equal(doc.schedule[0].ot_rate, 1.5);
  });

  it("sorts the week, so the row order a query happened to return cannot matter", () => {
    const shuffled = [...schedule()].reverse();
    assert.deepEqual(
      buildConfigVersion(config(), shuffled).schedule.map((r) => r.day_of_week),
      [0, 1, 2, 3, 4, 5, 6]
    );
  });

  it("formats a time however it arrives, and refuses an impossible one", () => {
    assert.equal(normalizeTime("9:5:00"), null, "minutes must be two digits");
    assert.equal(normalizeTime("09:05"), "09:05:00");
    assert.equal(normalizeTime("2026-09-14 09:05:00"), "09:05:00");
    assert.equal(normalizeTime("25:00:00"), null);
    assert.equal(normalizeTime(null), null);
  });
});

describe("the fingerprint", () => {
  it("is the same for the same configuration, however the rows were ordered", () => {
    const a = configVersionHash(buildConfigVersion(config(), schedule()));
    const b = configVersionHash(buildConfigVersion(config(), [...schedule()].reverse()));
    assert.equal(a, b);
  });

  it("is round-trip stable through JSON, which is how MySQL hands it back", () => {
    const doc = buildConfigVersion(config(), schedule());
    const reread = JSON.parse(JSON.stringify(doc));
    assert.equal(
      configVersionHash(buildConfigVersion(reread.config, reread.schedule)),
      configVersionHash(doc)
    );
  });

  it("changes when any rule that affects a number changes", () => {
    const base = configVersionHash(buildConfigVersion(config(), schedule()));
    [
      [config({ overtime_minimum_minutes: 45 }), schedule()],
      [config({ pre_shift_overtime_allowed: 1 }), schedule()],
      [config({ late_offset_against_overtime: 1 }), schedule()],
      [config({ maximum_ot_minutes_per_day: null }), schedule()],
      [config(), schedule({ break_minutes: 45 })],
      [config(), schedule({ attendance_day_cutoff: "06:00:00" })],
      [config(), schedule({ out_time: "22:00:00" })],
      [config(), schedule({ ot_rate: 2 })],
    ].forEach(([c, s], index) => {
      assert.notEqual(configVersionHash(buildConfigVersion(c, s)), base, `unhashed change ${index}`);
    });
  });

  it("does NOT change when something that cannot affect a number changes", () => {
    const base = configVersionHash(buildConfigVersion(config(), schedule()));
    const renamed = configVersionHash(
      buildConfigVersion(config({ shift_name: "Renamed General Shift" }), schedule())
    );
    assert.equal(renamed, base, "a typo fix in a shift name must not append a version");
  });
});

describe("resolving the version in force on a date", () => {
  const versions = [
    {
      work_shift_config_version_id: 1,
      effective_from: "2026-09-01",
      config_hash: "aaa",
      config_document: JSON.stringify(buildConfigVersion(config(), schedule())),
    },
    {
      work_shift_config_version_id: 2,
      effective_from: "2026-10-01",
      config_hash: "bbb",
      config_document: JSON.stringify(
        buildConfigVersion(config({ overtime_minimum_minutes: 90 }), schedule({ break_minutes: 45 }))
      ),
    },
  ];

  it("picks the greatest effective_from on or before the date", () => {
    assert.equal(resolveConfigVersionForDate(versions, "2026-09-20").work_shift_config_version_id, 1);
    assert.equal(resolveConfigVersionForDate(versions, "2026-10-01").work_shift_config_version_id, 2);
    assert.equal(resolveConfigVersionForDate(versions, "2026-12-31").work_shift_config_version_id, 2);
  });

  it("breaks a same-day tie on id, so a correction appended today wins", () => {
    const sameDay = [
      { work_shift_config_version_id: 5, effective_from: "2026-10-01", config_document: "{}" },
      { work_shift_config_version_id: 6, effective_from: "2026-10-01", config_document: "{}" },
    ];
    assert.equal(resolveConfigVersionForDate(sameDay, "2026-10-05").work_shift_config_version_id, 6);
  });

  it("answers null before the first version, so the caller can say so out loud", () => {
    assert.equal(resolveConfigVersionForDate(versions, "2026-08-31"), null);
    assert.equal(resolveConfigVersionForDate([], "2026-09-20"), null);
    assert.equal(resolveConfigVersionForDate(null, "2026-09-20"), null);
  });

  it("turns a version back into the {config, schedule} pair the resolver consumes", () => {
    const definition = toShiftDefinition(resolveConfigVersionForDate(versions, "2026-09-20"), 7);
    assert.equal(definition.config.work_shift_id, 7);
    assert.equal(definition.config.overtime_minimum_minutes, 30);
    assert.equal(definition.schedule.length, 7);
    assert.equal(definition.schedule[0].work_shift_id, 7);
    assert.equal(definition.config_version_id, 1);
    assert.equal(definition.from_live, false);
    // The live schedule row id is deliberately NOT quoted: that row may have
    // been edited since, and pointing at it would name configuration this
    // calculation did not use.
    assert.equal(definition.schedule[0].work_shift_weekly_schedule_id, null);
  });

  it("a later version is a different definition, and the earlier one is untouched", () => {
    const september = toShiftDefinition(resolveConfigVersionForDate(versions, "2026-09-20"), 7);
    const october = toShiftDefinition(resolveConfigVersionForDate(versions, "2026-10-20"), 7);
    assert.equal(september.config.overtime_minimum_minutes, 30);
    assert.equal(october.config.overtime_minimum_minutes, 90);
    assert.equal(september.schedule[0].break_minutes, 60);
    assert.equal(october.schedule[0].break_minutes, 45);
  });
});

describe("the lateness and early-out settings are versioned", () => {
  const { VERSIONED_CONFIG_COLUMNS } = require("../utils/shift_config_version");
  it("names every column the engine settles the shortage with", () => {
    [
      "late_grace_minutes",
      "late_deduction_interval_minutes",
      "late_deduct_minutes",
      "late_exclude_grace_from_deduction",
      "early_exit_grace_minutes",
      "early_exit_deduction_interval_minutes",
      "early_exit_deduct_minutes",
    ].forEach((c) => assert.ok(VERSIONED_CONFIG_COLUMNS.includes(c), c));
  });
  it("a changed grace is a changed version", () => {
    const a = buildConfigVersion(config({ late_grace_minutes: 0 }), schedule());
    const b = buildConfigVersion(config({ late_grace_minutes: 10 }), schedule());
    assert.notEqual(configVersionHash(a), configVersionHash(b));
    assert.equal(b.config.late_grace_minutes, 10);
    assert.equal(b.config.late_exclude_grace_from_deduction, 0);
  });
});
