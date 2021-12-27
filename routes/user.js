const router = require("express").Router();
const Joi = require("@hapi/joi");

class UserRoutes {
    constructor(userUsecase) {
        this.userUsecase = userUsecase;
        this.init();
    }

    init() {
        router.post("/login/password", async (req, res) => {
            try {
                const schema = {
                    username: Joi.string().trim().required(),
                    password: Joi.string().trim().required(),
                };

                const credentials = req.body;

                const isValid = Joi.validate(credentials, schema);
                if (isValid.error !== null) {
                    throw isValid.error;
                }

                const { code, token } = await this.userUsecase.login(credentials.username, credentials.password);

                if (code === 200) {
                    res.json({ token });
                } else {
                    res.status(400).json({ msg: "Incorrect credentials" });
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
