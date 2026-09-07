require("dotenv").config();

/**
 * Employee-lifecycle configuration — Stage 0C.
 *
 * Stage 0C makes dnds.co.in the owner of the employee lifecycle: joining,
 * resignation, termination, rejoin, employment periods and the login state
 * that follows them. Digisme's nightly employee sync writes several of the
 * same columns, so it is paused for the duration rather than raced.
 *
 * The pause is a switch, not a deletion. Every line of the Digisme
 * integration is still here; it is simply not reached while this is off.
 *
 *   DIGISME_EMPLOYEE_SYNC=on    the historical behaviour, unchanged
 *   anything else / unset       paused (the default)
 *
 * Default OFF is deliberate: pausing must not depend on an environment
 * variable being present, so a fresh deploy, a new host or a lost .env all
 * fail towards the safe state. Resuming is an explicit act.
 *
 * The value is read once, at require time, exactly like config/auth.js —
 * the flag cannot change under a running process, so a sync cannot be half
 * paused.
 */

/** `on`/`true`/`1` enable it; everything else, including unset, does not. */
const enabled = (() => {
  const raw = process.env.DIGISME_EMPLOYEE_SYNC;
  if (raw === undefined || raw === "") return false;
  const v = String(raw).trim().toLowerCase();
  return v === "on" || v === "true" || v === "1";
})();

module.exports = {
  digisme: {
    /**
     * When false: the `employee_sync` cron is never registered, and
     * `syncDigismeEmployees()` returns before it authenticates, fetches, or
     * writes a designation, department, outlet, employee or login.
     *
     * Note this pauses the designation/department/outlet master upserts too,
     * because they run inside the same function. That is accepted for the
     * duration of Stage 0C: all three have full local CRUD.
     */
    employeeSync: enabled,
  },

  /** The message every paused path reports, so they cannot drift apart. */
  PAUSED_MESSAGE: "Digisme employee sync is paused (Stage 0C)",
};
