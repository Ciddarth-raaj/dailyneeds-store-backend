const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http")

class WhatsappRoutes {
  constructor(whatsappUsecase) {
    this.whatsappUsecase = whatsappUsecase;

    this.init();
  }

  init() {
    router.get("/", async (req, res) => {
        try {
          const whatsapp = await this.whatsappUsecase.get();
          res.json(whatsapp);
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
            order_id: Joi.number().required(),
            status: Joi.number().required(),
          };
  
          const whatsapp = req.body;
          const isValid = Joi.validate(whatsapp, schema);
          if (isValid.error !== null) {
            throw isValid.error;
          }
  
          const code = await this.whatsappUsecase.updateStatus(whatsapp);
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

      router.post("/update-whatsapp", async (req, res) => {
        try {
          const schema = {
            order_id: Joi.number().required(),

            whatsapp_details: Joi.object({
                first_name: Joi.string().optional(),
                last_name: Joi.string().optional(),
                primary_address: Joi.string().optional(),
                city: Joi.string().optional(),
                mobile_no: Joi.number().optional(),
                pin_code: Joi.number().optional(),
                payment_type: Joi.string().optional(),
                order_text: Joi.string().optional(),
                attached_image: Joi.string().optional(),
            }).optional(),
          };

          const whatsapp = req.body;
          const isValid = Joi.validate(whatsapp, schema);
          if (isValid.error !== null) {
            throw isValid.error;
          }
  
          const code = await this.whatsappUsecase.updateWhatsappDetails(whatsapp);
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
      router.get("/order_id", async (req, res) => {
        try {
          const schema = {
            order_id: Joi.string().required(),
          }
          const whatsapp = req.query;
          const isValid = Joi.validate(whatsapp, schema);
          if (isValid.error !== null) {
            throw isValid.error;
          }
          const data = await this.whatsappUsecase.getWhatsappById(whatsapp.order_id);
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
    router.post("/create", async (req, res) => {
        try {
          const schema = {
            // status: Joi.string().required(),
            first_name: Joi.string().required(),
            last_name: Joi.string().required(),
            primary_address: Joi.string().required(),
            city: Joi.string().required(),
            mobile_no: Joi.number().required(),
            pin_code: Joi.number().required(),
            payment_type: Joi.string().required(),
            order_text: Joi.string().required(),
            attached_image: Joi.string().required(),
          };
  
          const whatsapp = req.body;
          const isValid = Joi.validate(whatsapp, schema);
  
          if (isValid.error !== null) {
            console.log(isValid.error);
            throw isValid.error;
          }
          const response = await this.whatsappUsecase.create(whatsapp);
  
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

module.exports = (whatsappUsecase) => {
  return new WhatsappRoutes(whatsappUsecase);
};
