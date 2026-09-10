const config = require("../config/auth").password;

/**
 * Password policy — Stage 0A (B3).
 *
 * Deliberately modest: a length floor, no composition rules that push
 * staff toward writing passwords down, and a hard refusal of anything
 * derivable from the account itself or from the historical provisioning
 * defaults. The server is the only place this is enforced; the frontend
 * may mirror it for convenience.
 */

/** The historical default patterns the old provisioning code produced. */
const historicalDefaults = ({ employeeId }) => {
  const list = ["password"];
  if (employeeId !== null && employeeId !== undefined && employeeId !== "") {
    list.push(`${employeeId}@123`);
  }
  return list;
};

/** A short list of the passwords most often tried first. Lower-cased comparison. */
const COMMON = new Set([
  "password", "password1", "password123", "passw0rd", "12345678", "123456789",
  "1234567890", "qwerty123", "qwertyuiop", "11111111", "00000000", "abcd1234",
  "admin123", "welcome1", "welcome123", "letmein1", "iloveyou", "dailyneeds",
  "dailyneeds1", "dailyneeds123", "dnds1234", "dnds@123", "store123", "cashier1",
]);

const norm = (v) => (v === null || v === undefined ? "" : String(v).trim().toLowerCase());

/**
 * @returns {{ ok: boolean, reason?: string }}
 */
function check(password, context = {}) {
  const { minLength, maxLength } = config.policy;
  const min = context.minLength || minLength;

  if (typeof password !== "string") return { ok: false, reason: "Password is required" };
  if (password.length < min) return { ok: false, reason: `Password must be at least ${min} characters` };
  if (password.length > maxLength) return { ok: false, reason: `Password must be at most ${maxLength} characters` };
  if (/^\s|\s$/.test(password)) return { ok: false, reason: "Password must not start or end with a space" };

  const p = norm(password);
  if (/^(.)\1+$/.test(p)) return { ok: false, reason: "Password must not be one repeated character" };
  if (COMMON.has(p)) return { ok: false, reason: "That password is too common" };

  const identity = [context.username, context.employeeId, context.mobile, context.currentPassword];
  for (const v of identity) {
    const n = norm(v);
    if (n !== "" && n === p) return { ok: false, reason: "Password must not be your username, employee code, mobile number or current password" };
  }
  if (context.mobile) {
    const digits = String(context.mobile).replace(/\D/g, "");
    if (digits.length >= 8 && p.replace(/\D/g, "") === digits) {
      return { ok: false, reason: "Password must not be your mobile number" };
    }
  }
  for (const d of historicalDefaults(context)) {
    if (norm(d) === p) return { ok: false, reason: "That password is a known default and cannot be used" };
  }
  return { ok: true };
}

module.exports = { check, historicalDefaults, COMMON };
