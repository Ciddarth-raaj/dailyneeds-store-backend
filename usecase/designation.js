class DesignationUsecase {
  constructor(designationRepo) {
    this.designationRepo = designationRepo;
  }

  get() {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.designationRepo.get();
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }
  getDesignationByBudget() {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.designationRepo.getDesignationByBudget();
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }
  updateStatus(file) {
    return new Promise(async (resolve, reject) => {
      try {
        await this.designationRepo.updateStatus(file);
        resolve(200);
      } catch (err) {
        reject(err);
      }
    });
  }
  updateDesignationDetails(designation) {
    return new Promise(async (resolve, reject) => {
      try {
        const designation_id = designation.designation_id;
        const { code } = await this.designationRepo.updateDesignationDetails(
          designation.designation_details,
          designation_id
        );

        if (designation.permissions) {
          await this.designationRepo.deletePermissions(designation_id);

          for (let permission of designation.permissions) {
            await this.designationRepo.createPermission(
              permission,
              designation_id
            );
          }
        }

        resolve(code);
      } catch (err) {
        reject(err);
      }
    });
  }
  getDesignationById(designation_id) {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.designationRepo.getById(designation_id);
        const resp = {
          designations: data,
        };
        resp.permissions = await this.getPermissionById(designation_id, 1);
        resolve(resp);
      } catch (err) {
        console.log(err);
        reject(err);
      }
    });
  }
  getPermissionById(designation_id, user_type) {
    return new Promise(async (resolve, reject) => {
      let data = [];
      try {
        if (designation_id !== 4) {
          data = await this.designationRepo.getPermissionById(
            designation_id,
            user_type
          );
        } else {
          data = await this.designationRepo.getAllPermissions();
        }
        // console.log({data:data})
        resolve(data);
      } catch (err) {
        console.log(err);
        reject(err);
      }
    });
  }
  getDesignationCount() {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.designationRepo.getDesignationCount();
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }
  create(designation) {
    return new Promise(async (resolve, reject) => {
      try {
        const permissions = designation.permissions;
        delete designation.permissions;

        const { code, id } = await this.designationRepo.create(designation);

        if (code == 200) {
          for (let permission of permissions) {
            await this.designationRepo.createPermission(permission, id);
          }
        }

        resolve({ code: 200 });
      } catch (err) {
        reject(err);
      }
    });
  }

  async bulkCreate(rows) {
    try {
      const response = await this.designationRepo.bulkCreate(rows);
      const designations = await this.get();
      response.designations = designations;
      return response;
    } catch (err) {
      throw err;
    }
  }
}

module.exports = (designationRepo) => {
  return new DesignationUsecase(designationRepo);
};
