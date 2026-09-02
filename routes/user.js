const router = require("express").Router();
const Joi = require("@hapi/joi");
const { getClientIp } = require("../utils/ip");

class UserRoutes {
  constructor(userUsecase, permissions, ipRestriction) {
    this.userUsecase = userUsecase;
    this.permissions = permissions;
    this.ipRestriction = ipRestriction;
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
    router.get("/my-ip", async (req, res) => {
      res.json({ code: 200, ip: getClientIp(req) });
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
          };

          const isValid = Joi.validate(req.body, schema);
          if (isValid.error !== null) {
            throw isValid.error;
          }

          const data = await this.userUsecase.updateAllowedIps(
            req.body.user_id,
            req.body.allowed_ips
          );

          // The middleware caches allow-lists for a minute; drop this user's
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

module.exports = (userUsecase, permissions, ipRestriction) => {
  return new UserRoutes(userUsecase, permissions, ipRestriction);
};
