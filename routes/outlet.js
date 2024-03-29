const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http")

class OutletRoutes {
    constructor(outletUsecase) {
        this.outletUsecase = outletUsecase;

        this.init();
    }

    init() {
        router.get("/", async (req, res) => {
            try {
                const outlet = await this.outletUsecase.get();
                res.json(outlet);
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
        router.get("/outlet_id", async (req, res) => {
          try {
            const schema = {
              outlet_id: Joi.string().required(),
            }
            const outlet = req.query;
            // console.log({store: store})
            const isValid = Joi.validate(outlet, schema);
            if (isValid.error !== null) {
              throw isValid.error;
            }
            const data = await this.outletUsecase.getOutletById(outlet.outlet_id);
            // console.log({data: data});
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
        router.get("/id", async (req, res) => {
          try {
            const schema = {
              outlet_id: Joi.string().required(),
            }
            const outlet = req.query;
            
            const isValid = Joi.validate(outlet, schema);
            if (isValid.error !== null) {
              throw isValid.error;
            }
            const data = await this.outletUsecase.getOutletByOutletId(outlet.outlet_id);
            // console.log({data: data});
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
        router.post("/update-status", async (req, res) => {
          try {
            const schema = {
              outlet_id: Joi.number().required(),
              is_active: Joi.number().required(),
            };
    
            const outlet = req.body;
            const isValid = Joi.validate(outlet, schema);
            if (isValid.error !== null) {
              throw isValid.error;
            }
    
            const code = await this.outletUsecase.updateStatus(outlet);
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
        router.post("/update-outlet", async (req, res) => {
          try {
            const schema = {
              outlet_id: Joi.number().required(),
              store_id: Joi.number().optional(),
              outlet_details: Joi.object({
                outlet_name: Joi.string().optional(),
                outlet_address: Joi.string().optional(),
                outlet_phone: Joi.string().optional(),
                phone: Joi.string().optional(),
                outlet_nickname: Joi.string().optional(),
              }).optional(),
            };
  
            const outlet = req.body;
            const isValid = Joi.validate(outlet, schema);
            if (isValid.error !== null) {
              console.log({error: isValid.error});
              throw isValid.error;
            }
    
            const code = await this.outletUsecase.updateOutletDetails(outlet);
            // console.log({code: code});
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

        router.post("/create", async (req, res) => {
            try {
              const schema = {
                outlet_details: Joi.object({
                outlet_name: Joi.string().required(),
                outlet_address: Joi.string().required(),
                outlet_phone: Joi.number().min(100000000).max(99999999999).optional(),
                phone: Joi.number().min(100000000).max(99999999999).optional(),
                outlet_nickname: Joi.string().required(),
                // is_active: Joi.number().required()
                }).optional(),
                budget: Joi.array().allow(null).allow('').required(),
              };
              const outlet = req.body;
              const isValid = Joi.validate(outlet, schema);
      
              if (isValid.error !== null) {
                throw isValid.error;
              }
              const response = await this.outletUsecase.create(outlet);
      
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
    } 
    
    getRouter() {
        return router;
    }
}

module.exports = (outletUsecase) => {
    return new OutletRoutes(outletUsecase);
};
