/**
 * Client IP resolution, allow-list matching and policy resolution.
 *
 * Two layers decide where a user may sign in from:
 *
 *   branch   `outlets.allowed_ips`, enforced for every employee of the
 *            branch while `outlets.ip_restriction_enabled` is on
 *   user     `user.ip_policy` — `branch` (follow the branch rule; default),
 *            `custom` (personal `user.allowed_ips`, unioned with the branch
 *            list) or `unrestricted` (explicit exemption)
 *
 * `resolveIpPolicy` folds both into one `{ exempt, rules }` answer that the
 * login path and the per-request middleware both check with
 * `isAccessAllowed`.
 *
 * Supported entry formats:
 *   203.0.113.10        exact address (IPv4 or IPv6)
 *   203.0.113.0/24      CIDR block (IPv4 only)
 *   203.0.113.*         wildcard on any trailing IPv4 octet
 *   203.0.113.10-20     range on the last IPv4 octet
 */

/** Strip the IPv6 form Node reports for IPv4 sockets (`::ffff:1.2.3.4`). */
function normalizeIp(value) {
  if (typeof value !== "string") return "";
  let ip = value.trim();
  if (ip === "") return "";
  // A bracketed / port-suffixed form can arrive from proxy headers.
  if (ip.startsWith("[")) {
    const close = ip.indexOf("]");
    if (close !== -1) ip = ip.slice(1, close);
  }
  const lower = ip.toLowerCase();
  if (lower.startsWith("::ffff:")) {
    const tail = ip.slice(7);
    if (isIpv4(tail)) return tail;
  }
  if (lower === "::1") return "127.0.0.1";
  return ip;
}

function isIpv4(value) {
  const parts = String(value).split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const num = Number(part);
    return num >= 0 && num <= 255;
  });
}

function ipv4ToLong(value) {
  if (!isIpv4(value)) return null;
  return value
    .split(".")
    .reduce((acc, part) => acc * 256 + Number(part), 0);
}

/**
 * True for an address that can never belong to a remote client: the
 * loopback range and IPv6 `::1`.
 *
 * Seeing one of these as "the client" always means the reverse proxy is not
 * forwarding the real address — the request came from the proxy itself over
 * localhost.
 */
function isLoopbackIp(value) {
  const ip = normalizeIp(value);
  if (ip === "") return false;
  if (ip === "::1") return true;
  if (!isIpv4(ip)) return false;
  return ip.split(".")[0] === "127";
}

/**
 * True for an address that is not routable on the public internet:
 * loopback, RFC1918 private space, and link-local.
 *
 * Unlike loopback this is not automatically wrong — an app reached only
 * over a LAN would legitimately see these — so callers warn rather than
 * refuse.
 */
function isPrivateIp(value) {
  const ip = normalizeIp(value);
  if (ip === "") return false;
  if (isLoopbackIp(ip)) return true;
  if (!isIpv4(ip)) return false;

  const [a, b] = ip.split(".").map(Number);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/**
 * The address the request actually came from.
 *
 * Express fills `req.ip` from the socket, or from the left-most untrusted
 * entry of `X-Forwarded-For` when `trust proxy` is set — which is what the
 * app does in production behind nginx. The header is only read directly as
 * a fallback for setups where Express was not told about the proxy.
 */
function getClientIp(req) {
  if (!req) return "";

  const direct = normalizeIp(req.ip);
  if (direct) return direct;

  const forwarded = req.headers && req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim() !== "") {
    const first = forwarded.split(",")[0];
    const normalized = normalizeIp(first);
    if (normalized) return normalized;
  }

  const socket = req.connection || req.socket;
  return normalizeIp(socket && socket.remoteAddress);
}

/** Split a stored `allowed_ips` value into individual rules. */
function parseAllowList(raw) {
  if (Array.isArray(raw)) {
    return raw.map((entry) => String(entry).trim()).filter(Boolean);
  }
  if (typeof raw !== "string") return [];
  return raw
    .split(/[,\n;]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function matchesCidr(ip, rule) {
  const [network, bitsRaw] = rule.split("/");
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;

  const ipLong = ipv4ToLong(ip);
  const networkLong = ipv4ToLong(network);
  if (ipLong === null || networkLong === null) return false;

  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ipLong & mask) >>> 0 === (networkLong & mask) >>> 0;
}

function matchesWildcard(ip, rule) {
  const ruleParts = rule.split(".");
  const ipParts = ip.split(".");
  if (ruleParts.length !== 4 || ipParts.length !== 4) return false;

  return ruleParts.every((part, index) => {
    if (part === "*") return true;
    return part === ipParts[index];
  });
}

function matchesRange(ip, rule) {
  const [startRaw, endRaw] = rule.split("-");
  const start = startRaw.trim();
  const end = endRaw.trim();
  if (!isIpv4(start)) return false;

  // `203.0.113.10-20` is shorthand for `203.0.113.10-203.0.113.20`.
  const fullEnd = isIpv4(end)
    ? end
    : `${start.split(".").slice(0, 3).join(".")}.${end}`;
  if (!isIpv4(fullEnd)) return false;

  const ipLong = ipv4ToLong(ip);
  const startLong = ipv4ToLong(start);
  const endLong = ipv4ToLong(fullEnd);
  if (ipLong === null || startLong === null || endLong === null) return false;

  return ipLong >= Math.min(startLong, endLong) &&
    ipLong <= Math.max(startLong, endLong);
}

/** True when `ip` satisfies a single allow-list entry. */
function matchesRule(ip, rule) {
  const candidate = normalizeIp(ip);
  const entry = String(rule || "").trim();
  if (candidate === "" || entry === "") return false;

  if (entry.includes("/")) return matchesCidr(candidate, entry);
  if (entry.includes("*")) return matchesWildcard(candidate, entry);
  if (entry.includes("-")) return matchesRange(candidate, entry);

  return entry.toLowerCase() === candidate.toLowerCase();
}

/**
 * True when the address satisfies at least one entry of the allow-list.
 *
 * An empty allow-list means "nothing to match against", so the caller is
 * allowed. A non-empty list with an unresolvable client IP is denied —
 * failing open there would defeat the restriction entirely.
 */
function isIpAllowed(ip, allowList) {
  const rules = parseAllowList(allowList);
  if (rules.length === 0) return true;

  const candidate = normalizeIp(ip);
  if (candidate === "") return false;

  return rules.some((rule) => matchesRule(candidate, rule));
}

/** A `1`/`true`/`"1"` style flag from MySQL or JSON, read as a boolean. */
function toBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return fallback;
}

const IP_POLICIES = ["branch", "custom", "unrestricted"];

/** user_type 2 is an admin account; branch rules never bind it by default. */
const ADMIN_USER_TYPE = 2;

/**
 * One of `branch` / `custom` / `unrestricted` from a stored value, or from
 * the previous release's `allow_outside_access` boolean (true meant "not
 * personally restricted", i.e. follow the branch; false meant a personal
 * list). `null` when the value is not recognisable — callers decide whether
 * that is an error (saving) or the default (reading).
 */
function normalizeIpPolicy(value) {
  if (typeof value === "boolean") return value ? "branch" : "custom";
  if (typeof value === "number") return value !== 0 ? "branch" : "custom";
  if (value === undefined || value === null) return null;

  const text = String(value).trim().toLowerCase();
  if (IP_POLICIES.includes(text)) return text;
  if (["1", "true"].includes(text)) return "branch";
  if (["0", "false"].includes(text)) return "custom";
  return null;
}

/**
 * Fold a user's policy and their branch's rule into one answer.
 *
 * `row` carries `user_type`, `ip_policy`, `allowed_ips` from the user and
 * `branch_enabled`, `branch_ips` from their outlet (absent when the
 * employee has no outlet).
 *
 *   unrestricted  → exempt
 *   custom        → personal ∪ branch (branch part only while its switch is
 *                   on). An empty union is enforced as "nowhere": saving
 *                   refuses that pairing, and a row edited straight in SQL
 *                   must not quietly open up.
 *   branch        → admins are exempt; a branch with its switch off means
 *                   nothing to enforce, so exempt (the default state for
 *                   everyone); otherwise the branch list, empty enforced as
 *                   "nowhere" for the same reason as above.
 *
 * `source` says which arm decided, for the admin screen and for logs.
 */
function resolveIpPolicy(row) {
  const r = row || {};
  const policy = normalizeIpPolicy(r.ip_policy) || "branch";
  const isAdmin = Number(r.user_type) === ADMIN_USER_TYPE;
  const branchEnabled = toBoolean(r.branch_enabled, false);
  const branchRules = branchEnabled ? parseAllowList(r.branch_ips) : [];

  if (policy === "unrestricted") {
    return { exempt: true, rules: [], source: "unrestricted" };
  }

  if (policy === "custom") {
    const personal = parseAllowList(r.allowed_ips);
    const rules = [...new Set([...personal, ...branchRules])];
    return { exempt: false, rules, source: "custom" };
  }

  if (isAdmin) return { exempt: true, rules: [], source: "admin" };
  if (!branchEnabled) return { exempt: true, rules: [], source: "branch-open" };
  return { exempt: false, rules: branchRules, source: "branch" };
}

/**
 * Whether a resolved policy admits this address.
 *
 * Strict on shape on purpose: only `exempt === true` opens the door, and an
 * empty rule set on a non-exempt policy is a block, not a pass. A caller
 * handing in the previous release's `{ allow_outside_access }` shape gets
 * "blocked", never "allowed" — failing open is the one outcome this must
 * never produce.
 */
function isAccessAllowed(resolved, ip) {
  if (resolved && resolved.exempt === true) return true;

  const rules = parseAllowList(resolved && resolved.rules);
  if (rules.length === 0) return false;

  return isIpAllowed(ip, rules);
}

/** Reject entries an admin typed that we could never match against. */
function validateAllowList(raw) {
  const rules = parseAllowList(raw);
  const invalid = rules.filter((rule) => {
    if (rule.includes("/")) {
      const [network, bits] = rule.split("/");
      return !isIpv4(network) || !/^\d{1,2}$/.test(bits) || Number(bits) > 32;
    }
    if (rule.includes("*")) {
      const parts = rule.split(".");
      return (
        parts.length !== 4 ||
        !parts.every((part) => part === "*" || /^\d{1,3}$/.test(part))
      );
    }
    if (rule.includes("-")) {
      const [start, end] = rule.split("-").map((part) => part.trim());
      return !isIpv4(start) || !(isIpv4(end) || /^\d{1,3}$/.test(end));
    }
    // Exact address: IPv4, or anything that looks like IPv6.
    return !isIpv4(rule) && !/^[0-9a-fA-F:]+$/.test(rule);
  });

  return { valid: invalid.length === 0, invalid, rules };
}

/**
 * Check an allow-list an admin is about to save, for a user or a branch.
 *
 * `restricted` says whether the list will actually be enforced (a user on
 * `custom`, a branch with its switch on). Enforcing an empty list would
 * lock everyone it binds out of every network, which is never what someone
 * means to do — so that pairing is rejected rather than saved.
 */
function validateIpPolicy({ restricted, allowedIps }) {
  const { valid, invalid, rules } = validateAllowList(allowedIps);
  if (!valid) {
    return {
      valid: false,
      reason: `Invalid IP entries: ${invalid.join(", ")}`,
      rules,
    };
  }

  // A loopback entry only ever gets typed in because the reverse proxy is
  // not forwarding the client address, so the screen reported the server
  // talking to itself. Saving it would match every request from every
  // network — a restriction that reads as configured while enforcing
  // nothing — so refuse it and say what is actually wrong.
  const loopback = rules.filter((rule) => isLoopbackIp(rule.split("/")[0]));
  if (loopback.length > 0) {
    return {
      valid: false,
      reason:
        `${loopback.join(", ")} is this server talking to itself, not a network address. ` +
        "It means the reverse proxy is not sending the real client IP, so every user would match it. " +
        "Fix the proxy's X-Forwarded-For header first.",
      rules,
    };
  }

  if (restricted && rules.length === 0) {
    return {
      valid: false,
      reason:
        "Add at least one allowed IP before restricting access, otherwise nobody bound by this rule could sign in from anywhere.",
      rules,
    };
  }

  return { valid: true, reason: null, rules };
}

module.exports = {
  ADMIN_USER_TYPE,
  IP_POLICIES,
  getClientIp,
  isLoopbackIp,
  isPrivateIp,
  isAccessAllowed,
  isIpAllowed,
  normalizeIpPolicy,
  resolveIpPolicy,
  toBoolean,
  validateIpPolicy,
  matchesRule,
  normalizeIp,
  parseAllowList,
  validateAllowList,
};
