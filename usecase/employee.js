
class EmployeeUsecase {
    constructor(employeeRepo, documentUsecase) {
        this.employeeRepo = employeeRepo;
        this.documentUsecase = documentUsecase;
    }

    create(employee) {
        return new Promise(async (resolve, reject) => {
            try {
                const { code, id } = await this.employeeRepo.create(employee);

            //to be uncommented after table modification
            
                // for(let i in employee.file) {
                //     console.log({i: i});
                //     await this.documentUsecase.create({
                //         id_card: employee.file[i].id_card,
                //         name: employee.employee_name,
                //         id_card_no: employee.file[i].id_card_no,
                //         file: employee.file[i].file,
                //         employee_id: id,
                //     })
                // }
                resolve(200);
            } catch (err) {
                reject(err);
            }
        });
    }

}

module.exports = (employeeRepo, documentUsecase) => {
    return new EmployeeUsecase(employeeRepo, documentUsecase);
};
