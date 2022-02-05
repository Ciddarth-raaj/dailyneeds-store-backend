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
        const { code } = await this.designationRepo.updateDesignationDetails(designation.designation_details, designation_id);  
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
        resolve(data);
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
        if(designation_id !== 4) {
            data = await this.designationRepo.getPermissionById(designation_id, user_type);
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
        const data = await this.designationRepo.getDesignationCount()
        resolve(data)
      } catch (err) {
        reject(err);
      }
    })
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
}

module.exports = (designationRepo) => {
  return new DesignationUsecase(designationRepo);
};
