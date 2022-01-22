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
                const data = await this.budgetRepo.get(10, 0, budget.store_id)
                const arr = budget.budget.filter(n => n)
                const dataArr = data.map(datum => datum.designation_name); 

                for (let i = 0; i <= arr.length - 1; i++) {
                    if (dataArr.indexOf(Object.keys(arr[i])[0]) >= 0) {
                        this.budgetRepo.update({
                            store_id: budget.store_id,
                            designation_name: Object.keys(arr[i])[0],
                            budget: Object.values(arr[i])[0]
                        });
                        // delete arr[i];
                    } else {
                        this.budgetRepo.create({
                            store_id: budget.store_id,
                            designation_name: Object.keys(arr[i])[0],
                            budget: Object.values(arr[i])[0]
                        });
                    }
                }
                // console.lg(d);
                // for (let i = 0; i <= budget.budget.length - 1; i++) {
                //    this.budgetRepo.create({
                //         store_id: budget.store_id,
                //         designation_name: Object.keys(budget.budget[i])[0],
                //         budget: Object.values(budget.budget[i])[0]
                //     });
                // }
                resolve(200);
            } catch (err) {
                reject(err);
            }
        });
    }
}

module.exports = (budgetRepo) => {
    return new BudgetRepo(budgetRepo);
};
