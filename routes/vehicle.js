const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http")

class VehicleRoutes {
    constructor(vehicleUsecase) {
        this.vehicleUsecase = vehicleUsecase;

        this.init();
    }

    init() {
        router.get("/", async (req, res) => {
            try {
                const vehicle = await this.vehicleUsecase.get();
                res.json(vehicle);
            } catch (err) {
                console.log(err);
                if (err.name === "ValidationError") {
                    res.json({ code: 422, msg: err.toString() });
                } else {
                    res.json({ code: 500, msg: "An error occurred !" });
                }
            }

            res.end();
        });
    } 
    
    getRouter() {
        return router;
    }
}

module.exports = (vehicleUsecase) => {
    return new VehicleRoutes(vehicleUsecase);
};
