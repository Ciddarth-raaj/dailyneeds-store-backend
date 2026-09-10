/**
 * The Biomax raw-attendance migration: what it creates, what it seeds, and -
 * above all - what it must never do.
 *
 *   node --test migrations/biomax_raw_attendance.test.js
 *
 * Proven against the SQL text, the way the other migration tests are. The
 * properties that matter:
 *
 *   - the raw punch table has the transport-dedup unique key, a VARCHAR
 *     user_id, a DATETIME io_time, and NO derived columns (D10);
 *   - everything derived lives in biomax_punch_derived, whose
 *     attendance_date is nullable (A3) and which has no FK to the schedule;
 *   - device location is effective-dated, never a column on the device;
 *   - the seven Cloud IDs are seeded VERBATIM (letter O and digit 0 both
 *     appear and must not be "corrected");
 *   - no existing table is ALTERed and no employee/shift/schedule row is
 *     written; the only writes outside the new tables are guarded
 *     permission inserts;
 *   - the six keys are declared; only the three READ keys are granted, only
 *     to HR EXECUTIVE by name;
 *   - no global cutoff setting exists (A1);
 *   - the down file removes exactly what the up file added.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const P = require("../constants/hr_permissions");

const dir = path.join(__dirname, "mysql/migrations/sqls");
const NAME = "20260911120000-biomax-raw-attendance";
const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
const stripComments = (sql) => sql.replace(/--[^\n]*/g, "");
const statements = (sql) =>
  stripComments(sql)
    .split(";")
    .map((s) => s.trim().replace(/\s+/g, " "))
    .filter(Boolean);

const TABLES = [
  "biomax_device",
  "biomax_device_assignment",
  "biomax_device_event",
  "biomax_punch",
  "biomax_punch_derived",
  "biomax_raw_request",
  "biomax_derivation_run",
  "biomax_derivation_change",
];

const KEYS = [
  P.VIEW_RAW_ATTENDANCE,
  P.EXPORT_RAW_ATTENDANCE,
  P.VIEW_ATTENDANCE_PUNCH_AUDIT,
  P.VIEW_BIOMAX_DEVICES,
  P.MANAGE_BIOMAX_DEVICES,
  P.REDERIVE_ATTENDANCE,
];

/** Cloud IDs exactly as the business supplied them. */
const DEVICES = {
  C26924B2E7351O35: "DN1",
  C2695C935328OB31: "DN2",
  C2695C9353290F31: "DN3",
  C26044C84F1A1D31: "DN4",
  AMDB24121401205: "DN5",
  C2695C56D30E1430: "WH",
  AMDB24121401307: "G2",
};

describe("up", () => {
  const raw = read(`${NAME}-up.sql`);
  const stmts = statements(raw);
  const creates = stmts.filter((s) => /^CREATE TABLE/.test(s));
  const tableOf = (name) => creates.find((s) => s.includes(`\`${name}\``));

  it("creates exactly the eight Biomax tables, each IF NOT EXISTS, InnoDB utf8mb4", () => {
    assert.equal(creates.length, TABLES.length);
    for (const t of TABLES) {
      const stmt = tableOf(t);
      assert.ok(stmt, `${t} is created`);
      assert.match(stmt, /^CREATE TABLE IF NOT EXISTS/);
      assert.match(stmt, /ENGINE=InnoDB DEFAULT CHARSET=utf8mb4/);
    }
  });

  it("never ALTERs, DROPs, UPDATEs or DELETEs anything", () => {
    for (const stmt of stmts) {
      assert.doesNotMatch(stmt, /^(ALTER|DROP|UPDATE|DELETE|TRUNCATE)/, stmt);
    }
  });

  it("writes only to the new tables and the two permission tables", () => {
    const inserts = stmts.filter((s) => /^INSERT INTO/.test(s));
    for (const stmt of inserts) {
      const target = /^INSERT INTO `([a-z_]+)`/.exec(stmt)[1];
      assert.ok(
        TABLES.includes(target) || target === "all_permissions" || target === "permissions",
        `unexpected insert target ${target}`
      );
    }
    for (const forbidden of ["new_employee", "work_shift", "work_shift_weekly_schedule", "outlets", "department"]) {
      assert.ok(
        !inserts.some((s) => s.startsWith(`INSERT INTO \`${forbidden}\``)),
        `${forbidden} is not written`
      );
    }
  });

  describe("biomax_punch (raw)", () => {
    const stmt = tableOf("biomax_punch");

    it("keys retransmission dedup on (dev_id, user_id, io_time_raw)", () => {
      assert.match(stmt, /UNIQUE KEY `uq_biomax_punch_retransmit` \(`dev_id`, `user_id`, `io_time_raw`\)/);
    });

    it("stores user_id as VARCHAR and io_time as DATETIME, with the raw string beside it", () => {
      assert.match(stmt, /`user_id` VARCHAR\(32\) NOT NULL/);
      assert.match(stmt, /`io_time_raw` CHAR\(14\) NOT NULL/);
      assert.match(stmt, /`io_time` DATETIME NOT NULL/);
    });

    it("carries no derived attendance columns and no foreign keys (D10, R7)", () => {
      assert.doesNotMatch(stmt, /attendance_date|employee_id|home_outlet|derivation/);
      assert.doesNotMatch(stmt, /FOREIGN KEY/);
    });

    it("retains the protocol fields and the verbatim JSON", () => {
      for (const col of ["verify_mode", "io_mode", "fk_bin_data_lib", "cmd_id", "blk_no", "blk_len", "body_len_prefix", "raw_json", "source_ip", "retransmit_count"]) {
        assert.ok(stmt.includes(`\`${col}\``), col);
      }
    });
  });

  describe("biomax_punch_derived (sidecar)", () => {
    const stmt = tableOf("biomax_punch_derived");

    it("is 1:1 with the raw row and holds the attendance date, nullable", () => {
      assert.match(stmt, /PRIMARY KEY \(`biomax_punch_id`\)/);
      assert.match(stmt, /`attendance_date` DATE NULL/);
      assert.match(stmt, /FOREIGN KEY \(`biomax_punch_id`\) REFERENCES `biomax_punch`/);
    });

    it("names exactly the five derivation statuses", () => {
      assert.match(stmt, /`derivation_status` ENUM\('OK','UNMATCHED','NO_SHIFT','NO_SCHEDULE_ROW','MISSING_CUTOFF'\) NOT NULL/);
    });

    it("snapshots identity, posting and the schedule row consulted, with no FK to them", () => {
      for (const col of ["employee_id", "home_outlet_id", "department_id", "work_shift_id", "work_shift_weekly_schedule_id", "cutoff_applied", "derivation_run_id"]) {
        assert.ok(stmt.includes(`\`${col}\``), col);
      }
      assert.doesNotMatch(stmt, /REFERENCES `(new_employee|work_shift|work_shift_weekly_schedule|outlets)`/);
    });
  });

  describe("devices", () => {
    it("keeps location and activity OFF the device row and in effective-dated periods", () => {
      const device = tableOf("biomax_device");
      assert.doesNotMatch(device, /outlet_id|`active`/);
      assert.match(device, /UNIQUE KEY `uq_biomax_device_dev_id` \(`dev_id`\)/);

      const period = tableOf("biomax_device_assignment");
      assert.match(period, /`effective_from` DATETIME NOT NULL/);
      assert.match(period, /`effective_to` DATETIME NULL/);
      assert.match(period, /REFERENCES `outlets` \(`outlet_id`\)/);
      assert.match(period, /CHECK \(`effective_to` IS NULL OR `effective_to` > `effective_from`\)/);
      // Several devices at one outlet: no unique key on outlet_id.
      assert.doesNotMatch(period, /UNIQUE KEY[^,]*outlet_id/);
    });

    it("seeds the seven Cloud IDs verbatim, each guarded", () => {
      const seed = stmts.find((s) => s.startsWith("INSERT INTO `biomax_device`"));
      for (const [devId, label] of Object.entries(DEVICES)) {
        assert.ok(seed.includes(`'${devId}'`), `${devId} seeded verbatim`);
        assert.ok(seed.includes(`'${label}'`), label);
      }
      assert.match(seed, /WHERE NOT EXISTS \(SELECT 1 FROM `biomax_device`/);
      // The two look-alike pairs are distinct devices; neither is normalised.
      assert.ok(seed.includes("C26924B2E7351O35") && seed.includes("C2695C935328OB31"));
      assert.ok(!seed.includes("C26924B2E7351035"), "letter O in DN1 not turned into zero");
    });

    it("assigns the two warehouse terminals to outlet_id 2 and the outlet-coded ones by outlet_code, from 2026-09-01", () => {
      const assigns = stmts.filter((s) => s.startsWith("INSERT INTO `biomax_device_assignment`"));
      assert.equal(assigns.length, 2);
      const coded = assigns.find((s) => s.includes("outlet_code"));
      const wh = assigns.find((s) => s.includes("o.`outlet_id` = 2"));
      assert.ok(coded && wh);
      for (const code of ["DN1", "DN2", "DN3", "DN4", "DN5"]) assert.ok(coded.includes(`'${code}'`), code);
      assert.ok(wh.includes("'C2695C56D30E1430'") && wh.includes("'AMDB24121401307'"));
      for (const s of assigns) {
        assert.ok(s.includes("'2026-09-01 00:00:00'"));
        assert.match(s, /NOT EXISTS \( SELECT 1 FROM `biomax_device_assignment`/);
      }
    });

    it("reports, and does not invent, devices whose outlet was not found", () => {
      const reports = stmts.filter((s) => /^SELECT/.test(s));
      assert.ok(reports.some((s) => s.includes("UNASSIGNED_SEEDED_DEVICE")));
    });
  });

  describe("permissions", () => {
    const declarations = stmts.filter((s) => /^INSERT INTO `all_permissions`/.test(s));
    const grants = stmts.filter((s) => /^INSERT INTO `permissions`/.test(s));

    it("declares all six keys, each guarded", () => {
      assert.equal(declarations.length, 6);
      for (const key of KEYS) {
        const stmt = declarations.find((s) => s.includes(`'${key}'`));
        assert.ok(stmt, `${key} declared`);
        assert.match(stmt, /WHERE NOT EXISTS \(SELECT 1 FROM `all_permissions`/);
      }
    });

    it("grants only the three read keys, only to HR EXECUTIVE by name", () => {
      assert.equal(grants.length, 1);
      const [grant] = grants;
      for (const key of [P.VIEW_RAW_ATTENDANCE, P.EXPORT_RAW_ATTENDANCE, P.VIEW_ATTENDANCE_PUNCH_AUDIT]) {
        assert.ok(grant.includes(`'${key}'`), key);
      }
      for (const key of [P.VIEW_BIOMAX_DEVICES, P.MANAGE_BIOMAX_DEVICES, P.REDERIVE_ATTENDANCE]) {
        assert.ok(!grant.includes(`'${key}'`), `${key} is NOT granted`);
      }
      assert.match(grant, /UPPER\(TRIM\(`designation_name`\)\) = 'HR EXECUTIVE'/);
      assert.doesNotMatch(grant, /`permission_key` = '(view_shift|add_shifts|add_employees)'/);
    });
  });

  it("creates no global cutoff setting (A1) and only reports schedule rows lacking one", () => {
    assert.doesNotMatch(raw, /attendance_setting/);
    const report = stmts.find((s) => s.includes("WORKING_ROW_WITHOUT_CUTOFF"));
    assert.ok(report);
    assert.match(report, /^SELECT/);
    assert.match(report, /s\.`is_working_day` = 1 AND s\.`attendance_day_cutoff` IS NULL/);
  });
});

describe("down", () => {
  const stmts = statements(read(`${NAME}-down.sql`));

  it("drops exactly the eight tables, children first", () => {
    const drops = stmts.filter((s) => /^DROP TABLE/.test(s)).map((s) => /`([a-z_]+)`/.exec(s)[1]);
    assert.deepEqual([...drops].sort(), [...TABLES].sort());
    assert.ok(drops.indexOf("biomax_punch_derived") < drops.indexOf("biomax_punch"));
    assert.ok(drops.indexOf("biomax_device_assignment") < drops.indexOf("biomax_device"));
    assert.ok(drops.indexOf("biomax_derivation_change") < drops.indexOf("biomax_derivation_run"));
  });

  it("removes exactly the six keys and nothing else", () => {
    const deletes = stmts.filter((s) => /^DELETE FROM/.test(s));
    assert.equal(deletes.length, 2);
    for (const d of deletes) {
      for (const key of KEYS) assert.ok(d.includes(`'${key}'`), key);
      assert.doesNotMatch(d, /view_work_shifts|view_employees|view_shift/);
    }
  });
});
