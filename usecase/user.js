const jwt = require("../services/jwt");
// const SMS = require("../services/sms");

class UserUsecase {
    constructor(userRepo, designationRepo, employeeRepo) {
        this.userRepo = userRepo;
        this.designationRepo = designationRepo;
        this.employeeRepo = employeeRepo
    }

    login(username, password) {
        return new Promise(async (resolve, reject) => {
            try {
                const details = await this.userRepo.login(username, password);
                const name = await this.employeeRepo.getNameById(username);
                if (details.length === 0) {
                    resolve({ code: 204 });
                    return;
                }

                const info = {};
                info.id = details[0].user_id;
                info.store_id = details[0].store_id;
                info.designation_id = details[0].designation_id;
                info.employee_id = details[0].employee_id;
                info.user_type = details[0].user_type;
                info.name = name[0]?.employee_name;
                info.designation = name[0]?.designation_name;
                info.employee_image = name[0]?.employee_image

                const token = await jwt.sign(info, "30d");
                resolve({ 
                    code: 200, 
                    token: token,
                    store_id: info.store_id,
                    designation_id: info.designation_id,
                    employee_id: info.employee_id,
                    user_type: info.user_type,
                    name: info.name,
                    designation: info.designation,
                    employee_image: info.employee_image
                });
            } catch (err) {
                reject(err);
            }
        });
    }
}

module.exports = (userRepo, designationRepo, employeeRepo) => {
    return new UserUsecase(userRepo, designationRepo, employeeRepo);
};
