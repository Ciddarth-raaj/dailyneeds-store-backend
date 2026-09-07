const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const bodyParser = require("body-parser");
const F = require("../test_support/auth_fixtures");
const buildUserUsecase = require("../usecase/user");

/**
 * HTTP-level tests for POST /user/login (A7): credentials in the body,
 * the temporary query-string fallback, its independent kill switch, and
 * the guarantee that no password reaches any log line.
 */

const IP = "203.0.113.5";
const PASSWORD = "legacy-pass-1";

function makeApp(configOver = {}) {
  const rows = { "1003": F.employeeRow({ password: F.legacyHash(PASSWORD), password_algo: "sha1" }) };
  const authLog = F.fakeAuthLog();
  const { service: jwt } = F.makeJwt();
  const config = F.config(configOver);
  const usecase = buildUserUsecase(F.fakeUserRepo(rows), null, null, { authLogRepo: authLog, config, jwt });

  const permissions = { require: () => (req, res, next) => next(), has: async () => true };
  // A fresh router module instance per app: routes/user.js holds a module-level Router.
  delete require.cache[require.resolve("./user")];
  const routes = require("./user")(usecase, permissions, null, { authLogRepo: authLog, config });

  const logLines = [];
  const app = express();
  app.set("trust proxy", true);
  app.use((req, res, next) => {
    // Simulate an access log that records the request line — the thing A7 exists to keep clean.
    logLines.push(`${req.method} ${req.originalUrl}`);
    next();
  });
  app.use(bodyParser.json());
  app.use(bodyParser.urlencoded({ extended: true }));
  app.use("/user", routes.getRouter());
  return { app, authLog, logLines };
}

const listen = (app) =>
  new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });

describe("POST /user/login transport (A7)", () => {
  it("11. POST-body login works and is counted as body", async () => {
    const { app, authLog, logLines } = makeApp();
    const { server, port } = await listen(app);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/user/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "1003", password: PASSWORD }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.data.code, 200);
      assert.ok(body.data.token);
      assert.ok(authLog.events.some((e) => e.metric === "login_body"));
      // 14. the password does not appear in the URL
      assert.equal(logLines.some((l) => l.includes(PASSWORD)), false);
      assert.equal(logLines.some((l) => l.includes("password=")), false);
    } finally {
      server.close();
    }
  });

  it("12. the query-string fallback works during the compatibility window and is counted separately", async () => {
    const { app, authLog } = makeApp({ login: { allowQueryString: true } });
    const { server, port } = await listen(app);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/user/login?username=1003&password=${encodeURIComponent(PASSWORD)}`, { method: "POST" });
      assert.equal(res.status, 200);
      assert.ok(authLog.events.some((e) => e.metric === "login_query_string"));
      const success = authLog.events.find((e) => e.event === "login_success");
      assert.equal(success.detail, "legacy_query_string");
    } finally {
      server.close();
    }
  });

  it("13. the query-string fallback can be disabled independently", async () => {
    const { app, authLog } = makeApp({ login: { allowQueryString: false } });
    const { server, port } = await listen(app);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/user/login?username=1003&password=${encodeURIComponent(PASSWORD)}`, { method: "POST" });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).msg, "Incorrect credentials");
      assert.equal(authLog.events.some((e) => e.metric === "login_query_string"), false);
      // body still works with the fallback off
      const ok = await fetch(`http://127.0.0.1:${port}/user/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "1003", password: PASSWORD }),
      });
      assert.equal(ok.status, 200);
    } finally {
      server.close();
    }
  });

  it("body takes precedence over the query string when both are present", async () => {
    const { app, authLog } = makeApp();
    const { server, port } = await listen(app);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/user/login?username=1003&password=wrong`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "1003", password: PASSWORD }),
      });
      assert.equal(res.status, 200);
      assert.ok(authLog.events.some((e) => e.metric === "login_body"));
    } finally {
      server.close();
    }
  });

  it("15. the password and token never reach the audit log", async () => {
    const { app, authLog } = makeApp();
    const { server, port } = await listen(app);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/user/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "1003", password: PASSWORD }),
      });
      const { data } = await res.json();
      const dumped = JSON.stringify(authLog.events);
      assert.equal(dumped.includes(PASSWORD), false);
      assert.equal(dumped.includes(data.token), false);
    } finally {
      server.close();
    }
  });

  it("6. wrong password and unknown user return the identical HTTP response", async () => {
    const { app } = makeApp();
    const { server, port } = await listen(app);
    try {
      const post = (u, p) =>
        fetch(`http://127.0.0.1:${port}/user/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: u, password: p }),
        });
      const a = await post("1003", "wrong");
      const b = await post("ghost", "wrong");
      assert.equal(a.status, b.status);
      assert.deepEqual(await a.json(), await b.json());
    } finally {
      server.close();
    }
  });

  it("A8: refuses plaintext when AUTH_REQUIRE_HTTPS is on, and accepts X-Forwarded-Proto: https", async () => {
    const { app } = makeApp({ login: { requireHttps: true } });
    const { server, port } = await listen(app);
    try {
      const plain = await fetch(`http://127.0.0.1:${port}/user/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "1003", password: PASSWORD }),
      });
      assert.equal(plain.status, 403);
      assert.equal((await plain.json()).error, "INSECURE_TRANSPORT");
      const proxied = await fetch(`http://127.0.0.1:${port}/user/login`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-proto": "https" },
        body: JSON.stringify({ username: "1003", password: PASSWORD }),
      });
      assert.equal(proxied.status, 200);
    } finally {
      server.close();
    }
  });

  it("/user/my-ip reports what the proxy tells the app about transport", async () => {
    const { app } = makeApp();
    const { server, port } = await listen(app);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/user/my-ip`, { headers: { "x-forwarded-proto": "https" } });
      const body = await res.json();
      assert.equal(body.secure, true);
      assert.equal(body.has_forwarded_proto, true);
      assert.equal(typeof body.legacy_query_login_enabled, "boolean");
    } finally {
      server.close();
    }
  });
});
