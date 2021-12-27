const jwt = require("../services/jwt");
// const SMS = require("../services/sms");

class UserUsecase {
    constructor(userRepo) {
        this.userRepo = userRepo;
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

                resolve({ code: 200, token: token });
            } catch (err) {
                reject(err);
            }
        });
    }
}

module.exports = (userRepo) => {
    return new UserUsecase(userRepo);
};
