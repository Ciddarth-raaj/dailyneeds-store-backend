const router = require("express").Router();
const Joi = require("@hapi/joi");
const { getClientIp, isLoopbackIp, isPrivateIp } = require("../utils/ip");

class UserRoutes {
  constructor(userUsecase, permissions, ipRestriction, passwordResetUsecase) {
    this.userUsecase = userUsecase;
    this.permissions = permissions;
    this.ipRestriction = ipRestriction;
    this.passwordResetUsecase = passwordResetUsecase;
    this.init();
  }

  init() {
    const { require: needs } = this.permissions;

    router.post("/login", async (req, res) => {
      try {
        const schema = {
          username: Joi.string().trim().required(),
          password: Joi.string().trim().required(),
        };

        const credentials = req.query;
        const isValid = Joi.validate(credentials, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const data = await this.userUsecase.login(
          credentials.username,
          credentials.password,
          getClientIp(req)
        );
        if (data.code === 200) {
          res.json({ data });
        } else if (data.code === 403) {
          // Correct credentials, wrong network — say so, so the user isn't
          // left retrying a password that was never the problem.
          res.status(403).json({
            code: 403,
            error: data.error,
            msg: data.msg,
            ip: data.ip,
          });
        } else {
          res.status(400).json({ msg: "Incorrect credentials", code: 400 });
        }
      } catch (err) {
        console.log(err);
        if (err.name === "ValidationError") {
          res.status(422).json({ msg: err.toString() });
        } else {
          res.status(500).json({
            code: 500,
            msg: "An error occurred !",
          });
        }
      }

      res.end();
    });

    // The address this request came from, so an admin configuring a store's
    // static IP can read it off the screen instead of guessing.
    //
    // It also reports whether that address is believable. Behind a reverse
    // proxy that does not set X-Forwarded-For, every request looks like it
    // came from localhost; an admin allow-listing that would match every
    // user on every network. The screen needs to be able to say so rather
    // than presenting the wrong address as fact.
    router.get("/my-ip", async (req, res) => {
      const ip = getClientIp(req);
      const forwardedFor = req.headers["x-forwarded-for"];

      res.json({
        code: 200,
        ip,
        is_loopback: isLoopbackIp(ip),
        is_private: isPrivateIp(ip),
        // Present tells an admin the proxy is passing something through;
        // absent on a loopback address is the signature of the misconfig.
        has_forwarded_header: typeof forwardedFor === "string" && forwardedFor.trim() !== "",
      });
    });

    // A user changing their own password. The account is taken from the
    // token, never from the body, so this cannot be aimed at someone else;
    // the current password is still required, so a session left open on a
    // shared terminal cannot be used to lock its owner out.
    //
    // Credentials arrive in the body rather than the query string — unlike
    // /login, they are not written into access logs or browser history here.
    router.post("/change-password", async (req, res) => {
      try {
        if (!req.decoded || req.decoded.id === undefined) {
          return res.status(401).json({ code: 401, msg: "Unauthorized" });
        }

        const schema = {
          current_password: Joi.string().required(),
          new_password: Joi.string().required(),
        };

        const isValid = Joi.validate(req.body, schema);
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const data = await this.userUsecase.changePassword(
          req.decoded.id,
          req.body.current_password,
          req.body.new_password
        );

        if (data.code === 200) {
          res.json(data);
        } else {
          res.status(400).json(data);
        }
      } catch (err) {
        console.log(err);
        if (err.name === "ValidationError") {
          res.status(422).json({
            code: 422,
            msg: err.message || err.toString(),
          });
        } else {
          res.status(500).json({ code: 500, msg: "An error occurred !" });
        }
      }
    });

    // --- Telegram linking (signed in) ---------------------------------------
    //
    // Linking is done from a signed-in session on purpose: it is what proves
    // the Telegram account on the other end belongs to this login, and the
    // reset flow later trusts that link completely.

    router.get("/telegram-link", async (req, res) => {
      try {
        if (!req.decoded || req.decoded.id === undefined) {
          return res.status(401).json({ code: 401, msg: "Unauthorized" });
        }
        const data = await this.passwordResetUsecase.getLinkStatus(req.decoded.id);
        res.json({ code: 200, ...data });
      } catch (err) {
        console.log(err);
        res.status(500).json({ code: 500, msg: "An error occurred !" });
      }
    });

    router.post("/telegram-link", async (req, res) => {
      try {
        if (!req.decoded || req.decoded.id === undefined) {
          return res.status(401).json({ code: 401, msg: "Unauthorized" });
        }
        const data = await this.passwordResetUsecase.startLink(req.decoded.id);
        res.json(data);
      } catch (err) {
        console.log(err);
        if (err.name === "ValidationError") {
          res.status(422).json({ code: 422, msg: err.message || err.toString() });
        } else {
          res.status(500).json({ code: 500, msg: "An error occurred !" });
        }
      }
    });

    router.delete("/telegram-link", async (req, res) => {
      try {
        if (!req.decoded || req.decoded.id === undefined) {
          return res.status(401).json({ code: 401, msg: "Unauthorized" });
        }
        res.json(await this.passwordResetUsecase.unlink(req.decoded.id));
      } catch (err) {
        console.log(err);
        res.status(500).json({ code: 500, msg: "An error occurred !" });
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
        if (isValid.error !== null) {
          throw isValid.error;
        }

        // Deliberately the same answer whatever happened — see requestReset.
        res.json(await this.passwordResetUsecase.requestReset(req.body.username));
      } catch (err) {
        console.log(err);
        if (err.name === "ValidationError") {
          res.status(422).json({ code: 422, msg: err.message || err.toString() });
        } else {
          res.status(500).json({ code: 500, msg: "An error occurred !" });
        }
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
        if (isValid.error !== null) {
          throw isValid.error;
        }

        const data = await this.passwordResetUsecase.resetPassword(
          req.body.username,
          req.body.code,
          req.body.new_password
        );
        if (data.code === 200) {
          res.json(data);
        } else {
          res.status(400).json(data);
        }
      } catch (err) {
        console.log(err);
        if (err.name === "ValidationError") {
          res.status(422).json({ code: 422, msg: err.message || err.toString() });
        } else {
          res.status(500).json({ code: 500, msg: "An error occurred !" });
        }
      }
    });

    router.get(
      "/ip-restrictions",
      needs("manage_ip_restrictions"),
      async (req, res) => {
        try {
          const data = await this.userUsecase.getIpRestrictions();
          res.json({ code: 200, data });
        } catch (err) {
          console.log(err);
          res.status(500).json({ code: 500, msg: "An error occurred !" });
        }
      }
    );

    router.post(
      "/ip-restrictions",
      needs("manage_ip_restrictions"),
      async (req, res) => {
        try {
          const schema = {
            user_id: Joi.number().integer().required(),
            allowed_ips: Joi.alternatives()
              .try(Joi.string().trim().allow(""), Joi.array().items(Joi.string()))
              .required(),
            ip_policy: Joi.string()
              .valid("branch", "custom", "unrestricted")
              .required(),
          };

          const isValid = Joi.validate(req.body, schema);
          if (isValid.error !== null) {
            throw isValid.error;
          }

          const data = await this.userUsecase.updateIpPolicy(
            req.body.user_id,
            req.body.allowed_ips,
            req.body.ip_policy
          );

          // The middleware caches policies for a minute; drop this user's
          // entry so the change applies to their next request.
          if (this.ipRestriction && this.ipRestriction.invalidate) {
            this.ipRestriction.invalidate(req.body.user_id);
          }

          res.json(data);
        } catch (err) {
          console.log(err);
          if (err.name === "ValidationError") {
            res.status(422).json({ code: 422, msg: err.message || err.toString() });
          } else {
            res.status(500).json({ code: 500, msg: "An error occurred !" });
          }
        }
      }
    );
  }

  getRouter() {
    return router;
  }
}

module.exports = (userUsecase, permissions, ipRestriction, passwordResetUsecase) => {
  return new UserRoutes(userUsecase, permissions, ipRestriction, passwordResetUsecase);
};
