const logger = require("../utils/logger");

/**
 * `employee_family` is being moved off `employee_name` and onto `employee_id`.
 *
 * The name was the only link to the employee a record belongs to, which meant
 * a name correction orphaned every one of that employee's records and two
 * employees sharing a name shared their family. Migration
 * 20260926120000-employee-family-key added `employee_id`, indexed, with a
 * foreign key, and backfilled it wherever the name resolved to exactly one
 * employee.
 *
 * THIS IS STEP ONE OF THE CUTOVER, and it is deliberately additive:
 *
 *   writes  set BOTH columns. `employee_id` is taken from the caller when it
 *           sends one and otherwise resolved from the name, but only when the
 *           name is unambiguous - a name shared by two employees resolves to
 *           NULL rather than to a guess.
 *   reads   by `employee_id` where the caller has one (getFamilyByEmployeeId),
 *           and still by name where it does not (getFamilyByEmployee).
 *
 * So both columns agree for every row written from now on, and nothing that
 * reads by name breaks. Steps two and three - making every reader use the id,
 * then dropping `employee_name` - are separate changes, each safe on its own.
 */
class FamilyRepository {
  constructor(db) {
    this.db = db;
  }

  get() {
    return new Promise((resolve, reject) => {
      this.db.query(
        "SELECT * FROM employee_family",
        [],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.FAMILY",
              code: "REPOSITORY.FAMILY.GET",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs)
        }
      );
    });
  }
  getFamilyByEmployee(employee_name) {
    return new Promise((resolve, reject) => {
      this.db.query("SELECT * FROM employee_family WHERE employee_name = ?",
      [employee_name], 
      (err, docs) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.FAMILY",
            code: "REPOSITORY.FAMILY.GET-EMPLOYEE-FAM",
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
  /**
   * The records belonging to one employee, by their permanent id.
   *
   * This is the read the cutover is heading for. It returns nothing for an
   * employee whose records have not been attached yet (`employee_id` still
   * NULL - an ambiguous or already-orphaned row), which is why
   * getFamilyByEmployee below is still here and still used.
   */
  getFamilyByEmployeeId(employee_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "SELECT * FROM employee_family WHERE employee_id = ?",
        [employee_id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.FAMILY",
              code: "REPOSITORY.FAMILY.GET-EMPLOYEE-FAM-BY-ID",
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
   * The employee id for a name, ONLY when the name identifies one employee.
   *
   * Two employees sharing a name resolve to null, and so does a name no
   * employee holds. That is the point: this is the same rule the backfill
   * migration applied, so a record written through the name path is attached
   * exactly when it can be attached correctly, and left unattached rather
   * than attached to the wrong person. `idx_new_employee_name` (migration
   * 20260925120000) is what keeps this off a full scan.
   */
  findEmployeeIdByName(employee_name) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "SELECT employee_id FROM new_employee WHERE employee_name = ? LIMIT 2",
        [employee_name],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.FAMILY",
              code: "REPOSITORY.FAMILY.FIND-EMPLOYEE-ID-BY-NAME",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs && docs.length === 1 ? Number(docs[0].employee_id) : null);
        }
      );
    });
  }

  getFamilyById(family_id) {
    return new Promise((resolve, reject) => {
      this.db.query("SELECT * FROM employee_family where family_id = ?",
      [family_id], 
      (err, docs) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.FAMILY",
            code: "REPOSITORY.FAMILY.GET-FAMILY-ID",
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
  updateFamilyDetails(data, family_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `UPDATE employee_family SET ? WHERE family_id = ?`,
        [data, family_id],
        (err, res) => {
          if (err) {
              logger.Log({
                level: logger.LEVEL.ERROR,
                component: "REPOSITORY.FAMILY",
                code: "REPOSITORY.FAMILY.UPDATE-FAMILY-DETAILS",
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
  create(family) {
    return new Promise((resolve, reject) => {
        this.db.query(
          // BOTH columns. `employee_id` is the permanent link; `employee_name`
          // is still written because every other reader still uses it. It is
          // NULL only when the usecase could not resolve the employee
          // unambiguously, which is recorded rather than guessed at.
          "INSERT INTO employee_family (name, dob, gender, blood_group, relation, employee_id, employee_name, nationality, profession, remarks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            family.name,
            family.dob,
            family.gender,
            family.blood_group,
            family.relation,
            family.employee_id === undefined ? null : family.employee_id,
            family.employee_name,
            family.nationality,
            family.profession,
            family.remarks
          ],
          (err, res) => {
            if (err) {
              if (err.code === "ER_DUP_ENTRY") {
                resolve({ code: 101 });
                return;
              }
              logger.Log({
                level: logger.LEVEL.ERROR,
                component: "REPOSITORY.FAMILY",
                code: "REPOSITORY.FAMILY.CREATE",
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
}

module.exports = (db) => {
  return new FamilyRepository(db);
};
