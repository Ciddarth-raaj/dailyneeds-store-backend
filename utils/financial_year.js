/**
 * Indian financial year (1 April - 31 March) for a YYYY-MM-DD date.
 * GoFrugal's and RetailPilot's purchase reference (mmh_mrc_refno) restarts
 * at 1 every financial year, so a reference is only unique within one.
 */
function financialYearBounds(date) {
  const m = String(date || "").match(/^(\d{4})-(\d{2})-\d{2}/);
  if (!m) throw new Error(`not a YYYY-MM-DD date: ${date}`);
  const year = Number(m[1]);
  const startYear = Number(m[2]) >= 4 ? year : year - 1;
  return { start: `${startYear}-04-01`, end: `${startYear + 1}-03-31`, startYear };
}

module.exports = { financialYearBounds };
