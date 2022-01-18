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
        router.get("/vehiclecount", async (req, res) => {
            try {
              const vehicle = await this.vehicleUsecase.getVehicleCount();
              res.json(vehicle);
            } catch (err) {
                console.log(err);
              if (err.name === "ValidationError") {
                res.json({ code: 422, msg: err.toString() });
              } else {
                res.json({ code: 500, msg: "An error occurred !" });
              }
            }
          });
        router.get("/vehicledet", async (req, res) => {
            try {
              const schema = {
                limit: Joi.number().required(),
                offset: Joi.number().required(),
              };
              const data = req.query;
      
              const vehicle = await this.vehicleUsecase.getVehicle(data.limit, data.offset);
              res.json(vehicle);
            } catch (err) {
              res.status(500).json({ code: 500, msg: "An error occurred !" });
            }
          });
          router.post("/create", async (req, res) => {
            try {
              const schema = {
                vehicle_name: Joi.string().required(),
			    vehicle_number: Joi.string().required(),
			    chasis_number: Joi.string().required(),
			    engine_number: Joi.string().required(),
			    fc_validity: Joi.string().required(),
			    insurance_validity: Joi.string().required()
              };
      
              const vehicle = req.body;
              const isValid = Joi.validate(vehicle, schema);
      
              if (isValid.error !== null) {
                console.log(isValid.error);
                throw isValid.error;
              }
              const response = await this.vehicleUsecase.create(vehicle);
      
              res.json(response);
            } catch (err) {
              if (err.name === "ValidationError") {
                res.json({ code: 422, msg: err.toString() });
              } else {
                console.log(err);
                res.json({ code: 500, msg: err.message });
              }
            }
      
            res.end();
          });
          router.post("/update-vehicle", async (req, res) => {
            try {
              const schema = {
                vehicle_id: Joi.number().required(),
                vehicle_details: Joi.object({
                    vehicle_name: Joi.string().required(),
                    vehicle_number: Joi.string().required(),
                    chasis_number: Joi.string().required(),
                    engine_number: Joi.string().required(),
                    fc_validity: Joi.string().required(),
                    insurance_validity: Joi.string().required()
                }).optional(),
              };
      
              const vehicle = req.body;
              const isValid = Joi.validate(vehicle, schema);
              if (isValid.error !== null) {
                  console.log(isValid.error)
                throw isValid.error;
              }
      
              const code = await this.vehicleUsecase.updateVehicleDetails(vehicle);
              res.json({ code: code });
            } catch (err) {
              if (err.name === "ValidationError") {
                res.json({ code: 422, msg: err.toString() });
              } else {
                console.log(err);
                res.json({ code: 500, msg: "An error occurred !" });
              }
            }
            res.end();
          });
          router.get("/vehicle_id", async (req, res) => {
            try {
              const schema = {
                vehicle_id: Joi.string().required(),
              };
              const vehicle = req.query;
              const isValid = Joi.validate(vehicle, schema);
              if (isValid.error !== null) {
                throw isValid.error;
              }
              const data = await this.vehicleUsecase.getVehicleById(
                vehicle.vehicle_id
              );
              res.json(data);
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
