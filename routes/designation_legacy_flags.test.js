/**
 * `designation.online_portal` and `designation.login_access` — the audit,
 * pinned.
 *
 *   node --test routes/designation_legacy_flags.test.js
 *
 * ============================================== WHAT THE AUDIT FOUND =======
 *
 * Neither flag has any runtime effect. Both are WRITTEN and never ASKED ABOUT.
 *
 * LOGIN does not consult either. `repository/user.js` joins `designation d` in
 * its credential query but selects exactly one column from it,
 * `d.designation_name`; neither flag is in `CREDENTIAL_COLUMNS` at all. The
 * decision in `usecase/user.js#login` turns on the password, `user.status`,
 * `new_employee.status` (for a non-system account) and the IP policy. Setting
 * `login_access = 0` on a designation therefore stops nobody from signing in.
 *
 * AUTHORIZATION does not consult either. `middlewares/auth.js` and
 * `middlewares/permissions.js` contain neither identifier; permissions are
 * resolved from the `permissions` table by designation id, and the admin
 * bypass is `user_type = 2`. Setting `online_portal = 0` closes no route.
 *
 * The only reads anywhere are display: the designation master's own form,
 * which showed them, and the list screen, which echoed them straight back on
 * save. `services/synker.js` writes 1 to both for every designation it creates
 * from Digisme.
 *
 * These tests pin that absence, because an absence is exactly what a future
 * change could quietly undo.
 *
 * ================================= WHY THE COLUMNS ARE STILL WRITTEN =======
 *
 * Both are `INT NOT NULL` with NO DEFAULT. An INSERT that omits them raises
 * ER_NO_DEFAULT_FOR_FIELD under STRICT_TRANS_TABLES - verified against MySQL
 * 8.0 - so create must supply a value even though nothing will ever read it.
 * The repository defaults to 1, which is what the sync has always written.
 * Dropping the columns would need a migration and is deliberately not done.
 *
 * UPDATE is different: `UPDATE designation SET ?` writes only the keys it is
 * given, so omitting the flags leaves the stored values untouched rather than
 * zeroing them. Also verified against MySQL 8.0.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const FLAGS = ["online_portal", "login_access"];

/* ===================================== the flags decide nothing ========== */

test("NEITHER FLAG IS READ BY THE LOGIN PATH", () => {
  // The credential query joins `designation` but takes only the name from it.
  const userRepo = strip(read("repository/user.js"));
  const columns = userRepo.slice(
    userRepo.indexOf("const CREDENTIAL_COLUMNS"),
    userRepo.indexOf("class UserRepository")
  );
  assert.match(columns, /d\.designation_name AS designation_name/);
  for (const flag of FLAGS) {
    assert.ok(!columns.includes(flag), `login must not select ${flag}`);
    assert.ok(!userRepo.includes(flag), `repository/user.js must not mention ${flag}`);
  }
});

test("NEITHER FLAG APPEARS IN THE LOGIN DECISION", () => {
  // What actually gates a login: the password, the account status, the
  // employee status, and the IP policy.
  const userUsecase = strip(read("usecase/user.js"));
  for (const flag of FLAGS) {
    assert.ok(!userUsecase.includes(flag), `usecase/user.js must not mention ${flag}`);
  }
  assert.match(userUsecase, /Number\(row\.status\) !== 1/);
  assert.match(userUsecase, /Number\(row\.employee_status\) !== 1/);
  assert.match(userUsecase, /isAccessAllowed\(resolveIpPolicy\(row\)/);
});

test("NEITHER FLAG APPEARS IN AUTHENTICATION OR AUTHORIZATION MIDDLEWARE", () => {
  for (const file of ["middlewares/auth.js", "middlewares/permissions.js"]) {
    const src = read(file);
    for (const flag of FLAGS) {
      assert.ok(!src.includes(flag), `${file} must not mention ${flag}`);
    }
  }
  // Permissions come from the permissions table, keyed by designation.
  const perms = strip(read("middlewares/permissions.js"));
  assert.match(perms, /designationUsecase\.getPermissionById/);
});

test("NO READ OF EITHER FLAG EXISTS ANYWHERE IN THE BACKEND", () => {
  // The whole point of the audit: every occurrence is a write or a schema
  // declaration. A comparison, a WHERE clause or a conditional would be a
  // runtime dependency, and there is none.
  const roots = ["routes", "usecase", "repository", "middlewares", "services", "utils", "constants"];
  const offenders = [];
  const walk = (dir) => {
    const full = path.join(__dirname, "..", dir);
    if (!fs.existsSync(full)) return;
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(rel);
        continue;
      }
      if (!entry.name.endsWith(".js") || entry.name.endsWith(".test.js")) continue;
      let src = strip(read(rel));
      // ONE deliberate exception, and it is a read of the REQUEST rather than
      // of the stored column: `repository/designation.js#create` inspects the
      // incoming body so it can supply a value for two NOT NULL columns that
      // have no default. It is asserted separately, immediately below, so
      // removing it here does not let it drift.
      if (rel.replace(/\\/g, "/") === "repository/designation.js") {
        src = src.replace(/const onlinePortal =[\s\S]*?: designation\.login_access;/, "");
      }
      for (const flag of FLAGS) {
        // A read looks like `x.flag ===`, `if (... flag ...)`, `WHERE flag`,
        // or the flag inside a SELECT list.
        const reads = [
          new RegExp(`${flag}\\s*[=!]==`),
          new RegExp(`WHERE[^;]*${flag}`, "i"),
          new RegExp(`SELECT[^;"]*${flag}`, "i"),
          new RegExp(`if\\s*\\([^)]*${flag}`),
        ];
        for (const r of reads) {
          if (r.test(src)) offenders.push(`${rel}: ${flag} matched ${r}`);
        }
      }
    }
  };
  roots.forEach(walk);
  assert.deepStrictEqual(offenders, [], offenders.join("\n"));
});

test("THE ONLY REQUEST-SIDE READ IS THE CREATE DEFAULT, AND IT DEFAULTS TO 1", () => {
  // Named explicitly so the exclusion above can never quietly widen: these two
  // expressions exist solely to satisfy two NOT NULL columns, and they read
  // the incoming body, never the database.
  const repo = strip(read("repository/designation.js"));
  const create = repo.slice(repo.indexOf("create(designation)"));
  const defaults = create.slice(0, create.indexOf("this.db.query"));
  assert.match(
    defaults,
    /designation\.online_portal === undefined \|\| designation\.online_portal === null\s*\?\s*1/
  );
  assert.match(
    defaults,
    /designation\.login_access === undefined \|\| designation\.login_access === null\s*\?\s*1/
  );
  // Nothing outside create() in this file reads either flag.
  const outsideCreate = repo.slice(0, repo.indexOf("create(designation)"));
  for (const flag of FLAGS) {
    assert.ok(!outsideCreate.includes(flag), `${flag} must not be read outside create()`);
  }
});

/* ============================== update: optional, and non-destructive ==== */

test("UPDATE ACCEPTS A BODY WITHOUT EITHER FLAG", () => {
  const route = strip(read("routes/designation.js"));
  const schema = route.slice(
    route.indexOf("update-designation"),
    route.indexOf("updateDesignationDetails")
  );
  assert.match(schema, /online_portal: Joi\.number\(\)\.optional\(\)/);
  assert.match(schema, /login_access: Joi\.number\(\)\.optional\(\)/);
  assert.ok(!/online_portal: Joi\.number\(\)\.required\(\)/.test(schema));
  assert.ok(!/login_access: Joi\.number\(\)\.required\(\)/.test(schema));
});

test("UPDATE STILL ACCEPTS THEM WHEN AN OLDER CALLER SENDS THEM", () => {
  // Optional, not stripped: a caller that has not been redeployed keeps
  // working, and its value is still written.
  const route = strip(read("routes/designation.js"));
  const schema = route.slice(
    route.indexOf("update-designation"),
    route.indexOf("updateDesignationDetails")
  );
  for (const flag of FLAGS) {
    assert.match(schema, new RegExp(`${flag}: Joi\\.number\\(\\)`));
  }
});

test("AN OMITTED FLAG IS NOT OVERWRITTEN WITH ZERO", () => {
  // `UPDATE designation SET ?` writes only the keys present in the object, so
  // an absent flag is absent from the statement entirely. Verified against
  // MySQL 8.0: updating name and status leaves both flags at their stored
  // values.
  const repo = strip(read("repository/designation.js"));
  assert.match(repo, /UPDATE designation SET \? WHERE designation_id = \?/);
  const update = repo.slice(
    repo.indexOf("updateDesignationDetails"),
    repo.indexOf("create(")
  );
  for (const flag of FLAGS) {
    assert.ok(!update.includes(flag), `the update path must not name ${flag}`);
  }
});

test("the update schema still requires the two fields that matter", () => {
  const route = strip(read("routes/designation.js"));
  const schema = route.slice(
    route.indexOf("update-designation"),
    route.indexOf("updateDesignationDetails")
  );
  assert.match(schema, /designation_name: Joi\.string\(\)\.required\(\)/);
  assert.match(schema, /status: Joi\.number\(\)\.required\(\)/);
});

/* ============================== create: optional, but always written ===== */

test("CREATE ACCEPTS A BODY WITHOUT EITHER FLAG", () => {
  const route = strip(read("routes/designation.js"));
  const schema = route.slice(route.indexOf('router.post("/create"'));
  const body = schema.slice(0, schema.indexOf("Joi.validate"));
  assert.match(body, /online_portal: Joi\.number\(\)\.optional\(\)/);
  assert.match(body, /login_access: Joi\.number\(\)\.optional\(\)/);
});

test("CREATE STILL SUPPLIES A VALUE, BECAUSE THE COLUMNS ARE NOT NULL", () => {
  // `INT NOT NULL` with no default: an INSERT omitting either raises
  // ER_NO_DEFAULT_FOR_FIELD under STRICT_TRANS_TABLES. Verified against MySQL
  // 8.0. So the repository defaults rather than the schema.
  const repo = strip(read("repository/designation.js"));
  const create = repo.slice(repo.indexOf("create(designation)"));
  assert.match(create, /const onlinePortal =/);
  assert.match(create, /const loginAccess =/);
  assert.match(create, /\?\s*1\s*:/);
  // And the INSERT still names all four columns.
  assert.match(
    create,
    /INSERT INTO designation \(status, designation_name, online_portal, login_access\)/
  );
});

test("the columns are still NOT NULL without a default, which is why", () => {
  const original = read("migrations/mysql/migrations/sqls/20211006085243-adds-designation-up.sql");
  const altered = read("migrations/mysql/migrations/sqls/20211217053621-alter-designation-up.sql");
  assert.match(original, /`online_portal` int NOT NULL/);
  assert.match(altered, /`login_access` INT NOT NULL/);
  assert.ok(!/online_portal.*DEFAULT/i.test(original), "no default on online_portal");
  assert.ok(!/login_access.*DEFAULT/i.test(altered), "no default on login_access");
});

/* ============================== nothing else moved ====================== */

test("NO MIGRATION WAS ADDED AND NO COLUMN WAS DROPPED", () => {
  const migrations = fs.readdirSync(
    path.join(__dirname, "..", "migrations", "mysql", "migrations")
  );
  for (const m of migrations) {
    assert.ok(
      !/legacy-flags|drop-online-portal|drop-login-access|designation-cleanup/i.test(m),
      `unexpected migration: ${m}`
    );
  }
  const repo = read("repository/designation.js");
  assert.ok(!/DROP COLUMN/i.test(repo));
});

test("THE PERMISSIONS HOTFIX IS NOT REGRESSED", () => {
  // `permissions` must stay optional on update, and the usecase must keep
  // rewriting the set only when it is given one.
  const route = strip(read("routes/designation.js"));
  const schema = route.slice(
    route.indexOf("update-designation"),
    route.indexOf("updateDesignationDetails")
  );
  assert.match(schema, /permissions: Joi\.array\(\)\.items\(Joi\.string\(\)\)\.optional\(\)/);

  const usecase = strip(read("usecase/designation.js"));
  const body = usecase.slice(usecase.indexOf("updateDesignationDetails"));
  assert.match(body.slice(0, 700), /if \(designation\.permissions\) \{[\s\S]{0,200}deletePermissions/);
});

test("authorization on the designation routes is unchanged", () => {
  const route = strip(read("routes/designation.js"));
  for (const [path_, key] of [
    ['router.post\\("/update-designation"', "ADD_DESIGNATION"],
    ['router.post\\("/create"', "ADD_DESIGNATION"],
    ['router.post\\("/update-status"', "ADD_DESIGNATION"],
    ['router.get\\("/"', "VIEW_DESIGNATION"],
  ]) {
    const decl = route.match(new RegExp(`${path_},[^,]+,`));
    assert.ok(decl, path_);
    assert.match(decl[0], new RegExp(`require\\(P\\.${key}\\)`), path_);
  }
});

test("no individual login control was introduced", () => {
  // The task is an audit and a cleanup, not a new feature. Nothing here may
  // start deciding who can sign in.
  for (const file of ["routes/designation.js", "repository/designation.js", "usecase/designation.js"]) {
    const src = read(file);
    for (const invented of ["can_login", "login_enabled", "user_status", "disable_login"]) {
      assert.ok(!src.includes(invented), `${file} must not introduce ${invented}`);
    }
  }
});
