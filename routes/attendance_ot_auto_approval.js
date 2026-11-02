const express = require("express");
const Joi = require("@hapi/joi");
const P = require("../constants/hr_permissions");
const respondError = require("../utils/http");

/**
 * OT AUTO-APPROVAL API - the switch behind Attendance -> OT Auto-Approval.
 *
 *   GET /attendance/ot/auto-approval   the setting as it stands
 *   PUT /attendance/ot/auto-approval   { auto_approve, max_minutes|null }
 *
 * Both require `manage_ot_auto_approval` (granted to nobody by migration;
 * administrators hold it through the user_type 2 bypass). A save takes
 * effect on the next five-minute sweep; switching off undoes nothing already
 * approved. Who saved it is the token's employee - never a body field.
 */
class AttendanceOtAutoApprovalRoutes {
  constructor(usecase, permissions) {
    this.usecase = usecase;
    this.permissions = permissions;
    this.router = express.Router();
    this.init();
  }

  init() {
    const gate = this.permissions.require(P.MANAGE_OT_AUTO_APPROVAL);

    this.router.get("/attendance/ot/auto-approval", gate, async (req, res) => {
      try {
        res.json(await this.usecase.getOtAutoApproval());
      } catch (err) {
        respondError(res, err);
      }
    });

    this.router.put("/attendance/ot/auto-approval", gate, async (req, res) => {
      try {
        const isValid = Joi.validate(req.body || {}, {
          auto_approve: Joi.boolean().required(),
          max_minutes: Joi.number().integer().min(1).max(1440).allow(null).required(),
        });
        if (isValid.error !== null) throw isValid.error;
        res.json(
          await this.usecase.setOtAutoApproval({
            auto_approve: req.body.auto_approve,
            max_minutes: req.body.max_minutes,
            actor: { employee_id: Number(req.decoded.employee_id) },
          })
        );
      } catch (err) {
        respondError(res, err);
      }
    });
  }

  getRouter() {
    return this.router;
  }
}

module.exports = (usecase, permissions) => new AttendanceOtAutoApprovalRoutes(usecase, permissions);
module.exports.AttendanceOtAutoApprovalRoutes = AttendanceOtAutoApprovalRoutes;
