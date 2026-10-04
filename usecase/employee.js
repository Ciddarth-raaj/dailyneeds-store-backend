const moment = require("moment");
const passwordService = require("../services/password");
const authConfig = require("../config/auth");
const { istToday } = require("../utils/istDate");
const { checkJoiningDateWindow, joiningDateChanged } = require("../utils/joining_date_window");

/**
 * The legacy routes answer a `ValidationError` as 422 with its message, so
 * the joining-date refusal is raised in that shape.
 */
function joiningDateRefusal(message) {
  const err = new Error(message);
  err.name = "ValidationError";
  return err;
}

class EmployeeUsecase {
  constructor(employeeRepo, documentUsecase, userRepo, resignationRepo) {
    this.employeeRepo = employeeRepo;
    this.documentUsecase = documentUsecase;
    this.userRepo = userRepo;
    this.resignationRepo = resignationRepo;
    /** Today's IST business date for the joining-date window; a property so a test can pin it. */
    this.today = () => istToday();
  }

  /**
   * THE JOINING-DATE ENTRY WINDOW on the legacy writes - the same rule, from
   * the same module, as `POST /hr/employee` (see
   * `utils/joining_date_window.js`). A CREATE must carry a date inside the
   * window, with no exception. An UPDATE may resend the stored date - a 2015
   * employee whose form resends 2015 is untouched - but may not change it:
   * that is the joining-date action's job, as on the Employee Master edit.
   */
  _requireJoiningDateForCreate(value) {
    const refusal = checkJoiningDateWindow(value, this.today());
    if (refusal) throw joiningDateRefusal(refusal.message);
  }

  async _requireJoiningDateForUpdate(employee_id, details) {
    if (!details || !Object.prototype.hasOwnProperty.call(details, "date_of_joining")) return;
    const stored = await this.employeeRepo.getJoiningDate(employee_id);
    if (!stored.found) return; // the update itself matches no row
    if (!joiningDateChanged(details.date_of_joining, stored.date_of_joining)) {
      // Unchanged: not rewritten at all, so a stored DATE is never round-
      // tripped through whatever text shape the form sent it back in.
      delete details.date_of_joining;
      return;
    }
    // A CHANGED DATE IS REFUSED HERE WHATEVER IT IS - the same answer the
    // Employee Master edit gives. This route writes the master column alone,
    // without the employment period, the lifecycle audit or the historical-
    // correction permission and reason; letting it change the date would be
    // the bypass around all four. A real date outside the window gets the
    // window's own message, which is the useful one.
    const refusal = checkJoiningDateWindow(details.date_of_joining, this.today());
    if (refusal && refusal.code !== "INVALID") throw joiningDateRefusal(refusal.message);
    throw joiningDateRefusal(
      "date_of_joining cannot be changed here. A wrongly recorded date_of_joining is corrected " +
        "through the joining-date action."
    );
  }

  /**
   * The HR directory list.
   *
   * `actor` carries the caller's resolved BRANCH SCOPE and is rendered into the
   * WHERE clause by `repository/employee_scope.js#accessScope`. An actor
   * without one is refused there (`1 = 0`), so a caller who reaches this
   * without going through the resolver gets nothing rather than everybody.
   *
   * `options.population` is passed through to the scope builder untouched
   * (`repository/employee_scope.js#DIRECTORY_POPULATION`); omitted, the list
   * is exactly what it has always been.
   */
  get(filters, actor = null, options = {}) {
    return new Promise(async (resolve, reject) => {
      try {
        const resignation = await this.resignationRepo.getResignedEmployee();
        let new_data = [];
        for (let i = 0; i <= resignation.length - 1; i++) {
          new_data.push(resignation[i].employee_name);
        }
        const data = await this.employeeRepo.get(new_data, filters, actor, options);
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }

  getHeadCount(storeIds = null) {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.employeeRepo.getHeadCount(storeIds);
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }
  getResignedEmployee(storeIds = null) {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.employeeRepo.getResignedEmployee(storeIds);
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }
  getEmployeeBirthday(storeIds = null) {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.employeeRepo.getEmployeeBirthday(storeIds);
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }
  getEmployeeByFilter(filter, storeIds = null) {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.employeeRepo.getEmployeeByFilter(filter, storeIds);
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }
  getnewJoinee(limit, offset, storeIds = null) {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.employeeRepo.getnewJoinee(limit, offset, storeIds);
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }
  getFamilyDet(storeIds = null) {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.employeeRepo.getFamilyDet(storeIds);
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }
  updateStatus(file) {
    return new Promise(async (resolve, reject) => {
      try {
        await this.employeeRepo.updateStatus(file);
        resolve(200);
      } catch (err) {
        reject(err);
      }
    });
  }
  getBankDetails(storeIds = null) {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.employeeRepo.getBankDetails(storeIds);
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }
  getJoiningAnniversary(storeIds = null) {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.employeeRepo.getJoiningAnniversary(storeIds);
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }
  getNewJoiner(storeIds = null) {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.employeeRepo.getNewJoiner(storeIds);
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }

  getEmployeeByStore(store_id) {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.employeeRepo.getEmployeeByStore(store_id);
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }
  /** Active employees at one outlet, id and name only. See the route. */
  getDirectory(store_id) {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.employeeRepo.getDirectoryByStore(store_id);
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }
  getEmployeeById(employee_id) {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.employeeRepo.getById(employee_id);
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }
  updateEmployeeDetails(employee) {
    return new Promise(async (resolve, reject) => {
      try {
        const employee_id = employee.employee_id;
        // Before ANY write - documents and the image included - so a refused
        // joining date leaves the record exactly as it was.
        await this._requireJoiningDateForUpdate(employee_id, employee.employee_details);
        if (
          employee.employee_details.docupdate &&
          employee.employee_details.docupdate.length !== 0
        ) {
          for (let i = 0; i < employee.employee_details.docupdate.length; i++) {
            await this.documentUsecase.update({
              data: employee.employee_details.docupdate[i],
              card_type: employee.employee_details.docupdate[i].card_type,
              employee_id: employee_id,
            });
          }
        }

        const id_card_name = employee.employee_details.files?.[0]?.id_card_name;
        if (employee.employee_details.files && id_card_name !== "") {
          for (
            let i = 0;
            i <= employee.employee_details.files.length - 1;
            i++
          ) {
            await this.documentUsecase.create({
              card_type: employee.employee_details.files[i].id_card,
              card_no: employee.employee_details.files[i].id_card_no,
              card_name: employee.employee_details.files[i].id_card_name,
              expiry_date:
                employee.employee_details.files[i].expiry_date == ""
                  ? null
                  : moment(
                      employee.employee_details.files[i].expiry_date
                    ).format("YYYY-MM-DD"),
              file: employee.employee_details.files[i].file,
              employee_id: employee_id,
            });
          }
        }

        if (
          employee.employee_details.modified_employee_image &&
          employee.employee_details.modified_employee_image !== ""
        ) {
          await this.employeeRepo.updateEmployeeImage(
            employee.employee_details.modified_employee_image,
            employee_id
          );
        }

        delete employee.employee_details.docupdate;
        delete employee.employee_details.modified_employee_image;
        const { code } = await this.employeeRepo.updateEmployeeDetails(
          employee.employee_details,
          employee_id
        );
        resolve(code);
      } catch (err) {
        reject(err);
      }
    });
  }

  create(employee) {
    return new Promise(async (resolve, reject) => {
      try {
        this._requireJoiningDateForCreate(employee.date_of_joining);
        const { code, id } = await this.employeeRepo.create(employee);
        const id_card = employee?.files ? employee?.files[0]?.id_card : null;

        if (id_card && id_card !== "") {
          for (let i = 0; i <= employee.files.length - 1; i++) {
            await this.documentUsecase.create({
              card_type: employee.files[i].id_card,
              card_no: employee.files[i].id_card_no,
              card_name: employee.files[i].id_card_name,
              expiry_date:
                employee.files[i].expiry_date == ""
                  ? null
                  : moment(employee.files[i].expiry_date).format("YYYY-MM-DD"),
              file: employee.files[i].file,
              employee_id: id,
            });
          }
        }

        // Stage 0A: a login is provisioned without a usable password when
        // secure provisioning is on (Deployment B). Before that, the
        // historical default is still produced — but hashed with scrypt,
        // never SHA-1, and flagged must_change_password from the start.
        if (authConfig.provisioning.secure) {
          await this.userRepo.createLogin(
            employee.primary_contact_number,
            "1",
            id,
            null,
            { mustChange: true, flagReason: "setup_pending" }
          );
        } else {
          const hash = await passwordService.hash("password");
          await this.userRepo.createLogin(
            employee.primary_contact_number,
            "1",
            id,
            hash,
            { mustChange: true, flagReason: "provisioning_default" }
          );
        }
        resolve(200);
      } catch (err) {
        reject(err);
        console.log(err);
      }
    });
  }

  async bulkCreate(rows) {
    try {
      // Every row, before the one statement that writes them all: this is an
      // INSERT ... ON DUPLICATE KEY UPDATE, so a row is either a new employee
      // or an overwrite of the stored date, and both are recording one.
      for (const row of rows || []) this._requireJoiningDateForCreate(row && row.date_of_joining);
      const res = await this.employeeRepo.bulkCreate(rows);

      for (const item of rows) {
        if (item.primary_contact_number) {
          if (authConfig.provisioning.secure) {
            // Deployment B: no password at all until a setup token is redeemed.
            await this.userRepo.createLoginIfNeeded(
              item.employee_id,
              "1",
              item.employee_id,
              null,
              { mustChange: true, flagReason: "setup_pending" }
            );
          } else {
            // Deployment A: the historical default survives for continuity,
            // but is stored as scrypt and the account is flagged.
            const hash = await passwordService.hash(item.employee_id + "@123");
            await this.userRepo.createLoginIfNeeded(
              item.employee_id,
              "1",
              item.employee_id,
              hash,
              { mustChange: true, flagReason: "provisioning_default" }
            );
          }
        }
      }

      return res;
    } catch (err) {
      console.log(err);
    }
  }

}

module.exports = (employeeRepo, documentUsecase, userRepo, resignationRepo) => {
  return new EmployeeUsecase(
    employeeRepo,
    documentUsecase,
    userRepo,
    resignationRepo
  );
};
