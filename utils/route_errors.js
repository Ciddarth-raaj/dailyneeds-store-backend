/**
 * The response shape for the error names the LR Follow-up, Credit Purchase
 * and Transporter Master usecases throw. Same shape the Advance Request
 * routes use, plus two names those routes did not need:
 *
 *   BusinessRuleError  422 - the request is well-formed but breaks a rule
 *   ForbiddenError     403 - outside the caller's branch scope
 */
const PERMISSION_DENIED_MSG = "You do not have permission to perform this action";

module.exports = function sendError(res, err) {
  if (err && (err.name === "SystemAccountError" || err.name === "UnauthenticatedError")) {
    return res.status(err.status).json({ code: err.status, error: err.code, msg: err.message });
  }
  if (err && err.name === "ValidationError") {
    return res.status(400).json({ code: 422, msg: err.toString() });
  }
  if (err && err.name === "BusinessRuleError") {
    return res.status(422).json({ code: 422, msg: err.message, errors: err.errors || undefined });
  }
  if (err && err.name === "ForbiddenError") {
    // `msg` is the permission middleware's own wording on purpose: the web
    // app keeps the session for exactly that message (util/handle403.js) and
    // treats any other 403 as a dead login. The explanation rides in
    // `detail`.
    return res
      .status(403)
      .json({ code: 403, msg: PERMISSION_DENIED_MSG, detail: err.message, reason: err.reason });
  }
  if (err && err.name === "NotFoundError") {
    return res.status(404).json({ code: 404, msg: err.message });
  }
  if (err && err.name === "ConflictError") {
    // The record moved on before this call landed: reload, do not retry.
    return res.status(409).json({ code: 409, msg: err.message });
  }
  console.log(err);
  return res.status(500).json({ code: 500, msg: "An error occurred !" });
};
