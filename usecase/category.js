class CategoryUsecase {
  constructor(categoryRepo) {
    this.categoryRepo = categoryRepo;
  }

  getAll() {
    return new Promise(async (resolve, reject) => {
      try {
        const categories = await this.categoryRepo.getAll();
        resolve(categories);
      } catch (err) {
        reject(err);
      }
    });
  }

  update(category) {
    return new Promise(async (resolve, reject) => {
      try {
        await this.categoryRepo.update(category);
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  }

  upsert(category) {
    return new Promise(async (resolve, reject) => {
      try {
        await this.categoryRepo.upsert(category);
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  }
}

module.exports = (categoryRepo) => {
  return new CategoryUsecase(categoryRepo);
};