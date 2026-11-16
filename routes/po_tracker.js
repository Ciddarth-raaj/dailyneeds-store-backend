const respondError = require("../utils/http");

/**
 * PO Tracker (/po-tracker), live from RetailPilot. Read-only, for buyers:
 * behind `view_po_tracker`.
 *
 *   GET /po-tracker?refresh=1   latest POs per store and supplier
 */
class PoTrackerRoutes {
  constructor(usecase, permissions) {
    this.usecase = usecase;
    this.permissions = permissions;
    this.router = require("express").Router();
    this.init();
  }

  init() {
    const guard = this.permissions
      ? this.permissions.require("view_po_tracker")
      : (req, res) => res.status(403).json({ code: 403, msg: "You do not have permission to perform this action" });

    this.router.get("/", guard, async (req, res) => {
      try {
        const result = await this.usecase.list({ refresh: String(req.query.refresh || "") === "1" });
        if (result.code === 200) return res.json(result);
        return res.status(result.code === 502 ? 502 : 400).json(result);
      } catch (err) {
        respondError(res, err);
      }
    });
  }

  getRouter() {
    return this.router;
  }
}

module.exports = (usecase, permissions) => new PoTrackerRoutes(usecase, permissions);
