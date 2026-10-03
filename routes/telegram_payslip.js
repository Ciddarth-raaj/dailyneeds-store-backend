const express = require("express");
const Joi = require("@hapi/joi");
const respondError = require("../utils/http");

/**
 * MY PAYSLIPS - THE TELEGRAM MINI APP PAYSLIP API.
 *
 *   GET  /telegram/payslips               the employee's own published payslips
 *   GET  /telegram/payslips/detail?ref=    one of them (records the view)
 *   GET  /telegram/payslips/pdf?ref=       the PDF, with the session header (normal path)
 *   POST /telegram/payslips/pdf-link       fallback: a single-use, 60-second link
 *   GET  /telegram/payslips/pdf?t=         the PDF, spending that link
 *
 * THE SAME GATE AS THE ATTENDANCE MINI APP. A Mini App has no dnds.co.in
 * session, so these paths step past the `x-access-token` gate in
 * `middlewares/auth.js` and are gated HERE instead: the short-lived scoped
 * token from `/telegram/attendance/session` (signed Telegram initData ->
 * active employee_telegram_identity -> employee) in `x-telegram-session`.
 * An ordinary login token is refused by that check.
 *
 * NO EMPLOYEE FIELD EXISTS. Not in a path, a query or a body - Joi refuses
 * unknown keys with a 422. The employee is `req.miniApp.employee_id`, the
 * signed claim, and nothing else. A payslip is named by its random `ref`, and
 * a ref that is not this employee's ACTIVE published payslip is a 404 -
 * indistinguishable from one that does not exist.
 *
 * NOTHING IS PUBLIC OR STATIC. The PDF is rendered per request from the
 * frozen snapshot and streamed with `Cache-Control: no-store`.
 */
class TelegramPayslipRoutes {
  constructor(sessionUsecase, payslipUsecase) {
    this.session = sessionUsecase;
    this.payslips = payslipUsecase;
    this.router = express.Router();
    this.init();
  }

  static _respond(res, err) {
    if (err && err.name === "TelegramAuthError") {
      res.status(err.status || 401).json({ code: 401, msg: err.message, error: err.code });
      return;
    }
    if (err && err.name === "NotFoundError") {
      res.status(404).json({ code: 404, msg: "Payslip not found" });
      return;
    }
    respondError(res, err);
  }

  _requireSession() {
    return async (req, res, next) => {
      try {
        req.miniApp = Object.freeze(await this.session.authenticate(req.headers["x-telegram-session"]));
        next();
      } catch (err) {
        TelegramPayslipRoutes._respond(res, err);
      }
    };
  }

  static _sendPdf(res, { buffer, filename }) {
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(buffer.length),
      "Cache-Control": "no-store, private, max-age=0",
      Pragma: "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    res.end(buffer);
  }

  init() {
    const r = this.router;
    const guard = this._requireSession();
    const ref = Joi.string().regex(/^[0-9a-f]{32}$/).required();

    r.get("/telegram/payslips", guard, async (req, res) => {
      try {
        const isValid = Joi.validate(req.query || {}, Joi.object().keys({}).unknown(false));
        if (isValid.error !== null) throw isValid.error;
        res.json(await this.payslips.list(req.miniApp.employee_id));
      } catch (err) {
        TelegramPayslipRoutes._respond(res, err);
      }
    });

    r.get("/telegram/payslips/detail", guard, async (req, res) => {
      try {
        const isValid = Joi.validate(req.query || {}, { ref });
        if (isValid.error !== null) throw isValid.error;
        res.set("Cache-Control", "no-store, private, max-age=0");
        res.json(await this.payslips.detail(req.miniApp.employee_id, req.query.ref));
      } catch (err) {
        TelegramPayslipRoutes._respond(res, err);
      }
    });

    r.post("/telegram/payslips/pdf-link", guard, async (req, res) => {
      try {
        const isValid = Joi.validate(req.body || {}, { ref });
        if (isValid.error !== null) throw isValid.error;
        res.json(await this.payslips.pdfLink(req.miniApp.employee_id, req.body.ref));
      } catch (err) {
        TelegramPayslipRoutes._respond(res, err);
      }
    });

    /**
     * EXACTLY ONE OF `ref` (with the session header - the normal path) OR `t`
     * (a single-use pdf-link token, no header). A token request never reads
     * the header, and a ref request never reads a token.
     */
    r.get("/telegram/payslips/pdf", async (req, res) => {
      try {
        const isValid = Joi.validate(
          req.query || {},
          Joi.object()
            .keys({ ref: Joi.string().regex(/^[0-9a-f]{32}$/), t: Joi.string().max(64) })
            .xor("ref", "t")
            .unknown(false)
        );
        if (isValid.error !== null) throw isValid.error;
        if (req.query.t) {
          TelegramPayslipRoutes._sendPdf(res, await this.payslips.pdfByToken(req.query.t));
          return;
        }
        const session = await this.session.authenticate(req.headers["x-telegram-session"]);
        TelegramPayslipRoutes._sendPdf(res, await this.payslips.pdf(session.employee_id, req.query.ref));
      } catch (err) {
        TelegramPayslipRoutes._respond(res, err);
      }
    });
  }

  getRouter() {
    return this.router;
  }
}

module.exports = (sessionUsecase, payslipUsecase) => new TelegramPayslipRoutes(sessionUsecase, payslipUsecase);
module.exports.TelegramPayslipRoutes = TelegramPayslipRoutes;
