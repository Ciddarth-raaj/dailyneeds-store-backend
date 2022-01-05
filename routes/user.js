const router = require("express").Router();
const Joi = require("@hapi/joi");

class UserRoutes {
    constructor(userUsecase) {
        this.userUsecase = userUsecase;
        this.init();
    }

    init() {
        router.post("/login", async (req, res) => {
            try {
                const schema = {
                    username: Joi.string().trim().required(),
                    password: Joi.string().trim().required(),
                };

                const credentials = req.query;
                const isValid = Joi.validate(credentials, schema);
                if (isValid.error !== null) {
                    throw isValid.error;
                }

                const data = await this.userUsecase.login(credentials.username, credentials.password);
                if (data.code === 200) {
                    res.json({ data });
                } else {
                    res.status(400).json({ msg: "Incorrect credentials", code: 400 });
                }
            } catch (err) {
                console.log(err)
                if (err.name === "ValidationError") {
                    res.status(422).json({ msg: err.toString() });
                } else {
                    res.status(500).json({
                        code: 500,
                        msg: "An error occurred !",
                    });
                }
            }

            res.end();
        });
    }

    getRouter() {
        return router;
    }
}

module.exports = (userUsecase) => {
    return new UserRoutes(userUsecase);
};
