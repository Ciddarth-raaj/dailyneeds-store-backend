const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  getClientIp,
  isAccessAllowed,
  isLoopbackIp,
  isPrivateIp,
  normalizeIpPolicy,
  resolveIpPolicy,
  isIpAllowed,
  matchesRule,
  normalizeIp,
  parseAllowList,
  toBoolean,
  validateAllowList,
  validateIpPolicy,
} = require("./ip");

describe("normalizeIp", () => {
  it("unwraps IPv4-mapped IPv6 addresses", () => {
    assert.equal(normalizeIp("::ffff:203.0.113.10"), "203.0.113.10");
  });

  it("maps IPv6 loopback to IPv4 loopback", () => {
    assert.equal(normalizeIp("::1"), "127.0.0.1");
  });

  it("strips brackets", () => {
    assert.equal(normalizeIp("[2001:db8::1]"), "2001:db8::1");
  });

  it("returns an empty string for non-strings", () => {
    assert.equal(normalizeIp(undefined), "");
    assert.equal(normalizeIp(null), "");
  });
});

describe("parseAllowList", () => {
  it("splits on commas, semicolons and newlines", () => {
    assert.deepEqual(parseAllowList("1.1.1.1, 2.2.2.2\n3.3.3.3;4.4.4.4"), [
      "1.1.1.1",
      "2.2.2.2",
      "3.3.3.3",
      "4.4.4.4",
    ]);
  });

  it("drops blank entries", () => {
    assert.deepEqual(parseAllowList(" , 1.1.1.1 ,, "), ["1.1.1.1"]);
  });

  it("accepts an array", () => {
    assert.deepEqual(parseAllowList([" 1.1.1.1 ", "2.2.2.2"]), [
      "1.1.1.1",
      "2.2.2.2",
    ]);
  });
});

describe("matchesRule", () => {
  it("matches an exact address", () => {
    assert.equal(matchesRule("203.0.113.10", "203.0.113.10"), true);
    assert.equal(matchesRule("203.0.113.11", "203.0.113.10"), false);
  });

  it("matches a CIDR block", () => {
    assert.equal(matchesRule("203.0.113.55", "203.0.113.0/24"), true);
    assert.equal(matchesRule("203.0.114.55", "203.0.113.0/24"), false);
    assert.equal(matchesRule("10.1.2.3", "10.0.0.0/8"), true);
  });

  it("matches a /32 CIDR exactly", () => {
    assert.equal(matchesRule("203.0.113.10", "203.0.113.10/32"), true);
    assert.equal(matchesRule("203.0.113.11", "203.0.113.10/32"), false);
  });

  it("matches a wildcard", () => {
    assert.equal(matchesRule("203.0.113.99", "203.0.113.*"), true);
    assert.equal(matchesRule("203.0.114.99", "203.0.113.*"), false);
  });

  it("matches a last-octet range", () => {
    assert.equal(matchesRule("203.0.113.15", "203.0.113.10-20"), true);
    assert.equal(matchesRule("203.0.113.21", "203.0.113.10-20"), false);
  });

  it("matches a full range", () => {
    assert.equal(
      matchesRule("203.0.114.5", "203.0.113.10-203.0.115.20"),
      true
    );
  });

  it("normalizes the candidate before matching", () => {
    assert.equal(matchesRule("::ffff:203.0.113.10", "203.0.113.10"), true);
  });

  it("rejects empty input", () => {
    assert.equal(matchesRule("", "203.0.113.10"), false);
    assert.equal(matchesRule("203.0.113.10", ""), false);
  });
});

describe("isIpAllowed", () => {
  it("allows everything when no rule is configured", () => {
    assert.equal(isIpAllowed("203.0.113.10", null), true);
    assert.equal(isIpAllowed("203.0.113.10", ""), true);
    assert.equal(isIpAllowed("203.0.113.10", "  ,  "), true);
  });

  it("allows a listed address and denies anything else", () => {
    const list = "203.0.113.10, 198.51.100.0/24";
    assert.equal(isIpAllowed("203.0.113.10", list), true);
    assert.equal(isIpAllowed("198.51.100.77", list), true);
    assert.equal(isIpAllowed("203.0.113.11", list), false);
  });

  it("denies when the client IP could not be resolved", () => {
    assert.equal(isIpAllowed("", "203.0.113.10"), false);
    assert.equal(isIpAllowed(undefined, "203.0.113.10"), false);
  });
});

describe("getClientIp", () => {
  it("prefers req.ip", () => {
    assert.equal(getClientIp({ ip: "::ffff:203.0.113.10" }), "203.0.113.10");
  });

  it("falls back to the left-most forwarded address", () => {
    const req = {
      headers: { "x-forwarded-for": "203.0.113.10, 70.41.3.18" },
    };
    assert.equal(getClientIp(req), "203.0.113.10");
  });

  it("falls back to the socket address", () => {
    const req = { headers: {}, socket: { remoteAddress: "203.0.113.44" } };
    assert.equal(getClientIp(req), "203.0.113.44");
  });

  it("returns an empty string when nothing is available", () => {
    assert.equal(getClientIp({ headers: {} }), "");
    assert.equal(getClientIp(null), "");
  });
});

describe("validateAllowList", () => {
  it("accepts the supported formats", () => {
    const result = validateAllowList(
      "203.0.113.10, 203.0.113.0/24, 203.0.113.*, 203.0.113.10-20, 2001:db8::1"
    );
    assert.equal(result.valid, true);
    assert.deepEqual(result.invalid, []);
  });

  it("reports entries it cannot parse", () => {
    const result = validateAllowList("203.0.113.10, not-an-ip, 10.0.0.0/64");
    assert.equal(result.valid, false);
    assert.deepEqual(result.invalid, ["not-an-ip", "10.0.0.0/64"]);
  });
});

describe("toBoolean", () => {
  it("reads MySQL tinyint values", () => {
    assert.equal(toBoolean(1), true);
    assert.equal(toBoolean(0), false);
  });

  it("reads string flags", () => {
    assert.equal(toBoolean("1"), true);
    assert.equal(toBoolean("false"), false);
  });

  it("falls back for null and undefined", () => {
    assert.equal(toBoolean(null, true), true);
    assert.equal(toBoolean(undefined, false), false);
  });
});

describe("normalizeIpPolicy", () => {
  it("accepts the three policies, case-insensitively and trimmed", () => {
    assert.equal(normalizeIpPolicy("branch"), "branch");
    assert.equal(normalizeIpPolicy(" Custom "), "custom");
    assert.equal(normalizeIpPolicy("UNRESTRICTED"), "unrestricted");
  });

  it("maps the previous release's outside-access boolean", () => {
    assert.equal(normalizeIpPolicy(true), "branch");
    assert.equal(normalizeIpPolicy(1), "branch");
    assert.equal(normalizeIpPolicy("1"), "branch");
    assert.equal(normalizeIpPolicy(false), "custom");
    assert.equal(normalizeIpPolicy(0), "custom");
    assert.equal(normalizeIpPolicy("0"), "custom");
  });

  it("returns null for anything else", () => {
    assert.equal(normalizeIpPolicy("garbage"), null);
    assert.equal(normalizeIpPolicy(null), null);
    assert.equal(normalizeIpPolicy(undefined), null);
  });
});

describe("resolveIpPolicy", () => {
  const EMP = { user_type: 1 };
  const ADMIN = { user_type: 2 };
  const B_ON = { branch_enabled: 1, branch_ips: "203.0.113.0/24" };
  const B_OFF = { branch_enabled: 0, branch_ips: "203.0.113.0/24" };

  it("exempts an employee following an unrestricted branch (the default state)", () => {
    const r = resolveIpPolicy({ ...EMP, ...B_OFF, ip_policy: "branch" });
    assert.equal(r.exempt, true);
  });

  it("confines an employee to a restricted branch's list", () => {
    const r = resolveIpPolicy({ ...EMP, ...B_ON, ip_policy: "branch" });
    assert.deepEqual(r, { exempt: false, rules: ["203.0.113.0/24"], source: "branch" });
  });

  it("fails closed when a restricted branch somehow has no list", () => {
    const r = resolveIpPolicy({ ...EMP, ip_policy: "branch", branch_enabled: 1, branch_ips: "" });
    assert.deepEqual(r, { exempt: false, rules: [], source: "branch" });
  });

  it("ignores a personal list while following the branch", () => {
    const r = resolveIpPolicy({ ...EMP, ...B_ON, ip_policy: "branch", allowed_ips: "198.51.100.5" });
    assert.deepEqual(r.rules, ["203.0.113.0/24"]);
  });

  it("exempts an admin from a restricted branch", () => {
    const r = resolveIpPolicy({ ...ADMIN, ...B_ON, ip_policy: "branch" });
    assert.deepEqual(r, { exempt: true, rules: [], source: "admin" });
  });

  it("enforces an admin who was explicitly set to custom", () => {
    const r = resolveIpPolicy({ ...ADMIN, ...B_OFF, ip_policy: "custom", allowed_ips: "198.51.100.5" });
    assert.equal(r.exempt, false);
    assert.deepEqual(r.rules, ["198.51.100.5"]);
  });

  it("uses only the personal list under custom when the branch is open", () => {
    const r = resolveIpPolicy({ ...EMP, ...B_OFF, ip_policy: "custom", allowed_ips: "198.51.100.5" });
    assert.deepEqual(r.rules, ["198.51.100.5"]);
  });

  it("unions personal and branch lists under custom, deduplicated", () => {
    const r = resolveIpPolicy({
      ...EMP, ...B_ON, ip_policy: "custom",
      allowed_ips: "198.51.100.5, 203.0.113.0/24",
    });
    assert.deepEqual(r.rules, ["198.51.100.5", "203.0.113.0/24"]);
  });

  it("fails closed under custom with nothing to enforce", () => {
    const r = resolveIpPolicy({ ...EMP, ...B_OFF, ip_policy: "custom", allowed_ips: "" });
    assert.deepEqual(r, { exempt: false, rules: [], source: "custom" });
  });

  it("exempts an unrestricted user regardless of lists or branch", () => {
    const r = resolveIpPolicy({ ...EMP, ...B_ON, ip_policy: "unrestricted", allowed_ips: "198.51.100.5" });
    assert.equal(r.exempt, true);
  });

  it("treats a missing or unknown policy as branch", () => {
    assert.equal(resolveIpPolicy({ ...EMP, ...B_ON, ip_policy: null }).source, "branch");
    assert.equal(resolveIpPolicy({ ...EMP, ...B_ON, ip_policy: "bogus" }).source, "branch");
  });

  it("exempts an employee with no outlet row at all", () => {
    const r = resolveIpPolicy({ ...EMP, ip_policy: "branch" });
    assert.deepEqual(r, { exempt: true, rules: [], source: "branch-open" });
  });
});

describe("isAccessAllowed", () => {
  it("admits an exempt policy from anywhere", () => {
    assert.equal(isAccessAllowed({ exempt: true, rules: [] }, "49.207.1.1"), true);
  });

  it("blocks a non-exempt policy with no rules", () => {
    assert.equal(isAccessAllowed({ exempt: false, rules: [] }, "203.0.113.10"), false);
  });

  it("checks the address against the rules", () => {
    const p = { exempt: false, rules: ["203.0.113.0/24"] };
    assert.equal(isAccessAllowed(p, "203.0.113.44"), true);
    assert.equal(isAccessAllowed(p, "49.207.1.1"), false);
  });

  it("fails closed on a malformed or legacy-shaped policy", () => {
    assert.equal(isAccessAllowed({}, "203.0.113.10"), false);
    assert.equal(isAccessAllowed(undefined, "203.0.113.10"), false);
    assert.equal(isAccessAllowed({ allow_outside_access: 1 }, "203.0.113.10"), false);
  });

  it("only a strict boolean true counts as exempt", () => {
    assert.equal(isAccessAllowed({ exempt: "1", rules: [] }, "203.0.113.10"), false);
  });
});

describe("validateIpPolicy", () => {
  it("accepts an unrestricted save with no list at all", () => {
    const result = validateIpPolicy({ restricted: false, allowedIps: "" });
    assert.equal(result.valid, true);
    assert.deepEqual(result.rules, []);
  });

  it("accepts a list kept on file while not restricted", () => {
    const result = validateIpPolicy({ restricted: false, allowedIps: "203.0.113.10" });
    assert.equal(result.valid, true);
    assert.deepEqual(result.rules, ["203.0.113.10"]);
  });

  it("accepts a restriction backed by a list", () => {
    const result = validateIpPolicy({ restricted: true, allowedIps: "203.0.113.10" });
    assert.equal(result.valid, true);
  });

  it("refuses a restriction with an empty list", () => {
    const result = validateIpPolicy({ restricted: true, allowedIps: "  " });
    assert.equal(result.valid, false);
    assert.match(result.reason, /at least one allowed IP/);
  });

  it("refuses an unparseable entry either way", () => {
    const result = validateIpPolicy({ restricted: false, allowedIps: "office-wifi" });
    assert.equal(result.valid, false);
    assert.match(result.reason, /office-wifi/);
  });
});

describe("isLoopbackIp", () => {
  it("matches the loopback range and IPv6 loopback", () => {
    assert.equal(isLoopbackIp("127.0.0.1"), true);
    assert.equal(isLoopbackIp("127.1.2.3"), true);
    assert.equal(isLoopbackIp("::1"), true);
    assert.equal(isLoopbackIp("::ffff:127.0.0.1"), true);
  });

  it("does not match a routable address", () => {
    assert.equal(isLoopbackIp("203.0.113.10"), false);
    assert.equal(isLoopbackIp("10.0.0.1"), false);
    assert.equal(isLoopbackIp(""), false);
  });
});

describe("isPrivateIp", () => {
  it("matches RFC1918, link-local and loopback", () => {
    assert.equal(isPrivateIp("10.1.2.3"), true);
    assert.equal(isPrivateIp("172.16.0.1"), true);
    assert.equal(isPrivateIp("172.31.255.254"), true);
    assert.equal(isPrivateIp("192.168.1.5"), true);
    assert.equal(isPrivateIp("169.254.1.1"), true);
    assert.equal(isPrivateIp("127.0.0.1"), true);
  });

  it("does not match public space just outside those ranges", () => {
    assert.equal(isPrivateIp("172.15.0.1"), false);
    assert.equal(isPrivateIp("172.32.0.1"), false);
    assert.equal(isPrivateIp("192.169.1.1"), false);
    assert.equal(isPrivateIp("203.0.113.10"), false);
  });
});


describe("validateIpPolicy loopback guard", () => {
  it("refuses a loopback address the broken-proxy bug would produce", () => {
    const result = validateIpPolicy({ restricted: true, allowedIps: "127.0.0.1" });
    assert.equal(result.valid, false);
    assert.match(result.reason, /talking to itself/);
    assert.match(result.reason, /X-Forwarded-For/);
  });

  it("refuses loopback even mixed in with a real address", () => {
    const result = validateIpPolicy({ restricted: true, allowedIps: "203.0.113.10, 127.0.0.1" });
    assert.equal(result.valid, false);
  });

  it("refuses a loopback CIDR too", () => {
    const result = validateIpPolicy({ restricted: true, allowedIps: "127.0.0.0/8" });
    assert.equal(result.valid, false);
  });

  it("refuses loopback even when not restricted", () => {
    // The list is kept for later, so a bad entry saved now would bite the
    // moment the restriction is switched on.
    const result = validateIpPolicy({ restricted: false, allowedIps: "127.0.0.1" });
    assert.equal(result.valid, false);
  });

  it("still accepts a private LAN address", () => {
    const result = validateIpPolicy({ restricted: true, allowedIps: "192.168.1.50" });
    assert.equal(result.valid, true);
  });

  it("still accepts a normal public address", () => {
    const result = validateIpPolicy({ restricted: true, allowedIps: "203.0.113.10" });
    assert.equal(result.valid, true);
  });
});
