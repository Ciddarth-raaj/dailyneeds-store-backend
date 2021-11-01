const router = require("express").Router();
const Joi = require("@hapi/joi");
const respondError = require("../utils/http")

class ImageRoutes {
  constructor(imageUsecase) {
    this.imageUsecase = imageUsecase;

    this.init();
  }

  init() {
      router.get("/product_id", async (req, res) => {
        try {
          const schema = {
            product_id: Joi.string().required(),
          }
          const image = req.query;
          const isValid = Joi.validate(image, schema);
          if (isValid.error !== null) {
              console.log(isValid.error);
            throw isValid.error;
          }
          const data = await this.imageUsecase.getImageById(image.product_id);
          console.log(data);
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

module.exports = (imageUsecase) => {
  return new ImageRoutes(imageUsecase);
};
