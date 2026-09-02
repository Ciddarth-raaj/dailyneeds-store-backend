/**
 * Client IP resolution and allow-list matching.
 *
 * A user row carries an optional `allowed_ips` list. When it is empty the
 * user may sign in from anywhere; when it holds entries the user is only
 * allowed from those addresses — typically a store's static IP.
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

/**
 * Whether a user may be served from this address.
 *
 * Two independent settings decide it, so an admin can lock someone down and
 * later let them out again without retyping the store's addresses:
 *
 *   allow_outside_access = 1  the user works from anywhere; the list is kept
 *                             but not enforced
 *   allow_outside_access = 0  the user is confined to `allowed_ips`
 *
 * An empty list combined with outside access turned off would lock the user
 * out of every network, so `validateIpPolicy` refuses to save that pairing.
 * If a row somehow reaches that state, it is treated as blocked rather than
 * quietly opened up.
 */
function isAccessAllowed(policy, ip) {
  const allowOutside = toBoolean(
    policy && policy.allow_outside_access,
    true
  );
  if (allowOutside) return true;

  // `validateIpPolicy` refuses to save this pairing, but a row edited
  // straight in SQL could still reach it. Block rather than silently hand
  // back unrestricted access.
  const rules = parseAllowList(policy && policy.allowed_ips);
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
 * Check a policy an admin is about to save.
 *
 * Confining a user to an empty list would lock them out of every network,
 * which is never what someone means to do — so that pairing is rejected
 * rather than saved.
 */
function validateIpPolicy({ allowOutsideAccess, allowedIps }) {
  const { valid, invalid, rules } = validateAllowList(allowedIps);
  if (!valid) {
    return {
      valid: false,
      reason: `Invalid IP entries: ${invalid.join(", ")}`,
      rules,
    };
  }

  if (!allowOutsideAccess && rules.length === 0) {
    return {
      valid: false,
      reason:
        "Add at least one allowed IP before blocking outside access, otherwise this user could not sign in from anywhere.",
      rules,
    };
  }

  return { valid: true, reason: null, rules };
}

module.exports = {
  getClientIp,
  isAccessAllowed,
  isIpAllowed,
  toBoolean,
  validateIpPolicy,
  matchesRule,
  normalizeIp,
  parseAllowList,
  validateAllowList,
};
