/**
 * GoFrugal is retired: RetailPilot replaced it. Scripts on the server
 * (/home/delium/..., the server's own crontab) still read GoFrugal and push
 * into these endpoints; by the owner's decision every such feed is refused
 * here with 410 and nothing is saved. The refusals still reach the API Sync
 * Log (its middleware runs first), so a script that keeps calling shows up
 * there as a failed run.
 *
 * GOFRUGAL_FEEDS_BLOCKED=false lets them through again (rollback only).
 */
// The bulk feeds themselves (POST /purchase/bulk, /product-sales/bulk,
// /debit-note/bulk, /dead-stock-items/bulk, /item-markupdown/bulk,
// /product-distributors/bulk/hq-import, /hq-offers/{hdr,products,issue}/bulk)
// were removed outright: no route serves them, so a script still calling
// gets 404 and nothing is logged.
const RETIRED = [
  ["POST", "/gofrugal-synker/sync"],
  ["DELETE", "/gofrugal-synker/table"],
  // The stock holding report's pull from the old Delium/GoFrugal API.
  ["POST", "/stock-holding-report/sync"],
];

const MSG = "GoFrugal is retired - this feed is switched off; data comes from RetailPilot";

const normalise = (p) => String(p || "").split("?")[0].replace(/\/+$/, "").toLowerCase();

function isRetired(method, path) {
  const m = String(method || "").toUpperCase();
  const p = normalise(path);
  return RETIRED.some(([rm, rp]) => rm === m && rp === p);
}

function enabled(env = process.env) {
  return String(env.GOFRUGAL_FEEDS_BLOCKED ?? "true").toLowerCase() !== "false";
}

function create(env = process.env) {
  const on = enabled(env);
  return (req, res, next) => {
    if (!on || !isRetired(req.method, req.originalUrl || req.url)) return next();
    res.status(410).json({ code: 410, msg: MSG });
  };
}

module.exports = { RETIRED, MSG, isRetired, enabled, create };
