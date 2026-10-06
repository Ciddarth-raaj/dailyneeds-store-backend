/**
 * EMPLOYEES NO LONGER REQUEST OT.
 *
 * Eligible overtime is raised for approval automatically by the attendance
 * engine (`usecase/attendance_regularization.js#syncAutoOt`), so the two
 * employee request endpoints - `POST /attendance/me/ot-request` (DnDS) and
 * `POST /telegram/attendance/ot-request` (Telegram Mini App) - answer this,
 * and create nothing. One answer, in one place, so the two surfaces cannot
 * drift apart. 410 Gone: the resource existed and has been retired on
 * purpose, which an old cached screen should be told rather than shown a
 * generic failure.
 */
const OT_REQUEST_RETIRED = Object.freeze({
  status: 410,
  body: Object.freeze({
    code: 410,
    error: "OT_REQUEST_NOT_REQUIRED",
    msg:
      "OT no longer needs to be requested. Eligible overtime from your punches is sent for approval automatically - check its status in My Attendance.",
  }),
});

const respondOtRequestRetired = (res) => res.status(OT_REQUEST_RETIRED.status).json({ ...OT_REQUEST_RETIRED.body });

module.exports = { OT_REQUEST_RETIRED, respondOtRequestRetired };
