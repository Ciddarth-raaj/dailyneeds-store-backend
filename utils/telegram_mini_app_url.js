/**
 * THE MINI APP URL, BUILT IN ONE PLACE.
 *
 * ============================================ WHY THIS FILE EXISTS =========
 *
 * Three features now open the Telegram Attendance Mini App - the bot's home
 * menu, the 07:00 Regularise Attendance alert, and the menu shown the moment
 * an employee finishes Telegram verification. Three hand-built template
 * strings would drift: one would forget to strip a trailing slash, one would
 * encode a parameter differently, and - the failure that actually matters -
 * one would eventually put an employee id in the query string because it was
 * convenient at the time.
 *
 * So the URL is built HERE and nowhere else, and this module makes that last
 * failure impossible rather than merely discouraged: THERE IS NO PARAMETER
 * FOR AN EMPLOYEE. `miniAppUrl` accepts exactly `section` and `date`, ignores
 * everything else it is handed, and `buildQuery` refuses any key outside a
 * frozen allow-list. A caller cannot pass an employee id through it by
 * mistake, and `utils/telegram_mini_app_url.test.js` asserts that.
 *
 * ===================================== THE QUERY IS NAVIGATION, NOT AUTHORITY
 *
 * `section` says which tab to open. `date` says which correction card to
 * highlight. NEITHER IS EVIDENCE OF ANYTHING. The Mini App authenticates the
 * employee from Telegram's signed `initData` on the server, and the server
 * decides which dates belong to them; a `date` the employee is not entitled
 * to simply is not in the list the server returns, so highlighting it shows
 * nothing.
 *
 * ================================== NO BASE URL MEANS NO BUTTON ============
 *
 * `ATTENDANCE_CORRECTION_MINI_APP_URL` is the single configured value, and
 * when it is absent every function here returns `null`. That is what keeps
 * the bot working on an environment where the Mini App is not deployed: the
 * message still sends, just with no keyboard. A `null` keyboard is omitted by
 * the callers rather than sent as an empty one.
 *
 * ============================== WHY AN INLINE `web_app` BUTTON =============
 *
 * `inlineKeyboard` with `web_app` is the EXACT shape the Regularise
 * Attendance button already uses in production, and that button is proven to
 * work with the live bot and the live client. A reply-keyboard Web App button
 * is a different Telegram mechanism with different client behaviour, and
 * nothing here needs it, so nothing here introduces it.
 *
 * PURE. No environment, no network, no database, no logging. The base URL is
 * an argument, which is what lets every case below be tested without a bot.
 */

/**
 * The only query keys that may ever appear on a Mini App URL.
 *
 * A frozen allow-list rather than a deny-list: a key that is not named here
 * cannot be added by passing it in, so `employee_id` is not "removed", it is
 * simply not expressible.
 */
const ALLOWED_QUERY_KEYS = Object.freeze(["section", "date"]);

/** The Mini App's sections. `attendance` is the default and needs no link. */
const SECTION = Object.freeze({
  ATTENDANCE: "attendance",
  CORRECTIONS: "corrections",
  HELP: "help",
});

const VALID_SECTIONS = Object.freeze(Object.values(SECTION));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A usable base URL, trailing slashes stripped, or null. */
function normalizeBase(baseUrl) {
  if (typeof baseUrl !== "string") return null;
  const trimmed = baseUrl.trim();
  if (trimmed === "") return null;
  const withoutSlash = trimmed.replace(/\/+$/, "");
  return withoutSlash === "" ? null : withoutSlash;
}

/**
 * The query string, from the allow-list only.
 *
 * A section that is not one of the three is DROPPED rather than passed
 * through - the Mini App falls back to My Attendance for an unknown section
 * anyway, so sending one would be a link that lies about where it goes. A
 * malformed date is dropped for the same reason.
 */
function buildQuery({ section = null, date = null } = {}) {
  const parts = [];
  if (typeof section === "string" && VALID_SECTIONS.includes(section)) {
    parts.push(`section=${encodeURIComponent(section)}`);
  }
  if (typeof date === "string" && DATE_RE.test(date)) {
    parts.push(`date=${encodeURIComponent(date)}`);
  }
  return parts.join("&");
}

/**
 * A Mini App URL, or null when no base URL is configured.
 *
 * @param {?string} baseUrl  ATTENDANCE_CORRECTION_MINI_APP_URL
 * @param {object} [nav]     `{ section, date }` - NAVIGATION ONLY. Any other
 *                           key, `employee_id` included, is ignored entirely.
 */
function miniAppUrl(baseUrl, nav = {}) {
  const base = normalizeBase(baseUrl);
  if (base === null) return null;
  const query = buildQuery(nav || {});
  return query === "" ? base : `${base}?${query}`;
}

/**
 * One inline `web_app` button, or null when no base URL is configured.
 *
 * @param {?string} baseUrl
 * @param {string} text   the button label
 * @param {object} [nav]  `{ section, date }`
 */
function webAppButton(baseUrl, text, nav = {}) {
  const url = miniAppUrl(baseUrl, nav);
  if (url === null) return null;
  const label = typeof text === "string" ? text.trim() : "";
  if (label === "") return null;
  return { text: label, web_app: { url } };
}

/**
 * An inline keyboard from a list of `{ text, section, date }` specs, or null
 * when no base URL is configured or no button survives.
 *
 * ONE BUTTON PER ROW. A Telegram Mini App opens on a phone, and a stacked
 * column of full-width buttons is both easier to hit and reads as a menu.
 */
function webAppKeyboard(baseUrl, specs) {
  if (normalizeBase(baseUrl) === null) return null;
  const rows = (Array.isArray(specs) ? specs : [])
    .map((spec) => webAppButton(baseUrl, spec && spec.text, spec || {}))
    .filter((button) => button !== null)
    .map((button) => [button]);
  return rows.length === 0 ? null : { inlineKeyboard: rows };
}

module.exports = {
  ALLOWED_QUERY_KEYS,
  SECTION,
  VALID_SECTIONS,
  normalizeBase,
  buildQuery,
  miniAppUrl,
  webAppButton,
  webAppKeyboard,
};
