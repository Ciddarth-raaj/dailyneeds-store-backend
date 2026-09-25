/**
 * Device Time Correction - the reasons an administrator may give, as a code
 * (stored on the batch) and the label every screen and export shows.
 *
 * One reason today. A new one is a line here; the column is a VARCHAR, not
 * an ENUM, so no migration is needed to add it.
 */
const REASON_CODES = Object.freeze({
  BIOMAX_DEVICE_TIME_ERROR: "Biomax Device Time Error",
});

module.exports = { REASON_CODES };
