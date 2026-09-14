const logger = require("../utils/logger");
const { buildEmployeeScope } = require("./employee_scope");

/**
 * THE EMPLOYEE-DETAIL RESULT CONTRACT — every column `getById` returns.
 *
 * EVERY `new_employee` COLUMN IS QUALIFIED. That qualification is the fix, not
 * decoration: four of these tables carry a `status` column and the driver keys
 * rows by the bare column name, so an unqualified or starred select lets the
 * last join win. Naming `new_employee.status` means the employee's status is
 * the one that arrives.
 *
 * Exported so `employee_detail_columns.test.js` can hold it against the
 * migrations and fail when a column is added to `new_employee` and forgotten
 * here.
 */
const EMPLOYEE_MASTER_COLUMNS = [
  "new_employee.employee_id",
  "new_employee.employee_name",
  "new_employee.father_name",
  "new_employee.dob",
  "new_employee.gender",
  "new_employee.marital_status",
  "new_employee.employee_image",
  "new_employee.marriage_date",
  "new_employee.spouse_name",
  "new_employee.permanent_address",
  "new_employee.residential_address",
  "new_employee.primary_contact_number",
  "new_employee.alternate_contact_number",
  "new_employee.email_id",
  "new_employee.blood_group",
  "new_employee.qualification",
  "new_employee.introducer_name",
  "new_employee.introducer_details",
  "new_employee.salary",
  "new_employee.bank_name",
  "new_employee.ifsc",
  "new_employee.account_no",
  "new_employee.esi",
  "new_employee.esi_number",
  "new_employee.pf",
  "new_employee.pf_number",
  "new_employee.uan",
  "new_employee.uniform_qty",
  "new_employee.store_id",
  "new_employee.department_id",
  "new_employee.designation_id",
  "new_employee.shift_id",
  "new_employee.previous_experience",
  "new_employee.additional_course",
  "new_employee.date_of_joining",
  "new_employee.pan_no",
  "new_employee.payment_type",
  "new_employee.online_portal",
  "new_employee.created_at",
  // THE COLUMN THE WHOLE FIX IS ABOUT. 1 is employed; anything else is not.
  "new_employee.status",
  "new_employee.resignation_date",
  // `is_verified` IS NOT HERE, and must not be added back. It belongs to
  // `new_employee_documents` (a document is verified; an employee is not),
  // and selecting it from `new_employee` is ER_BAD_FIELD_ERROR 1054 - the
  // production 500 this list caused. See the test for how it got in.
  "new_employee.telegram_username",
  "new_employee.aadhaar_card_no",
  "new_employee.aadhaar_card_name",
  "new_employee.aadhaar_card_image",
  "new_employee.updated_at",
  "new_employee.shift_code",
  "new_employee.default_work_shift_id",
  "new_employee.pf_applicable",
  "new_employee.esi_applicable",
  "new_employee.previous_pf_member",
  "new_employee.previous_eps_member",
  "new_employee.special_break_override_minutes",
  "new_employee.source_system",
  "new_employee.source_employee_code",
  "new_employee.attendance_required",
];

/**
 * The joined DISPLAY columns, under the exact key names this endpoint already
 * returned for them, so nothing downstream changes.
 *
 * `designation.online_portal` is aliased because `new_employee` has a column
 * of that name too and it was being overwritten. Nothing else here collides.
 */
const EMPLOYEE_DETAIL_JOINED_COLUMNS = [
  "department.department_name",
  "designation.designation_name",
  "designation.online_portal AS designation_online_portal",
  "outlets.outlet_name",
  "outlets.outlet_nickname",
  "shift_master.shift_name",
  "shift_master.shift_in_time",
  "shift_master.shift_out_time",
];

const EMPLOYEE_DETAIL_COLUMNS = [
  ...EMPLOYEE_MASTER_COLUMNS,
  ...EMPLOYEE_DETAIL_JOINED_COLUMNS,
];

class EmployeeRepository {
  constructor(db) {
    this.db = db;
  }

  /**
   * THE BRANCH PREDICATE for a query that takes no other WHERE parameters.
   *
   * `store_ids` says which branches the caller is authorized for, and the
   * three states are three DIFFERENT statements that must not be collapsed:
   *
   *   null / undefined   no restriction. HR, an administrator, or an internal
   *                      caller with no actor at all.
   *   a non-empty list   those branches only.
   *   `[]`               NO branch is authorized. Renders `AND 1 = 0`, so the
   *                      query returns nothing. An empty authorized set is
   *                      never the same as no restriction, and treating it as
   *                      one is exactly the bug this shape prevents.
   *
   * Returns a fragment to append after an existing WHERE, plus its parameters.
   * The ids are BOUND, never interpolated.
   */
  _branchClause(storeIds, column = "store_id") {
    if (storeIds === null || storeIds === undefined) return { sql: "", params: [] };
    if (!Array.isArray(storeIds) || storeIds.length === 0) {
      return { sql: " AND 1 = 0", params: [] };
    }
    return { sql: ` AND ${column} IN (?)`, params: [storeIds] };
  }

  create(employee) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "INSERT INTO new_employee (employee_id, employee_name, father_name, dob, permanent_address, residential_address, primary_contact_number, alternate_contact_number, email_id, qualification, introducer_name, introducer_details, salary, uniform_qty, previous_experience, date_of_joining, gender, blood_group, designation_id, store_id, shift_id, department_id, marital_status, marriage_date, employee_image, bank_name, ifsc, account_no, esi, esi_number, pf, pan_no, payment_type, pf_number, UAN, additional_course, spouse_name, online_portal, telegram_username, aadhaar_card_no, aadhaar_card_name, aadhaar_card_image) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          employee.employee_id,
          employee.employee_name,
          employee.father_name,
          employee.dob,
          employee.permanent_address,
          employee.residential_address,
          employee.primary_contact_number,
          employee.alternate_contact_number,
          employee.email_id,
          employee.qualification,
          employee.introducer_name,
          employee.introducer_details,
          employee.salary,
          employee.uniform_qty,
          employee.previous_experience,
          employee.date_of_joining,
          employee.gender,
          employee.blood_group,
          employee.designation_id,
          employee.store_id,
          employee.shift_id,
          employee.department_id,
          employee.marital_status,
          employee.marriage_date,
          employee.employee_image,
          employee.bank_name,
          employee.ifsc,
          employee.account_no,
          employee.esi,
          employee.esi_number,
          employee.pf,
          employee.pan_no,
          employee.payment_type,
          employee.pf_number,
          employee.UAN,
          employee.additional_course,
          employee.spouse_name,
          employee.online_portal,
          employee.telegram_username,
          employee.aadhaar_card_no,
          employee.aadhaar_card_name,
          employee.aadhaar_card_image,
        ],
        (err, res) => {
          if (err) {
            if (err.code === "ER_DUP_ENTRY") {
              resolve({ code: 101 });
              return;
            }
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.EMPLOYEE",
              code: "REPOSITORY.EMPLOYEE.CREATE",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve({ code: 200, id: res.insertId });
        }
      );
    });
  }

  getNameById(username) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT new_employee.employee_name, designation.designation_name, new_employee.employee_image FROM new_employee LEFT JOIN designation ON designation.designation_id = new_employee.designation_id WHERE primary_contact_number = ?`,
        [username],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.EMPLOYEE",
              code: "REPOSITORY.EMPLOYEE.GET-NAME",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs);
        }
      );
    });
  }
  getnewJoinee(limit, offset, storeIds = null) {
    return new Promise((resolve, reject) => {
      const branch = this._branchClause(storeIds);
      this.db.query(
        `SELECT employee_id, employee_name, date_of_joining FROM new_employee WHERE MONTH(date_of_joining)=MONTH(now())${branch.sql} LIMIT ${offset},${limit}`,
        branch.params,
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.EMPLOYEE",
              code: "REPOSITORY.EMPLOYEE.GET-JOINEE",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs);
        }
      );
    });
  }
  getEmployeeByStore(store_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "SELECT count(employee_id) as store_count FROM new_employee WHERE store_id = ?",
        [store_id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.EMPLOYEE",
              code: "REPOSITORY.EMPLOYEE.GET-BY-STORE",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs);
        }
      );
    });
  }
  updateStatus(file) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "UPDATE new_employee SET status = ? WHERE employee_id = ?",
        [file.status, file.employee_id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.EMPLOYEE",
              code: "REPOSITORY.EMPLOYEE.UPDATE-STATUS",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs);
        }
      );
    });
  }
  updateEmployeeImage(data, employee_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "UPDATE new_employee SET employee_image = ? WHERE employee_id = ?",
        [data, employee_id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.EMPLOYEE",
              code: "REPOSITORY.EMPLOYEE.UPDATE-EMPLOYEE-IMAGE",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs);
        }
      );
    });
  }
  /**
   * THE EMPLOYEE SEARCH / AUTOCOMPLETE.
   *
   * TWO THINGS ARE FIXED HERE BEYOND ADDING THE BRANCH SCOPE, and both had to
   * be:
   *
   *   PRECEDENCE. The clause used to read `status = 1 AND name LIKE x OR id
   *   LIKE x OR outlet LIKE x`. AND binds tighter than OR, so the second and
   *   third arms stood alone - a search matching an outlet name returned
   *   employees regardless of anything ANDed before it. Appending a branch
   *   predicate to that shape would have been bypassable by exactly those two
   *   arms, so the search group is parenthesised and the branch restriction
   *   ANDed outside it.
   *
   *   INTERPOLATION. `filter` came straight from the query string into the SQL
   *   text. It is a bound parameter now, and the caller's `%` and `_` are
   *   escaped so a search for a literal `%` searches for that character
   *   instead of matching every employee in the company.
   *
   * @param storeIds null for no restriction, or the authorized branches.
   */
  getEmployeeByFilter(filter, storeIds = null) {
    return new Promise((resolve, reject) => {
      const branch = this._branchClause(storeIds, "new_employee.store_id");
      const like = `%${String(filter === undefined || filter === null ? "" : filter)
        .replace(/\\/g, "\\\\")
        .replace(/%/g, "\\%")
        .replace(/_/g, "\\_")}%`;
      this.db.query(
        `SELECT new_employee.employee_id, new_employee.employee_name, new_employee.father_name, new_employee.dob, new_employee.gender, new_employee.marital_status, 
        new_employee.employee_image, new_employee.marriage_date, new_employee.spouse_name, new_employee.permanent_address, new_employee.residential_address, 
        new_employee.primary_contact_number, new_employee.alternate_contact_number, new_employee.email_id, new_employee.blood_group, new_employee.qualification,
        new_employee.introducer_name, new_employee.introducer_details, new_employee.salary, new_employee.bank_name, new_employee.ifsc, new_employee.account_no, 
        new_employee.esi_number, new_employee.pf_number, new_employee.uan, new_employee.uniform_qty, new_employee.store_id, new_employee.department_id, 
        new_employee.designation_id, new_employee.shift_id, new_employee.previous_experience, new_employee.additional_course, new_employee.date_of_joining,
        new_employee.pan_no, new_employee.payment_type, new_employee.status, designation.designation_name, outlets.outlet_name as store_name, 
        department.department_name, shift_master.shift_name, new_employee.updated_at FROM new_employee
        LEFT JOIN department ON department.department_id = new_employee.department_id
        LEFT JOIN outlets ON outlets.outlet_id = new_employee.store_id
        LEFT JOIN designation ON designation.designation_id  = new_employee.designation_id
        LEFT JOIN shift_master ON shift_master.shift_id = new_employee.shift_id
        WHERE new_employee.status = 1
          AND (new_employee.employee_name LIKE ?
               OR new_employee.employee_id LIKE ?
               OR outlets.outlet_name LIKE ?)${branch.sql}`,
        [like, like, like, ...branch.params],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.EMPLOYEE",
              code: "REPOSITORY.EMPLOYEE.GET-FILTER",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs);
        }
      );
    });
  }
  get(resignation, filters, actor = null) {
    return new Promise((resolve, reject) => {
      // The population - who is in this list at all - lives in
      // `employee_scope.js`, so the C3 status summary and Reports can ask the
      // same question rather than each restating the rule.
      //
      // The hotfix deployed as 1f7c11a moved INTO that module: the resigned
      // -name exclusion is omitted entirely when there is nothing to exclude,
      // rather than written as `(... NOT IN (?) OR ? IS NULL)` with the same
      // array bound twice - a shape MySQL rejects at two or more names.
      // `resignation` is keyed by name and may hold several rows for one
      // person (re-hires, voided and re-recorded resignations). Joining it
      // directly fanned each employee out once per row, which showed up as
      // the same name repeated in every employee dropdown. Collapse it to one
      // row per name first so the result stays one row per employee.
      const { where: whereClause, params: filterValues } = buildEmployeeScope(
        resignation,
        filters,
        actor
      );

      const query = `
        SELECT new_employee.employee_id, new_employee.employee_name, new_employee.father_name, new_employee.dob, new_employee.gender, new_employee.marital_status, 
        new_employee.employee_image, new_employee.marriage_date, new_employee.spouse_name, new_employee.permanent_address, new_employee.residential_address, 
        new_employee.primary_contact_number, new_employee.alternate_contact_number, new_employee.email_id, new_employee.blood_group, new_employee.qualification,
        new_employee.introducer_name, new_employee.introducer_details, new_employee.salary, new_employee.bank_name, new_employee.ifsc, new_employee.account_no, 
        new_employee.esi_number, new_employee.pf_number, new_employee.uan, new_employee.uniform_qty, new_employee.store_id, new_employee.department_id, 
        new_employee.designation_id, new_employee.shift_id, new_employee.previous_experience, new_employee.additional_course, new_employee.date_of_joining,
        new_employee.pan_no, new_employee.payment_type, new_employee.status, designation.designation_name, outlets.outlet_name as store_name, 
        department.department_name, shift_master.shift_name, resignation.resignation_date, new_employee.updated_at, shift_code
        FROM new_employee 
        LEFT JOIN designation ON designation.designation_id = new_employee.designation_id
        LEFT JOIN department ON department.department_id = new_employee.department_id 
        LEFT JOIN outlets ON outlets.outlet_id = new_employee.store_id 
        LEFT JOIN shift_master ON shift_master.shift_id = new_employee.shift_id 
        LEFT JOIN (
          SELECT employee_name, MAX(resignation_date) AS resignation_date
          FROM resignation
          GROUP BY employee_name
        ) resignation ON resignation.employee_name = new_employee.employee_name
        ${whereClause}`;

      this.db.query(query, filterValues, (err, docs) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.EMPLOYEE",
            code: "REPOSITORY.EMPLOYEE.GET",
            description: err.toString(),
            category: "",
            ref: {},
          });
          reject(err);
          return;
        }
        resolve(docs);
      });
    });
  }
  getHeadCount(storeIds = null) {
    return new Promise((resolve, reject) => {
      const branch = this._branchClause(storeIds);
      this.db.query(
        `SELECT count(employee_id) as head_count, created_at FROM new_employee WHERE status = 1${branch.sql} GROUP BY MONTH(DATE(created_at))`,
        branch.params,
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.EMPLOYEE",
              code: "REPOSITORY.EMPLOYEE.GET-HEAD-COUNT",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs);
        }
      );
    });
  }
  getResignedEmployee(storeIds = null) {
    return new Promise((resolve, reject) => {
      const branch = this._branchClause(storeIds);
      this.db.query(
        `SELECT count(employee_id) as Resigned_employee FROM new_employee where resignation_date IS NOT NULL${branch.sql}`,
        branch.params,
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.EMPLOYEE",
              code: "REPOSITORY.EMPLOYEE.GET-RESIGNED-EMPLOYEE",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs);
        }
      );
    });
  }
  getFamilyDet(storeIds = null) {
    return new Promise((resolve, reject) => {
      const branch = this._branchClause(storeIds);
      this.db.query(
        `SELECT employee_id, employee_name, employee_image FROM new_employee WHERE status = 1${branch.sql}`,
        branch.params,
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.EMPLOYEE",
              code: "REPOSITORY.EMPLOYEE.GET-FAMILY-DET",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs);
        }
      );
    });
  }
  /**
   * The names of the active employees at ONE outlet, and nothing else.
   *
   * This exists so an operational screen - the accounts sheet's cashier
   * dropdown - can label a person without holding `view_employees`. Two
   * columns, chosen explicitly: adding one here would widen what every
   * signed-in user can read, so the list is the whole security boundary and
   * `SELECT *` is not an option.
   */
  getDirectoryByStore(store_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "SELECT employee_id, employee_name FROM new_employee WHERE status = 1 AND store_id = ? ORDER BY employee_name",
        [store_id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.EMPLOYEE",
              code: "REPOSITORY.EMPLOYEE.GET-DIRECTORY",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs);
        }
      );
    });
  }
  getEmployeeIdByName(employee_name) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "SELECT employee_id FROM new_employee where employee_name = ?",
        [employee_name],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.EMPLOYEE",
              code: "REPOSITORY.EMPLOYEE.GET-EMPLOYEE-BY-NAME",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs[0].employee_id);
        }
      );
    });
  }
  getEmployeeIdByDelete(resignation_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "SELECT employee_id FROM new_employee LEFT JOIN resignation ON resignation.employee_name = new_employee.employee_name WHERE resignation.resignation_id = ?",
        [resignation_id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.EMPLOYEE",
              code: "REPOSITORY.EMPLOYEE.GET-EMPLOYEE-BY-RESIGNATION-ID",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs[0].employee_id);
        }
      );
    });
  }
  getNewJoiner(storeIds = null) {
    return new Promise((resolve, reject) => {
      const branch = this._branchClause(storeIds);
      this.db.query(
        `select count(employee_id) as new_joiners from new_employee WHERE status = 1 AND MONTH(date_of_joining)=MONTH(now())${branch.sql}`,
        branch.params,
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.EMPLOYEE",
              code: "REPOSITORY.EMPLOYEE.GET-NEW-JOINER",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs);
        }
      );
    });
  }
  getBankDetails(storeIds = null) {
    return new Promise((resolve, reject) => {
      const branch = this._branchClause(storeIds);
      this.db.query(
        `SELECT * FROM new_employee WHERE payment_type = 2 AND status = 1${branch.sql}`,
        branch.params,
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.EMPLOYEE",
              code: "REPOSITORY.EMPLOYEE.GET-BANK",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs);
        }
      );
    });
  }

  getEmployeeBirthday(storeIds = null) {
    return new Promise((resolve, reject) => {
      const branch = this._branchClause(storeIds);
      this.db.query(
        `SELECT dob, employee_name AS birthday FROM new_employee WHERE status = 1 AND WEEK(dob) = WEEK(now())${branch.sql}`,
        branch.params,
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.EMPLOYEE",
              code: "REPOSITORY.EMPLOYEE.GET-BIRTHDAY",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs);
        }
      );
    });
  }

  getJoiningAnniversary(storeIds = null) {
    return new Promise((resolve, reject) => {
      const branch = this._branchClause(storeIds);
      this.db.query(
        `SELECT date_of_joining, employee_name AS anniversary FROM new_employee WHERE status = 1 AND WEEK(date_of_joining)=WEEK(now())${branch.sql}`,
        branch.params,
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.EMPLOYEE",
              code: "REPOSITORY.EMPLOYEE.GET-ANNIVERSARY",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs);
        }
      );
    });
  }
  /**
   * ONE EMPLOYEE, FOR THE PROFILE. Every column named; no `SELECT *`.
   *
   * ============================ THE BUG THIS FIXES ========================
   *
   * This query used to read `SELECT *` across FIVE joined tables, and the
   * mysql driver builds each row as a flat object keyed by the BARE column
   * name - `RowDataPacket` does `this[fieldPacket.name] = value`, with no
   * table qualifier unless `nestTables` is set, and this pool does not set
   * it. So where two joined tables share a column name, THE LAST ONE WINS
   * and silently overwrites the first.
   *
   * `new_employee`, `department`, `designation` and `shift_master` all have a
   * `status` column. The join order ends at `shift_master`, so the `status`
   * this endpoint returned was THE SHIFT'S status, not the employee's - and
   * `shift_master.status` defaults to 0. An active employee therefore came
   * back as `status: 0`, or `null` when they had no shift row at all, and the
   * profile drew "Resigned" over somebody who works here. The employee LIST
   * was always right because `#get` names its columns explicitly.
   *
   * Two more columns were being overwritten the same way, and are fixed by
   * the same change:
   *
   *   online_portal          came from `designation`, not the employee
   *   created_at, updated_at came from `outlets`, not the employee
   *
   * ============================ WHY EVERY COLUMN IS TYPED OUT =============
   *
   * `new_employee.*` would also have fixed it, and would survive a schema
   * change without edits. It is not used, because an explicit list is the
   * result contract: it says what this endpoint returns, a reader can see
   * that `status` is the employee's, and nothing can be added to a joined
   * table later and quietly appear in - or overwrite part of - the profile
   * payload. `employee_detail_columns.test.js` reads the migrations and
   * fails if a column is added to `new_employee` and not listed here, so the
   * one cost of being explicit is covered by a test rather than by memory.
   *
   * THE JOINED COLUMNS ARE THE DISPLAY NAMES ONLY, each named individually.
   * The key names are exactly the ones this endpoint already returned for
   * them, so no consumer changes: `department_name`, `designation_name`,
   * `outlet_name`, `outlet_nickname`, `shift_name`, `shift_in_time`,
   * `shift_out_time`. `designation.online_portal` is still available, but
   * under an alias that cannot collide with the employee's own column.
   *
   * B3 IS UNAFFECTED. `middlewares/sensitive.js` filters the RESPONSE by key
   * name, and every sensitive key it looks for (salary, bank, PAN, Aadhaar,
   * UAN, PF, ESI) is still selected under exactly the same name, so it strips
   * exactly what it stripped before.
   */
  getById(employee_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT ${EMPLOYEE_DETAIL_COLUMNS.join(", ")}
           FROM new_employee
           LEFT JOIN department   ON new_employee.department_id  = department.department_id
           LEFT JOIN designation  ON new_employee.designation_id = designation.designation_id
           LEFT JOIN outlets      ON new_employee.store_id       = outlets.outlet_id
           LEFT JOIN shift_master ON new_employee.shift_id       = shift_master.shift_id
          WHERE new_employee.employee_id = ?`,
        [employee_id],
        (err, docs) => {
          if (err) {
            // ENOUGH DETAIL TO DIAGNOSE THIS WITHOUT A DEPLOY, AND NO MORE.
            //
            // When this query failed in production the log said only
            // `err.toString()` and `ref: {}`. That happened to name the bad
            // column, but nothing said WHICH employee was being read or what
            // the driver's own error code was, so the first step of the
            // investigation was guessing.
            //
            // The four driver fields below are the diagnosis: `code` /
            // `errno` identify the class (ER_BAD_FIELD_ERROR 1054 was this
            // incident) and `sqlMessage` names the offending identifier.
            //
            // `err.sql` IS DELIBERATELY NOT LOGGED. The driver interpolates
            // bound parameters into it, so for other queries it can carry an
            // employee's own data; `sqlMessage` carries the column name and
            // no values. The employee id is logged because it is the
            // identifier the investigation needs and is not personal data -
            // no name, contact, bank, PAN or Aadhaar value is recorded here,
            // and none is available to this handler in any case.
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.EMPLOYEE",
              code: "REPOSITORY.EMPLOYEE.GET-ID",
              description: err.toString(),
              category: "",
              ref: {
                employee_id,
                db_code: err.code || null,
                db_errno: err.errno || null,
                db_sql_state: err.sqlState || null,
                db_message: err.sqlMessage || null,
              },
            });
            reject(err);
            return;
          }
          resolve(docs);
        }
      );
    });
  }
  updateEmployeeDetails(data, employee_id) {
    delete data["files"];
    return new Promise((resolve, reject) => {
      this.db.query(
        `UPDATE new_employee SET ? WHERE employee_id = ?`,
        [data, employee_id],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.EMPLOYEE",
              code: "REPOSITORY.EMPLOYEE.UPDATE-EMPLOYEE-DETAILS",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve({ code: 200 });
        }
      );
    });
  }

  bulkCreate(rows) {
    return new Promise((resolve, reject) => {
      if (!Array.isArray(rows) || rows.length === 0) {
        resolve({ affectedRows: 0 });
        return;
      }

      const columns = Object.keys(rows[0]);
      const values = rows.map((r) => columns.map((c) => r[c]));
      const placeholders = values
        .map(() => `(${columns.map(() => "?").join(",")})`)
        .join(",");
      const flat = [].concat(...values);

      const tickedColumns = columns.map((c) => `\`${c}\``).join(",");

      // Exclude primary key and immutable columns from update
      const doNotUpdate = new Set(["employee_id", "created_at"]);
      const updateAssignments = columns
        .filter((c) => !doNotUpdate.has(c))
        .map((c) => `\`${c}\` = VALUES(\`${c}\`)`)
        .join(", ");

      const sql =
        `INSERT INTO new_employee (${tickedColumns}) VALUES ${placeholders}` +
        (updateAssignments.length > 0
          ? ` ON DUPLICATE KEY UPDATE ${updateAssignments}, updated_at = CURRENT_TIME()`
          : "");

      this.db.query(sql, flat, (err, result) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.EMPLOYEES",
            code: "REPOSITORY.EMPLOYEES.BULKCREATE.ERROR",
            description: err.toString(),
            category: "",
            ref: {},
          });
          reject(err);
          return;
        }
        resolve({
          affectedRows: result.affectedRows,
          insertedId: result.insertId,
        });
      });
    });
  }
}

module.exports = (db) => {
  return new EmployeeRepository(db);
};
module.exports.EMPLOYEE_MASTER_COLUMNS = EMPLOYEE_MASTER_COLUMNS;
module.exports.EMPLOYEE_DETAIL_JOINED_COLUMNS = EMPLOYEE_DETAIL_JOINED_COLUMNS;
module.exports.EMPLOYEE_DETAIL_COLUMNS = EMPLOYEE_DETAIL_COLUMNS;
