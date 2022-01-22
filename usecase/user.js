const jwt = require("../services/jwt");
// const SMS = require("../services/sms");

class UserUsecase {
    constructor(userRepo, designationRepo) {
        this.userRepo = userRepo;
        this.designationRepo = designationRepo;
    }

    login(username, password) {
        return new Promise(async (resolve, reject) => {
            try {
                const details = await this.userRepo.login(username, password);

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

                const token = await jwt.sign(info, "30d");
                resolve({ 
                    code: 200, 
                    token: token,
                    store_id: info.store_id,
                    designation_id: info.designation_id,
                    employee_id: info.employee_id,
                    user_type: info.user_type 
                });
            } catch (err) {
                reject(err);
            }
        });
    }
}

module.exports = (userRepo, designationRepo) => {
    return new UserUsecase(userRepo, designationRepo);
};
