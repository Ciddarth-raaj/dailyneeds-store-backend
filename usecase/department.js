
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

}

module.exports = (departmentRepo) => {
    return new DepartmentUsecase(departmentRepo);
};
