require("dotenv").config();

/**
 * Employee-lifecycle configuration — Stage 0C.
 *
 * Stage 0C makes dnds.co.in the owner of the employee lifecycle: joining,
 * resignation, termination, rejoin, employment periods and the login state
 * that follows them.
 *
 * The Digisme employee sync that used to write several of the same columns
 * was paused here for the duration of Stage 0C and has now been REMOVED -
 * route, cron and service code alike. `DIGISME_EMPLOYEE_SYNC` is therefore
 * read by nothing; a host whose .env still sets it has no effect, and the
 * line can be deleted. See docs/digisme-employee-sync-removal.md.
 *
 * The value below is read once, at require time, exactly like config/auth.js.
 */

/**
 * Stage 0C / C2 — dnds.co.in is the employee master.
 *
 * `LOCAL_EMPLOYEE_MASTER=off` is the only way back, and it exists so the
 * switch is auditable rather than because anyone should use it. Default ON:
 * a lost .env must fail towards the safe state, and after C2 the safe state
 * is "local HR writes win".
 *
 * This outlived the sync it was written against, and deliberately so. It was
 * the second, independent guard against an operator turning the Digisme sync
 * back on; that sync is gone, but the rule it enforced is not about Digisme.
 * ANY legacy or future importer that tries to write the employee master is
 * refused while this is on. It is not a dual-master system: there is one
 * master, and it is this one.
 */
const localEmployeeMaster = (() => {
  const raw = process.env.LOCAL_EMPLOYEE_MASTER;
  if (raw === undefined || raw === "") return true;
  const v = String(raw).trim().toLowerCase();
  return !(v === "off" || v === "false" || v === "0");
})();

module.exports = {
  /** C2: when true, no legacy sync may write the employee master. */
  localEmployeeMaster,

  /** The message the local-master guard reports. */
  LOCAL_MASTER_MESSAGE:
    "dnds.co.in is the employee master (Stage 0C / C2); a legacy sync may not write employee data",
};
