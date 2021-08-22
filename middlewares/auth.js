const jwt = require("../services/jwt");

const unProtectedRoutes = {
  "/user": {
    methods: { post: true }
  },
  "/user/login": {
    methods: { get: true }
  }
}

async function auth (req, res, next) {
  if (
    unProtectedRoutes[req.path] &&
    unProtectedRoutes[req.path]["methods"][req.method.toLowerCase()]
  ) {
    next()
    return
  }

  try {
    const token = req.headers["x-access-token"];

    if (token === undefined) {
      res.json({ code: 403, msg: "Access Denied" });
      res.end();
      return;
    } else {
      const decoded = await jwt.verify(token);

      if (decoded.role !== "ADMIN") {
        res.json({ code: 403, msg: "Access Denied" });
        res.end();
        return;
      }
    }
  } catch (err) {
    res.json({ code: 403, msg: "Access Denied" });
    res.end();
    return;
  }

  next();
}

module.exports = auth;
