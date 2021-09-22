const jwt = require("../services/jwt");

const unProtectedRoutes = {
  "/user": {
    methods: { post: true }
  },
  "/user/login": {
    methods: { get: true }
  },
  "/department": {
    methods: { get: true }
  },
  "/department/create": {
    methods: { post: true }
  },
  "/designation": {
    methods: { get: true }
  },
  "/designation/create": {
    methods: { post: true }
  },
  "/employee": {
    methods: { post: true }
  },
  "/shift": {
    methods: { get: true }
  },
  "/shift/shift_id": {
    methods: { get: true }
  },
  "/shift/update-shift": {
    methods: { post: true }
  },
  "/asset": {
    methods: { post: true }
  },
  "/shift/create": {
    methods: { post: true }
  },
  "/document/employee_id": {
    methods: { get: true }
  },
  "/employee/employees": {
    methods: { get: true }
  },
  "/employee/updatedata": {
    methods: { post: true }
  },
  "/employee/employee_id": {
    methods: { get: true }
  },
  "/store": {
    methods: { get: true }
  },
  "/department/department_id": {
    methods: { get: true }
  },
  "/department/update-department": {
    methods: { post: true }
  },
  "/designation/update-designation": {
    methods: { post: true }
  },
  "/designation/designation_id": {
    methods: { get: true }
  },
  "/employee/resignedemp": {
    methods: { get: true }
  },
  "/employee/newjoiner": {
    methods: { get: true }
  },
  "/employee/headcount": {
    methods: { get: true }
  },
  "/employee/birthday": {
    methods: { get: true }
  },
  "/employee/anniversary": {
    methods: { get: true }
  },
  "/outlet": {
    methods: { get: true }
  },
  "/outlet/update-outlet": {
    methods: { post: true }
  },
  "/outlet/create": {
    methods: { post: true }
  },
  "/family": {
    methods: { get: true }
  },
  "/family/create": {
    methods: { post: true }
  },
  "/family/family_id": {
    methods: { get: true }
  },
  "/family/update-family": {
    methods: { post: true }
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
