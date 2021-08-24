
class EmployeeUsecase {
    constructor(employeeRepo) {
        this.employeeRepo = employeeRepo;
    }

    create(employee) {
        return new Promise(async (resolve, reject) => {
            try {
                console.log({jesus: employee});
                this.employeeRepo.create(employee);
                resolve(200);
            } catch (err) {
                reject(err);
            }
        });
    }

}

module.exports = (employeeRepo) => {
    return new EmployeeUsecase(employeeRepo);
};
