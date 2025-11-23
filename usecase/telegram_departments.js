class TelegramDepartmentsUsecase {
  constructor(telegramDepartmentsRepo) {
    this.telegramDepartmentsRepo = telegramDepartmentsRepo;
  }

  create(department) {
    return new Promise(async (resolve, reject) => {
      try {
        const result = await this.telegramDepartmentsRepo.create(department);
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
  }

  getAll(limit, offset) {
    return new Promise(async (resolve, reject) => {
      try {
        const departments = await this.telegramDepartmentsRepo.getAll(
          limit,
          offset
        );
        resolve(departments);
      } catch (err) {
        reject(err);
      }
    });
  }

  getById(id) {
    return new Promise(async (resolve, reject) => {
      try {
        const department = await this.telegramDepartmentsRepo.getById(id);
        resolve(department);
      } catch (err) {
        reject(err);
      }
    });
  }

  update(id, department) {
    return new Promise(async (resolve, reject) => {
      try {
        const result = await this.telegramDepartmentsRepo.update(id, department);
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
  }

  delete(id) {
    return new Promise(async (resolve, reject) => {
      try {
        const result = await this.telegramDepartmentsRepo.delete(id);
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
  }

  getCount() {
    return new Promise(async (resolve, reject) => {
      try {
        const count = await this.telegramDepartmentsRepo.getCount();
        resolve(count);
      } catch (err) {
        reject(err);
      }
    });
  }
}

module.exports = (telegramDepartmentsRepo) => {
  return new TelegramDepartmentsUsecase(telegramDepartmentsRepo);
};

