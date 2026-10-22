const express = require("express");

/**
 * The one key every Article Store Master endpoint requires: the same one as
 * the All Products screen it sits beside in the Master menu. (An existing
 * key, so the report needs no migration.)
 */
const VIEW_ARTICLE_STORE_MASTER = "view_products";

/**
 * Article Store Master report (usecase/article_store_master.js).
 *
 *   GET  /status    the newest file on disk and whether a build is running
 *   GET  /download  that file, as an .xlsx attachment
 *   POST /refresh   start a build now; the screen polls /status for the end
 */
class ArticleStoreMasterRoutes {
  constructor(report, permissions) {
    this.report = report;
    this.permissions = permissions;
    this.router = express.Router();
    this.init();
  }

  init() {
    const allowed = this.permissions.require(VIEW_ARTICLE_STORE_MASTER);

    this.router.get("/status", allowed, (req, res) => {
      try {
        res.json(this.report.status());
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: err.message });
      }
    });

    this.router.get("/download", allowed, (req, res) => {
      try {
        const latest = this.report.latest();
        if (!latest) {
          return res.json({ code: 404, msg: "The report has not been built yet. Use Refresh now, or try again after 5:45 AM." });
        }
        res.download(latest.path, latest.file);
      } catch (err) {
        console.log(err);
        res.json({ code: 500, msg: err.message });
      }
    });

    this.router.post("/refresh", allowed, (req, res) => {
      // Takes a minute or two: answer at once, build in the background.
      this.report.build().catch((err) => console.log(err));
      res.json({ code: 200, started: true });
    });
  }

  getRouter() {
    return this.router;
  }
}

module.exports = (report, permissions) => new ArticleStoreMasterRoutes(report, permissions);
module.exports.VIEW_ARTICLE_STORE_MASTER = VIEW_ARTICLE_STORE_MASTER;
