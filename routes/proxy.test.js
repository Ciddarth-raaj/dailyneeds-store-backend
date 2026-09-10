/**
 * Trust-proxy and forwarded-header spoofing (safety correction pass, item 8;
 * regression category 14F).
 *
 * Topology: browser -> nginx (same host, loopback) -> Node on :8080.
 * nginx supplies X-Real-IP, X-Forwarded-For ($remote_addr, overwrite) and
 * X-Forwarded-Proto ($scheme, overwrite) per scripts/patch_nginx_forwarded.py.
 * `trust proxy` therefore trusts loopback only. A client that reaches the
 * Node port directly (any non-loopback peer) is untrusted and its headers
 * are ignored; a client behind nginx cannot forge because nginx overwrites.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const bodyParser = require("body-parser");
const F = require("../test_support/auth_fixtures");
const buildUserUsecase = require("../usecase/user");
const { getClientIp } = require("../utils/ip");

const PASSWORD = "legacy-pass-1";

function makeApp(trustProxy, configOver = {}) {
  const rows = {
    "1003": F.employeeRow({ password: F.legacyHash(PASSWORD), ...(configOver.rowOver || {}) }),
  };
  const authLog = F.fakeAuthLog();
  const config = F.config(configOver.config || {});
  const usecase = buildUserUsecase(F.fakeUserRepo(rows), null, null, { authLogRepo: authLog, config, jwt: F.makeJwt().service });
  delete require.cache[require.resolve("./user")];
  const routes = require("./user")(usecase, { require: () => (req, res, next) => next() }, null, { authLogRepo: authLog, config });
  const app = express();
  app.set("trust proxy", trustProxy);
  app.use(bodyParser.json());
  app.get("/whoami", (req, res) => res.json({ ip: getClientIp(req), secure: req.secure, protocol: req.protocol }));
  app.use("/user", routes.getRouter());
  return { app, authLog };
}
const listen = (app) => new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r({ server: s, port: s.address().port })); });

describe("14F / §8 — forwarded-header spoofing", () => {
  it("with the default loopback trust, a NON-loopback peer's forged headers are ignored (direct exposure)", async () => {
    // Simulate "peer is not the proxy" by trusting only an address that is not 127.0.0.1.
    const { app } = makeApp("203.0.113.1");
    const { server, port } = await listen(app);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/whoami`, { headers: { "x-forwarded-for": "1.2.3.4", "x-forwarded-proto": "https" } });
      const body = await res.json();
      assert.equal(body.ip, "127.0.0.1", "forged X-Forwarded-For must not become the trusted identity");
      assert.equal(body.secure, false, "forged X-Forwarded-Proto must not make the request secure");
    } finally { server.close(); }
  });

  it("forged X-Forwarded-Proto: https cannot bypass HTTPS enforcement from an untrusted peer", async () => {
    const { app } = makeApp("203.0.113.1", { config: { login: { requireHttps: true } } });
    const { server, port } = await listen(app);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/user/login`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-proto": "https" },
        body: JSON.stringify({ username: "1003", password: PASSWORD }),
      });
      assert.equal(res.status, 403);
      assert.equal((await res.json()).error, "INSECURE_TRANSPORT");
      const my = await (await fetch(`http://127.0.0.1:${port}/user/my-ip`, { headers: { "x-forwarded-proto": "https" } })).json();
      assert.equal(my.secure, false);
      assert.equal(my.has_forwarded_proto, true, "the raw header is reported so the operator can see the forgery attempt");
    } finally { server.close(); }
  });

  it("the trusted proxy's X-Forwarded-Proto (loopback peer) is honoured - the nginx case", async () => {
    const { app } = makeApp("loopback", { config: { login: { requireHttps: true } } });
    const { server, port } = await listen(app);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/user/login`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-proto": "https" },
        body: JSON.stringify({ username: "1003", password: PASSWORD }),
      });
      assert.equal(res.status, 200);
    } finally { server.close(); }
  });

  it("with loopback trust, a multi-hop X-Forwarded-For yields the address the proxy added, not a client-prepended one", async () => {
    // If nginx ever appended rather than overwrote, the client-supplied
    // leftmost entry must still lose: Express walks from the right and stops
    // at the first untrusted address.
    const { app } = makeApp("loopback");
    const { server, port } = await listen(app);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/whoami`, { headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.9" } });
      assert.equal((await res.json()).ip, "203.0.113.9");
    } finally { server.close(); }
  });

  it("IP-restriction decisions use the trusted address, so a forged header cannot satisfy a branch allow-list", async () => {
    const rowOver = { ip_policy: "custom", allowed_ips: "203.0.113.50" };
    const { app } = makeApp("203.0.113.1", { rowOver });
    const { server, port } = await listen(app);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/user/login`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.50" },
        body: JSON.stringify({ username: "1003", password: PASSWORD }),
      });
      assert.equal(res.status, 403);
      assert.equal((await res.json()).error, "IP_NOT_ALLOWED");
    } finally { server.close(); }
  });

  it("server.js never accepts TRUST_PROXY=true", () => {
    const src = require("fs").readFileSync(require("path").join(__dirname, "../server.js"), "utf8");
    assert.match(src, /function resolveTrustProxy/);
    assert.match(src, /return "loopback"/);
    assert.doesNotMatch(src, /process\.env\.TRUST_PROXY \|\| true/);
  });
});
