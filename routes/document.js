const router = require("express").Router();

class DocumentRoutes {
  constructor(documentUsecase) {
    this.documentUsecase = documentUsecase;
    this.init();
  }

  init() {
    router.get("/", async (req, res) => {
      try {
        const document = await this.documentUsecase.get();
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
