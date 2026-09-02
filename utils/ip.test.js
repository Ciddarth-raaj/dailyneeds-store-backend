const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  getClientIp,
  isIpAllowed,
  matchesRule,
  normalizeIp,
  parseAllowList,
  validateAllowList,
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
