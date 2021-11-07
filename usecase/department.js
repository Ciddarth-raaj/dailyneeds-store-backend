
class DepartmentUsecase {
  constructor(departmentRepo) {
    this.departmentRepo = departmentRepo;
  }

  get() {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.departmentRepo.get();
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });

  }

  updateStatus(file) {
    return new Promise(async (resolve, reject) => {
      try {
        await this.departmentRepo.updateStatus(file);
        resolve(200);
      } catch (err) {
        reject(err);
      }
    });
  }

  updateDepartmentDetails(department) {
    return new Promise(async (resolve, reject) => {
      try {
        const department_id = department.department_id;
        const { code } = await this.departmentRepo.updateDepartmentDetails(department.department_details, department_id);
        resolve(code);
      } catch (err) {
        reject(err);
      }
    });
  }

  getDepartmentById(department_id) {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.departmentRepo.getById(department_id);
        resolve(data);
      } catch (err) {
        console.log(err);
        reject(err);
      }
    });
  }

  create(department) {
    return new Promise(async (resolve, reject) => {
      try {
        this.departmentRepo.create(department);
        resolve(200);
      } catch (err) {
        reject(err);
      }
    });
  }

  upsert(department) {
    return new Promise(async (resolve, reject) => {
      try {
        await this.departmentRepo.upsert(department);
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  }
}

module.exports = (departmentRepo) => {
  return new DepartmentUsecase(departmentRepo);
};
