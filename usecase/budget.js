class BudgetRepo {
  constructor(budgetRepo) {
    this.budgetRepo = budgetRepo;
  }

  get(limit, offset, store_id) {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.budgetRepo.get(limit, offset, store_id);
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }
  getBudgetById(budget_id) {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.budgetRepo.getBudgetById(budget_id);
        resolve(data);
      } catch (err) {
        console.log(err);
        reject(err);
      }
    });
  }
  getBudgetByStoreId(store_id) {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.budgetRepo.getBudgetByStoreId(store_id);
        resolve(data);
      } catch (err) {
        console.log(err);
        reject(err);
      }
    });
  }
  getBudgetByStore(store_id) {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.budgetRepo.getBudgetByStore(store_id);
        resolve(data);
      } catch (err) {
        console.log(err);
        reject(err);
      }
    });
  }
  create(budget) {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.budgetRepo.create(budget);
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }
}

module.exports = (budgetRepo) => {
  return new BudgetRepo(budgetRepo);
};
