const router = require("express").Router();
const Joi = require("@hapi/joi");

class DocumentRoutes {
  constructor(documentUsecase) {
    this.documentUsecase = documentUsecase;
    this.init();
  }

  init() {
    router.get("/employee_id", async (req, res) => {
      try {
        const schema = {
          employee_id: Joi.number().required(),
        }
        const document = req.query;
        const isValid = Joi.validate(document, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }
        const data = await this.documentUsecase.get(document.employee_id);
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
    router.get("/document_id", async (req, res) => {
      try {
        const schema = {
          document_id: Joi.number().required(),
        }
        const document = req.query;
        const isValid = Joi.validate(document, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }
        const data = await this.documentUsecase.getDocumentById(document.document_id);
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
          document_id: Joi.number().required(),
          status: Joi.number().required(),
        };

        const document = req.body;
        const isValid = Joi.validate(document, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const code = await this.documentUsecase.updateStatus(document);
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
    router.post("/update-document", async (req, res) => {
      try {
        const schema = {
          document_id: Joi.number().required(),
          is_verified: Joi.number().required(),
        };

        const document = req.body;
        const isValid = Joi.validate(document, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const code = await this.documentUsecase.updateVerification(document);
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
  
    router.get("/adhaar", async (req, res) => {
      try {
        const document = await this.documentUsecase.getAdhaar();
        res.json(document);
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
    router.get("/withoutadhaar", async (req, res) => {
      try {
        const document = await this.documentUsecase.getDocumentsWithoutAdhaar();
        res.json(document);
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
    router.get("/all", async (req, res) => {
      try {
        const document = await this.documentUsecase.getAllDocuments();
        res.json(document);
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

module.exports = (documentUsecase) => {
  return new DocumentRoutes(documentUsecase);
};
