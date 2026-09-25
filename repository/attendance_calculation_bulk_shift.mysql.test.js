/**
 * THE BULK SHIFT READERS, AS REAL SQL.
 *
 *   ATTENDANCE_TEST_MYSQL=mysql://user:pass@localhost/scratch_db \
 *     node --test repository/attendance_calculation_bulk_shift.mysql.test.js
 *
 * SKIPPED unless `ATTENDANCE_TEST_MYSQL` names a SCRATCH database: the suite
 * creates its three tables, fills them and drops them again.
 *
 * `getWorkShiftConfigsByIds` / `getWorkShiftSchedulesByIds` /
 * `getWorkShiftConfigVersionsByIds` replace, on the month read, three
 * sequential reads PER SHIFT. They must return, per shift, exactly the rows
 * the per-shift readers return - same columns, same formatting, same order.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

const URL = process.env.ATTENDANCE_TEST_MYSQL;
const buildRepo = require("./attendance_calculation");

const SCHEMA = [
  `CREATE TABLE work_shift (
     work_shift_id INT PRIMARY KEY, shift_code VARCHAR(20) NOT NULL, shift_name VARCHAR(150) NOT NULL,
     active TINYINT(1) NOT NULL DEFAULT 1,
     late_grace_minutes INT NOT NULL DEFAULT 0, late_deduction_interval_minutes INT NOT NULL DEFAULT 0,
     late_deduct_minutes INT NOT NULL DEFAULT 0, late_exclude_grace_from_deduction TINYINT(1) NOT NULL DEFAULT 0,
     late_offset_against_overtime TINYINT(1) NOT NULL DEFAULT 0,
     early_exit_grace_minutes INT NOT NULL DEFAULT 0, early_exit_deduction_interval_minutes INT NOT NULL DEFAULT 0,
     early_exit_deduct_minutes INT NOT NULL DEFAULT 0, early_exit_offset_against_overtime TINYINT(1) NOT NULL DEFAULT 0,
     overtime_allowed TINYINT(1) NOT NULL DEFAULT 0, overtime_minimum_minutes INT NOT NULL DEFAULT 0,
     overtime_rounding_method ENUM('NONE','UP','DOWN','NEAREST') NOT NULL DEFAULT 'NONE',
     overtime_rounding_interval_minutes INT NOT NULL DEFAULT 0,
     overtime_minimum_threshold_only TINYINT(1) NOT NULL DEFAULT 0, overtime_minimum_excluded TINYINT(1) NOT NULL DEFAULT 0,
     maximum_ot_minutes_per_day INT NULL,
     pre_shift_overtime_allowed TINYINT(1) NOT NULL DEFAULT 0, pre_shift_overtime_minimum_minutes INT NOT NULL DEFAULT 0,
     pre_shift_overtime_minimum_excluded TINYINT(1) NOT NULL DEFAULT 0,
     pre_shift_overtime_rounding_method ENUM('NONE','UP','DOWN','NEAREST') NOT NULL DEFAULT 'NONE',
     pre_shift_overtime_rounding_interval_minutes INT NOT NULL DEFAULT 0)`,
  `CREATE TABLE work_shift_weekly_schedule (
     work_shift_weekly_schedule_id INT AUTO_INCREMENT PRIMARY KEY, work_shift_id INT NOT NULL,
     day_of_week TINYINT NOT NULL, is_working_day TINYINT(1) NOT NULL DEFAULT 1,
     in_time TIME NULL, out_time TIME NULL, attendance_day_cutoff TIME NULL,
     break_minutes INT NOT NULL DEFAULT 0, normal_work_minutes INT NOT NULL DEFAULT 0, ot_rate DECIMAL(3,1) NULL,
     UNIQUE KEY uq (work_shift_id, day_of_week))`,
  `CREATE TABLE work_shift_config_version (
     work_shift_config_version_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, work_shift_id INT NOT NULL,
     effective_from DATE NOT NULL, config_hash CHAR(32) NULL, config_document JSON NOT NULL,
     source ENUM('MIGRATION_SEED','WORK_SHIFT_SAVE','CORRECTION') NOT NULL,
     KEY idx_wscv_shift_effective (work_shift_id, effective_from))`,
];
const TABLES = ["work_shift_config_version", "work_shift_weekly_schedule", "work_shift"];

describe("bulk shift readers against MySQL", { skip: !URL && "ATTENDANCE_TEST_MYSQL not set" }, () => {
  let mysql;
  let pool;
  let repo;
  const q = (sql, params) =>
    new Promise((resolve, reject) => pool.query(sql, params, (e, r) => (e ? reject(e) : resolve(r))));

  before(async () => {
    mysql = require("mysql");
    pool = mysql.createPool(`${URL}?connectionLimit=4&supportBigNumbers=true&bigNumberStrings=true`);
    for (const t of TABLES) await q(`DROP TABLE IF EXISTS ${t}`);
    for (const ddl of SCHEMA) await q(ddl);
    repo = buildRepo(pool);
    for (const [id, code, inT] of [[1, "GEN", "09:00:00"], [2, "LATE", "13:00:00"], [3, "EMPTY", "07:00:00"]]) {
      await q(
        `INSERT INTO work_shift (work_shift_id, shift_code, shift_name, overtime_allowed, late_grace_minutes, maximum_ot_minutes_per_day)
         VALUES (?,?,?,1,?,?)`,
        [id, code, `Shift ${code}`, id * 5, id === 2 ? 120 : null]
      );
      if (id === 3) continue; // a shift with no schedule rows
      // Inserted in reverse day order so ORDER BY is what is being tested.
      for (let dow = 6; dow >= 0; dow--) {
        await q(
          `INSERT INTO work_shift_weekly_schedule (work_shift_id, day_of_week, is_working_day, in_time, out_time, attendance_day_cutoff, break_minutes, normal_work_minutes, ot_rate)
           VALUES (?,?,?,?, ADDTIME(?, '09:00:00'), '04:00:00', 60, 480, 1.5)`,
          [id, dow, dow === 0 ? 0 : 1, inT, inT]
        );
      }
    }
    // Versions inserted out of date order, two sharing an effective date.
    for (const [sid, from] of [[1, "2026-06-01"], [1, "2026-01-01"], [2, "2026-03-01"], [1, "2026-06-01"], [4, "2026-01-01"]]) {
      await q(
        `INSERT INTO work_shift_config_version (work_shift_id, effective_from, config_hash, config_document, source)
         VALUES (?,?,?,?, 'WORK_SHIFT_SAVE')`,
        [sid, from, `h${sid}${from}`, JSON.stringify({ format: 1, config: { shift_code: `S${sid}` }, schedule: [] })]
      );
    }
  });

  after(async () => {
    if (!pool) return;
    for (const t of TABLES) await q(`DROP TABLE IF EXISTS ${t}`);
    pool.end();
  });

  it("returns, per shift, exactly what the per-shift readers return", async () => {
    const ids = [1, 2, 3, 4, 99]; // 4 has only versions; 99 does not exist
    const [configs, schedules, versions] = await Promise.all([
      repo.getWorkShiftConfigsByIds(ids),
      repo.getWorkShiftSchedulesByIds(ids),
      repo.getWorkShiftConfigVersionsByIds(ids),
    ]);
    for (const id of ids) {
      const single = await repo.getWorkShiftWithSchedule(id);
      const config = configs.filter((r) => Number(r.work_shift_id) === id);
      const schedule = schedules.filter((r) => Number(r.work_shift_id) === id);
      if (single === null) {
        assert.equal(config.length, 0, `shift ${id}`);
      } else {
        assert.deepEqual(config, [single.config], `config of ${id}`);
        assert.deepEqual(schedule, single.schedule, `schedule of ${id}`);
      }
      assert.deepEqual(
        versions.filter((r) => Number(r.work_shift_id) === id),
        await repo.getWorkShiftConfigVersions(id),
        `versions of ${id}`
      );
    }
  });

  it("reads nothing for an empty id list", async () => {
    assert.deepEqual(await repo.getWorkShiftConfigsByIds([]), []);
    assert.deepEqual(await repo.getWorkShiftSchedulesByIds([]), []);
    assert.deepEqual(await repo.getWorkShiftConfigVersionsByIds([]), []);
  });
});
