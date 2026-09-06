const router = require("express").Router();
const Joi = require("@hapi/joi");
const { getClientIp, isLoopbackIp, isPrivateIp } = require("../utils/ip");
const authConfig = require("../config/auth");
const { actorUserId, rejectSystemAccounts } = require("../utils/actor");

/**
 * User routes — Stage 0A.
 *
 * Credentials arrive in the POST body. The query string is accepted only
 * while AUTH_LEGACY_QUERY_LOGIN is true, is counted (never with values),
 * and is removed in a standalone hotfix once the count reads zero.
 */
class UserRoutes {
  constructor(userUsecase, permissions, ipRestriction, deps = {}) {
    this.userUsecase = userUsecase;
    this.permissions = permissions;
    this.ipRestriction = ipRestriction;
    this.authLog = deps.authLogRepo || null;
    this.authMiddleware = deps.authMiddleware || null;
    this.config = deps.config || authConfig;
    // Production's Telegram-delivered reset (usecase/passwordReset.js).
    this.passwordResetUsecase = deps.passwordResetUsecase || null;
    this.init();
  }

  fail(res, err) {
    if (err && err.name === "ValidationError") {
      res.status(422).json({ code: 422, msg: err.message || err.toString() });
    } else if (err && err.status === 403) {
      res.status(403).json({ code: 403, error: err.code || "FORBIDDEN", msg: err.message });
    } else if (err && err.status === 404) {
      res.status(404).json({ code: 404, msg: err.message });
    } else if (err && err.status === 401) {
      res.status(401).json({ code: 401, msg: "Unauthorized" });
    } else {
      console.log(err);
      res.status(500).json({ code: 500, msg: "An error occurred !" });
    }
  }

  /**
   * Whether the request reached the app over TLS.
   *
   * `req.secure` is Express's answer, and Express consults X-Forwarded-Proto
   * ONLY when the immediate peer is within `trust proxy`. The raw header is
   * deliberately not read here: doing so would let any client that reaches
   * the app directly forge `https`. The proxy must overwrite the header
   * (`proxy_set_header X-Forwarded-Proto $scheme`), which the nginx patch
   * script does.
   */
  transportSecure(req) {
    return req.secure === true;
  }

  async metric(name) {
    if (!this.authLog) return;
    try {
      await this.authLog.bumpMetric(name);
    } catch (err) {
      // never affects the request
    }
  }

  init() {
    const { require: needs } = this.permissions;

    router.post("/login", async (req, res) => {
      try {
        const schema = {
          username: Joi.string().trim().required(),
          password: Joi.string().required(),
        };

        // Body first. Query string only during the frontend transition.
        let credentials = null;
        let transport = null;
        const body = req.body && typeof req.body === "object" ? req.body : {};
        if (typeof body.username === "string" && typeof body.password === "string") {
          credentials = { username: body.username, password: body.password };
          transport = "body";
        } else if (
          this.config.login.allowQueryString &&
          req.query &&
          typeof req.query.username === "string" &&
          typeof req.query.password === "string"
        ) {
          credentials = { username: req.query.username, password: req.query.password };
          transport = "query";
        }

        if (!credentials) {
          await this.metric("login_missing_credentials");
          return res.status(400).json({ msg: "Incorrect credentials", code: 400 });
        }

        const isValid = Joi.validate(credentials, schema);
        if (isValid.error !== null) throw isValid.error;

        await this.metric(transport === "query" ? "login_query_string" : "login_body");

        const data = await this.userUsecase.login(
          credentials.username,
          credentials.password,
          getClientIp(req),
          {
            transport,
            secure: this.transportSecure(req),
            userAgent: req.headers["user-agent"] || null,
          }
        );

        if (data.code === 200) {
          res.json({ data });
        } else if (data.code === 403) {
          res.status(403).json({ code: 403, error: data.error, msg: data.msg, ip: data.ip });
        } else {
          res.status(400).json({ msg: "Incorrect credentials", code: 400 });
        }
      } catch (err) {
        if (err.name === "ValidationError") {
          // Never echo the validation detail here: it would name the field
          // and could carry the value.
          res.status(400).json({ msg: "Incorrect credentials", code: 400 });
        } else {
          console.log(err && err.message);
          res.status(500).json({ code: 500, msg: "An error occurred !" });
        }
      }
      res.end();
    });

    // What the app sees about the caller's address and transport. Used by
    // the IP-restriction screen, and (A8) to confirm the proxy forwards the
    // protocol before AUTH_REQUIRE_HTTPS is switched on.
    router.get("/my-ip", async (req, res) => {
      const ip = getClientIp(req);
      const forwardedFor = req.headers["x-forwarded-for"];
      const forwardedProto = req.headers["x-forwarded-proto"];
      res.json({
        code: 200,
        ip,
        is_loopback: isLoopbackIp(ip),
        is_private: isPrivateIp(ip),
        has_forwarded_header: typeof forwardedFor === "string" && forwardedFor.trim() !== "",
        protocol: req.protocol,
        secure: this.transportSecure(req),
        has_forwarded_proto: typeof forwardedProto === "string" && forwardedProto.trim() !== "",
        require_https: this.config.login.requireHttps,
        legacy_query_login_enabled: this.config.login.allowQueryString,
      });
    });

    router.post("/change-password", async (req, res) => {
      try {
        const userId = actorUserId(req);
        const schema = {
          current_password: Joi.string().required(),
          new_password: Joi.string().required(),
        };
        const isValid = Joi.validate(req.body, schema);
        if (isValid.error !== null) throw isValid.error;

        const data = await this.userUsecase.changePassword(
          userId,
          req.body.current_password,
          req.body.new_password,
          { ip: getClientIp(req) }
        );
        if (data.code === 200) {
          if (this.authMiddleware && this.authMiddleware.invalidate) this.authMiddleware.invalidate(userId);
          res.json(data);
        } else {
          res.status(400).json(data);
        }
      } catch (err) {
        this.fail(res, err);
      }
    });

    // B5: redeem a setup/reset token. Public — the caller has no session.
    router.post("/setup-password", async (req, res) => {
      try {
        const schema = {
          token: Joi.string().required(),
          new_password: Joi.string().required(),
        };
        const isValid = Joi.validate(req.body, schema);
        if (isValid.error !== null) throw isValid.error;
        const data = await this.userUsecase.redeemSetupToken(req.body.token, req.body.new_password, {
          ip: getClientIp(req),
        });
        res.json(data);
      } catch (err) {
        this.fail(res, err);
      }
    });

    // --- Telegram linking (signed in) ---------------------------------------
    //
    // Linking is done from a signed-in session on purpose: it is what proves
    // the Telegram account on the other end belongs to this login, and the
    // reset flow later trusts that link completely.
    //
    // Stage 0A integration: identity comes from req.auth (the account key),
    // and a system / break-glass account is refused outright - it must never
    // acquire a Telegram-delivered reset path (C2).

    const noSystem = rejectSystemAccounts("Linking Telegram");

    router.get("/telegram-link", noSystem, async (req, res) => {
      try {
        const data = await this.passwordResetUsecase.getLinkStatus(actorUserId(req));
        res.json({ code: 200, ...data });
      } catch (err) {
        this.fail(res, err);
      }
    });

    router.post("/telegram-link", noSystem, async (req, res) => {
      try {
        const data = await this.passwordResetUsecase.startLink(actorUserId(req));
        res.json(data);
      } catch (err) {
        this.fail(res, err);
      }
    });

    router.delete("/telegram-link", noSystem, async (req, res) => {
      try {
        res.json(await this.passwordResetUsecase.unlink(actorUserId(req)));
      } catch (err) {
        this.fail(res, err);
      }
    });

    // --- Password reset (signed out) -----------------------------------------
    //
    // Both routes are reachable without a token — by definition the caller
    // cannot produce one. What stands in for it is a code delivered to the
    // Telegram chat the account linked earlier.

    router.post("/forgot-password", async (req, res) => {
      try {
        const schema = { username: Joi.string().trim().required() };
        const isValid = Joi.validate(req.body, schema);
        if (isValid.error !== null) throw isValid.error;

        // Deliberately the same answer whatever happened — see requestReset.
        res.json(
          await this.passwordResetUsecase.requestReset(req.body.username, {
            ip: getClientIp(req),
            userAgent: req.headers["user-agent"] || null,
          })
        );
      } catch (err) {
        this.fail(res, err);
      }
    });

    router.post("/reset-password", async (req, res) => {
      try {
        const schema = {
          username: Joi.string().trim().required(),
          code: Joi.string().trim().required(),
          new_password: Joi.string().required(),
        };
        const isValid = Joi.validate(req.body, schema);
        if (isValid.error !== null) throw isValid.error;

        const data = await this.passwordResetUsecase.resetPassword(
          req.body.username,
          req.body.code,
          req.body.new_password,
          { ip: getClientIp(req), userAgent: req.headers["user-agent"] || null }
        );
        if (data.code === 200) {
          res.json(data);
        } else {
          res.status(400).json(data);
        }
      } catch (err) {
        this.fail(res, err);
      }
    });

    // C5: server-side logout. Every token issued before now stops verifying
    // once AUTH_TOKEN_VALID_FROM_ENABLED is on; harmless before that.
    router.post("/logout", async (req, res) => {
      try {
        const userId = actorUserId(req);
        const data = await this.userUsecase.logout(userId, { ip: getClientIp(req) });
        if (this.authMiddleware && this.authMiddleware.invalidate) this.authMiddleware.invalidate(userId);
        res.json(data);
      } catch (err) {
        this.fail(res, err);
      }
    });

    // B6: admin-initiated reset. The token is in this response and nowhere else.
    router.post("/:id(\\d+)/reset-password", needs("manage_user_accounts"), async (req, res) => {
      try {
        const data = await this.userUsecase.issueReset(Number(req.params.id), actorUserId(req), {
          ip: getClientIp(req),
        });
        res.json(data);
      } catch (err) {
        this.fail(res, err);
      }
    });

    // B10: clear a temporary lock. Does not touch the password.
    router.post("/:id(\\d+)/unlock", needs("unlock_user_accounts", "manage_user_accounts"), async (req, res) => {
      try {
        const data = await this.userUsecase.unlock(Number(req.params.id), actorUserId(req), {
          ip: getClientIp(req),
        });
        if (this.authMiddleware && this.authMiddleware.invalidate) this.authMiddleware.invalidate(Number(req.params.id));
        res.json(data);
      } catch (err) {
        this.fail(res, err);
      }
    });

    router.get("/:id(\\d+)/account", needs("manage_user_accounts", "unlock_user_accounts"), async (req, res) => {
      try {
        const data = await this.userUsecase.getAccount(Number(req.params.id));
        if (!data) return res.status(404).json({ code: 404, msg: "Account not found" });
        res.json({ code: 200, data });
      } catch (err) {
        this.fail(res, err);
      }
    });

    router.get("/auth-log", needs("view_auth_log"), async (req, res) => {
      try {
        if (!this.authLog) return res.json({ code: 200, data: [] });
        const limit = Math.min(Number(req.query.limit) || 200, 1000);
        const data = await this.authLog.listRecent(limit, req.query.event || null);
        res.json({ code: 200, data });
      } catch (err) {
        this.fail(res, err);
      }
    });

    router.get("/auth-metrics", needs("view_auth_log", "manage_user_accounts"), async (req, res) => {
      try {
        if (!this.authLog) return res.json({ code: 200, data: [] });
        const data = await this.authLog.getMetrics(Math.min(Number(req.query.days) || 30, 365));
        res.json({ code: 200, data });
      } catch (err) {
        this.fail(res, err);
      }
    });

    router.get("/ip-restrictions", needs("manage_ip_restrictions"), async (req, res) => {
      try {
        const data = await this.userUsecase.getIpRestrictions();
        res.json({ code: 200, data });
      } catch (err) {
        this.fail(res, err);
      }
    });

    router.post("/ip-restrictions", needs("manage_ip_restrictions"), async (req, res) => {
      try {
        const schema = {
          user_id: Joi.number().integer().required(),
          allowed_ips: Joi.alternatives()
            .try(Joi.string().trim().allow(""), Joi.array().items(Joi.string()))
            .required(),
          ip_policy: Joi.string().valid("branch", "custom", "unrestricted").required(),
        };
        const isValid = Joi.validate(req.body, schema);
        if (isValid.error !== null) throw isValid.error;

        const target = await this.userUsecase.getAccount(req.body.user_id);
        if (target && Number(target.is_system_account) === 1) {
          return res.status(403).json({
            code: 403,
            error: "SYSTEM_ACCOUNT",
            msg: "Break-glass accounts cannot be modified through this API",
          });
        }

        const data = await this.userUsecase.updateIpPolicy(
          req.body.user_id,
          req.body.allowed_ips,
          req.body.ip_policy
        );
        if (this.ipRestriction && this.ipRestriction.invalidate) {
          this.ipRestriction.invalidate(req.body.user_id);
        }
        res.json(data);
      } catch (err) {
        this.fail(res, err);
      }
    });
  }

  getRouter() {
    return router;
  }
}

module.exports = (userUsecase, permissions, ipRestriction, deps) => {
  return new UserRoutes(userUsecase, permissions, ipRestriction, deps);
};
