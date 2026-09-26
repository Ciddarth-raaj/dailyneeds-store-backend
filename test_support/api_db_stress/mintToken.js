// Mint a Telegram Mini App session token exactly as usecase/telegram_attendance_session.js
// does (services/jwt, scope telegram_attendance_miniapp), for the stress harness only.
const jwt = require("../../services/jwt");
const { SCOPE } = require("../../usecase/telegram_attendance_session");
module.exports = (employeeId, ttl = 3600) =>
  jwt.sign({ scope: SCOPE, emp: employeeId, tgu: 900000 + employeeId, sid: `stress${employeeId}` }, ttl);
if (require.main === module) module.exports(Number(process.argv[2] || 50001)).then((t) => console.log(t));

/** An ordinary dnds.co.in login token (auth_ver 2), as usecase/user.js#login issues. */
module.exports.login = (userId, employeeId, ttl = 3600) =>
  jwt.sign({ auth_ver: 2, id: userId, employee_id: employeeId, user_type: 1, designation_id: 1, store_id: 1 }, ttl, { subject: String(userId) });
