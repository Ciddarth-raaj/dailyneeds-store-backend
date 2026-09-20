/**
 * The permission key each GST endpoint requires.
 *
 * ============================== WHY THIS FILE EXISTS ======================
 *
 * Six GST permission keys have existed since May 2026. Every one of them was
 * inserted into `all_permissions`, surfaced in the frontend's permission tree
 * and used to hide menu entries - and NOT ONE of them was ever checked by the
 * server. `server.js` built the GST router as
 *
 *     require("./routes/gst")(this.gstUsecase)
 *
 * with no `permissions` argument, unlike the ~30 routers beside it, and the
 * three purchase-GST routers did the same. Hiding a menu entry is
 * presentation; any authenticated user could call the endpoints directly.
 *
 * This file is the mapping the middleware was always supposed to read. No key
 * here is new: all seven are already in `all_permissions` and already granted
 * to the designations that use these screens.
 *
 * ============================== OR IS DELIBERATE HERE =====================
 *
 * `constants/hr_permissions.js` says one key per endpoint, never a list,
 * because `permissions.require(a, b)` is OR and a list would weaken an
 * HR check to either-of. That rule is right for HR, where each endpoint
 * belongs to exactly one screen.
 *
 * GST is not shaped that way. FIVE SCREENS SHARE ONE BACKEND, and three
 * groups of endpoints are reached from screens whose own gates differ:
 *
 *   1. THE TAXPAYER SESSION AND OTP ENDPOINTS. `GstModuleWrapper` wraps all
 *      five GST-module screens (GST Portal, Vendors, Filing Dates, GSTR-2A
 *      Purchase Register, All Tally Purchases). On mount it calls
 *      /gst/taxpayer/session/check, and on a 428 it opens the OTP modal,
 *      which calls /gst/taxpayer/otp/request and /otp/verify. Gating those on
 *      `view_gst_portal` alone would 403 the wrapper on four screens whose
 *      users have never needed that key - and the failure would not be a
 *      hidden button, it would be the whole screen refusing to load.
 *
 *   2. GET /purchase-gst. Called by the GSTR-2A Purchase Register
 *      (`view_gst_gstr2a_purchase_register`) AND by All Tally Purchases
 *      (`view_tally_purchases`), which is a different screen under a
 *      different menu with a different key.
 *
 *   3. GET /gst/vendors and GET /gst/fetch-log/latest. Called by the Vendors
 *      screen (`view_gst_vendors`) AND by Filing Dates
 *      (`view_gst_filing_dates`), which reads the vendor list to build its
 *      grid and the fetch log to date it.
 *
 * For those three groups the OR set is not a weakening - it is the honest
 * statement of who is entitled to reach the endpoint, and it is strictly
 * more restrictive than today, where the answer is "anybody signed in".
 * Every endpoint that belongs to exactly one screen gets exactly one key.
 *
 * ============================== WHAT IS NOT DECIDED HERE ==================
 *
 * The GSTR-2A write endpoints (match upsert/delete, no-2A accept/delete) are
 * guarded with `VIEW_GST_GSTR2A_PURCHASE_REGISTER`, the same key as the read.
 * That is deliberate and temporary: a separate `match_gst_2a` write key would
 * have to be granted on day one to everyone who already holds the view key,
 * or the screen breaks for the people who run it - at which point the new key
 * says nothing. Splitting read from write is a decision with a migration and
 * a grant plan behind it, and it is not this change.
 *
 * `POST /tally/gst-purchase` and the hard delete it can reach are NOT touched
 * here. That endpoint is a partner integration authenticated by its own
 * token, and the `delete_tally_purchases` gap on it is tracked separately.
 */
module.exports = {
  // ==================================================== THE SEVEN KEYS =====
  /** GST Portal screen: taxpayer session state and the OTP lifecycle. */
  VIEW_GST_PORTAL: "view_gst_portal",
  /** GST Vendors screen: the vendor master and GSTIN search. */
  VIEW_GST_VENDORS: "view_gst_vendors",
  /** GST Filing Dates screen: per-vendor last filing date. */
  VIEW_GST_FILING_DATES: "view_gst_filing_dates",
  /** GSTR-2A v Purchase Register screen: stored 2A data and its matching. */
  VIEW_GST_GSTR2A_PURCHASE_REGISTER: "view_gst_gstr2a_purchase_register",
  /** Pulling a return period from GSTN. A write against the GST portal. */
  SYNC_GST_GSTR2A_B2B: "sync_gst_gstr2a_b2b",
  /** All Tally Purchases screen. */
  VIEW_TALLY_PURCHASES: "view_tally_purchases",
  /** Removing a Tally purchase snapshot from the All Tally Purchases screen. */
  DELETE_TALLY_PURCHASES: "delete_tally_purchases",
};

/**
 * Every screen that mounts `GstModuleWrapper`, and therefore every screen
 * whose first render calls the taxpayer session check and whose OTP modal
 * calls request/verify.
 *
 * Holding any one of these means the caller is already entitled to a GST
 * screen; the session endpoints disclose only whether an OTP is due and when
 * the session expires, never the token itself.
 */
module.exports.GST_MODULE_SESSION_KEYS = [
  module.exports.VIEW_GST_PORTAL,
  module.exports.VIEW_GST_VENDORS,
  module.exports.VIEW_GST_FILING_DATES,
  module.exports.VIEW_GST_GSTR2A_PURCHASE_REGISTER,
  module.exports.VIEW_TALLY_PURCHASES,
];

/** The two screens that read the vendor master. */
module.exports.VENDOR_READER_KEYS = [
  module.exports.VIEW_GST_VENDORS,
  module.exports.VIEW_GST_FILING_DATES,
];

/** The two screens that read the GSTR-2A fetch log. */
module.exports.FETCH_LOG_READER_KEYS = [
  module.exports.VIEW_GST_GSTR2A_PURCHASE_REGISTER,
  module.exports.VIEW_GST_FILING_DATES,
];

/** The two screens that read the Tally purchase snapshot list. */
module.exports.PURCHASE_GST_READER_KEYS = [
  module.exports.VIEW_GST_GSTR2A_PURCHASE_REGISTER,
  module.exports.VIEW_TALLY_PURCHASES,
];
