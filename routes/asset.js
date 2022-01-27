const router = require("express").Router();

class AssetRoutes {
  constructor(assetUsecase) {
    this.assetUsecase = assetUsecase;
    this.init();
  }

  init() {
    // router.use("/", (req, res, next) => {
    //   if (!req.decoded || req.decoded.role != "admin") {
    //     res.status(406);
    //     res.end();
    //     return;
    //   }
    //   next();
    // });

    router.post("/", async (req, res) => {
      try {
        const resp = await this.assetUsecase.upload(req);
        res.status(resp.code).json({ ...resp });
      } catch (err) {
        console.log(err);
        if (err.name === "ValidationError") {
          res.status(422).json({ msg: err.toString() });
        } else {
          res.status(500).json({ code: 500, msg: "An error occurred !" });
        }
      }

      res.end();
    });
  }

  getRouter() {
    return router;
  }
}

module.exports = (assetUsecase) => {
  return new AssetRoutes(assetUsecase);
};
