const router = require("express").Router();
const P = require("../constants/hr_permissions");
const Joi = require("@hapi/joi");

class DocumentRoutes {
  constructor(documentUsecase, permissions, sensitive) {
    this.permissions = permissions;
    this.sensitive = sensitive;
    this.documentUsecase = documentUsecase;
    this.init();
  }

  init() {
    // Stage 0B / B3. Ordinary document access stays under view_documents;
    // an Aadhaar or PAN row - card_type 1 or 4 - is dropped entirely for a
    // caller without view_employee_sensitive, because its `file` is the S3
    // path to a scan of the document itself. Two of these queries are
    // SELECT * joined onto new_employee, so the same guard also removes the
    // employee's salary and bank columns from the joined rows.
    router.use(this.sensitive.filterResponse);
    router.use(this.sensitive.guardWrite);

    // A request that names an Aadhaar or PAN document by id says nothing
    // sensitive in its body, so the body-level guard above cannot see it.
    // This one asks the repository for that document's TYPE only - never its
    // number or its S3 path - and requires edit_employee_sensitive on top of
    // the route's own add_documents. Ordinary document types are untouched.
    const sensitiveTarget = this.sensitive.guardTarget((document_id) =>
      this.documentUsecase.getCardTypeById(document_id)
    );

    router.get("/employee_id", this.permissions.require(P.VIEW_DOCUMENTS), async (req, res) => {
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
    router.get("/document_id", this.permissions.require(P.VIEW_DOCUMENTS), async (req, res) => {
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
    router.post("/update-status", this.permissions.require(P.ADD_DOCUMENTS), sensitiveTarget, async (req, res) => {
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
    router.post("/update-document", this.permissions.require(P.ADD_DOCUMENTS), sensitiveTarget, async (req, res) => {
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
  
    router.get("/adhaar", this.permissions.require(P.VIEW_EMPLOYEE_SENSITIVE), async (req, res) => {
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
    router.get("/withoutadhaar", this.permissions.require(P.VIEW_DOCUMENTS), async (req, res) => {
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
    router.get("/all", this.permissions.require(P.VIEW_DOCUMENTS), async (req, res) => {
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

module.exports = (documentUsecase, permissions, sensitive) => {
  return new DocumentRoutes(documentUsecase, permissions, sensitive);
};
