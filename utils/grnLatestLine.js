/**
 * Encoding/decoding for "newest GRN line per product", picked in SQL.
 *
 * Purchase Ref needs each product's most recent GRN line (by GRN date
 * MMH_MRC_DT, with MMD_MRC_NO as the tiebreak). MySQL 5.7 has no window
 * functions, and doing it with a self-join or a second aggregate pass means
 * touching the (large) GRN detail table twice. Instead each line is rendered as
 * a fixed-width sort key followed by its pricing payload:
 *
 *   YYYYMMDD | MMD_MRC_NO zero-padded to 12 | "|" MMD_MAX_RATE "|" MMD_PUR_PRICE
 *
 * Because both key parts are zero-padded to a constant width, plain string
 * MAX() over that expression picks exactly the row the old in-Node sort picked,
 * while returning one row per product instead of the product's whole history.
 */

/** 8-char date + 12-char MRC number. */
const SORT_KEY_LENGTH = 20;

/**
 * SQL for the encoded line. Expects the GRN detail table aliased `d` and the
 * header table aliased `h`.
 *
 * Lines with no matching header sort oldest ('00000000'), matching the previous
 * in-Node sort, which treated a missing or unparseable date as epoch.
 */
const LATEST_GRN_LINE_EXPR = `CONCAT(
  COALESCE(DATE_FORMAT(h.MMH_MRC_DT, '%Y%m%d'), '00000000'),
  LPAD(CAST(COALESCE(d.MMD_MRC_NO, 0) AS CHAR), 12, '0'),
  '|', COALESCE(CAST(d.MMD_MAX_RATE AS CHAR), ''),
  '|', COALESCE(CAST(d.MMD_PUR_PRICE AS CHAR), '')
)`;

/**
 * Decode a LATEST_GRN_LINE_EXPR value.
 *
 * @param {string|null|undefined} value
 * @returns {{ mrp: string, net_cost: string }|null} raw column text (empty
 *   string where the column was NULL), or null if the value is unusable.
 */
function parseLatestGrnLine(value) {
  if (value == null) return null;
  const text = String(value);
  if (text.length <= SORT_KEY_LENGTH) return null;
  // Everything after the sort key: "|<max_rate>|<pur_price>".
  const parts = text.slice(SORT_KEY_LENGTH).split("|");
  if (parts.length !== 3 || parts[0] !== "") return null;
  return { mrp: parts[1], net_cost: parts[2] };
}

module.exports = {
  LATEST_GRN_LINE_EXPR,
  SORT_KEY_LENGTH,
  parseLatestGrnLine,
};
