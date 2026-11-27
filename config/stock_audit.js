require("dotenv").config();

/**
 * Stock Audit activation switches (server .env; pm2 reload to apply).
 * EVERYTHING IS OFF unless set:
 *
 *   STOCK_AUDIT_ENABLED=true          the /stock-audit API answers at all (else 503 for everyone)
 *   STOCK_AUDIT_ACCESS=restricted     (default) only administrators and the designations below
 *   STOCK_AUDIT_ACCESS=all            everybody with the permission keys (employees, managers)
 *   STOCK_AUDIT_ACCESS_DESIGNATIONS=11 designation ids allowed while restricted (e.g. 11 Hr Executive)
 *   STOCK_AUDIT_SYNC_ENABLED=true     the manual RetailPilot sync button may run (there is no schedule)
 *
 * Incentive approval, revocation and payroll posting have NO switch here: they
 * are not enabled in this build and answer 501.
 */
const ids = (v) => String(v || "").split(",").map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0);

module.exports = {
  enabled: process.env.STOCK_AUDIT_ENABLED === "true",
  syncEnabled: process.env.STOCK_AUDIT_SYNC_ENABLED === "true",
  access: {
    mode: process.env.STOCK_AUDIT_ACCESS === "all" ? "all" : "restricted",
    designationIds: ids(process.env.STOCK_AUDIT_ACCESS_DESIGNATIONS),
  },
};
