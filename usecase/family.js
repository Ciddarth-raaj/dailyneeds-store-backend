
/**
 * Step one of moving `employee_family` off `employee_name` and onto
 * `employee_id` - see the header of repository/family.js for the whole plan.
 *
 * The resolution rule lives here, in one place, so create and update cannot
 * disagree about which employee a record belongs to.
 */
class FamilyUsecase {
    constructor(familyRepo) {
        this.familyRepo = familyRepo;
    }

    /**
     * The employee id for a record being written: what the caller sent, or
     * the name resolved when it identifies exactly one employee.
     *
     * A trusted id wins outright - the screen picks the employee from a list
     * that carries ids, so it knows which of two namesakes was meant and the
     * name cannot tell us. Otherwise the name is resolved, and an ambiguous
     * or unknown name yields null: the record is stored unattached rather
     * than attached to a guess. Migration
     * 20260926120000-employee-family-key reports those rows so HR can attach
     * them by hand.
     */
    async _resolveEmployeeId({ employee_id, employee_name }) {
        const asId = Number(employee_id);
        if (Number.isInteger(asId) && asId > 0) return asId;
        if (!employee_name) return null;
        if (!this.familyRepo.findEmployeeIdByName) return null;
        return await this.familyRepo.findEmployeeIdByName(employee_name);
    }

    get() {
        return new Promise(async (resolve, reject) => {
            try {
                const data = await this.familyRepo.get();
                resolve(data);
            } catch (err) {
                reject(err);
            }
        });
    }

    /** By the permanent id. The read the cutover is heading for. */
    getFamilyByEmployeeId(employee_id) {
      return new Promise(async (resolve, reject) => {
        try {
          const id = Number(employee_id);
          if (!Number.isInteger(id) || id <= 0) {
            const err = new Error("employee_id must be an employee id");
            err.name = "ValidationError";
            throw err;
          }
          const data = await this.familyRepo.getFamilyByEmployeeId(id);
          resolve(data);
        } catch (err) {
          reject(err);
        }
      });
    }

    getFamilyByEmployee(employee_name) {
      return new Promise(async (resolve, reject) => {
        try {
          const data = await this.familyRepo.getFamilyByEmployee(employee_name);
          resolve(data);
        } catch (err) {
          console.log(err);
          reject(err);
        }
      });
    }

    getFamilyById(family_id) {
        return new Promise(async (resolve, reject) => {
          try {
            const data = await this.familyRepo.getFamilyById(family_id);
            resolve(data);
          } catch (err) {
            console.log(err);
            reject(err);
          }
        });
      }
      updateFamilyDetails(family) {
        return new Promise(async (resolve, reject) => {
          try {
            const family_id = family.family_id;
            const details = { ...(family.family_details || {}) };
            // Keep the two columns in agreement. An edit that moves the
            // record to a different employee - or names one for the first
            // time - must move the id with it, or the row would still read
            // correctly by name and wrongly by id.
            if (details.employee_id !== undefined || details.employee_name !== undefined) {
              details.employee_id = await this._resolveEmployeeId(details);
            }
            const { code } = await this.familyRepo.updateFamilyDetails(details, family_id);
            resolve(code);
          } catch (err) {
            reject(err);
          }
        });
      }
    create(family) {
        return new Promise(async (resolve, reject) => {
            try {
                const employee_id = await this._resolveEmployeeId(family);
                // AWAITED. This used to call the repository without awaiting
                // it and resolve 200 unconditionally, so a rejected insert
                // was reported to the screen as a successful save and the
                // repository's own duplicate branch (code 101) could never
                // be reached. Both are now the caller's answer.
                const result = await this.familyRepo.create({ ...family, employee_id });
                resolve(result && result.code !== undefined ? result.code : 200);
            } catch (err) {
                reject(err);
            }
        });
    }

}

module.exports = (familyRepo) => {
    return new FamilyUsecase(familyRepo);
};
