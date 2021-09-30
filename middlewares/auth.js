const jwt = require("../services/jwt");

const unProtectedRoutes = {
  "/user": {
    methods: { post: true }
  },
  "/user/login": {
    methods: { get: true }
  },

  
  //department
  "/department": {
    methods: { get: true }
  },
  "/department/create": {
    methods: { post: true }
  },
  "/department/department_id": {
    methods: { get: true }
  },
  "/department/update-department": {
    methods: { post: true }
  },
  "/department/update-status": {
    methods: { post: true }
  },


  //designation
  "/designation": {
    methods: { get: true }
  },
  "/designation/create": {
    methods: { post: true }
  },
  "/designation/update-designation": {
    methods: { post: true }
  },
  "/designation/designation_id": {
    methods: { get: true }
  },
  "/designation/update-status": {
    methods: { post: true }
  },


  //employee
  "/employee": {
    methods: { post: true }
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
  "/employee/bank": {
    methods: { get: true }
  },
  "/employee/familydet": {
    methods: { get: true }
  },
  "/employee/update-status": {
    methods: { post: true }
  },


  //shift
  "/shift": {
    methods: { get: true }
  },
  "/shift/shift_id": {
    methods: { get: true }
  },
  "/shift/update-shift": {
    methods: { post: true }
  },
  "/shift/create": {
    methods: { post: true }
  },
  "/shift/update-status": {
    methods: { post: true }
  },

  //company
  "/company": {
    methods: { post: true }
  },
  "/company/update-status": {
    methods: { post: true } 
  },
  "/company/company_id": {
    methods: { get: true }
  },

  //assets
  "/asset": {
    methods: { post: true }
  },


  //document
  "/document/employee_id": {
    methods: { get: true }
  },
  "/document/adhaar": {
    methods: { get: true }
  },
  "/document/update-status": {
    methods: { post: true }
  },
  "/document/all": {
    methods: { get: true }
  },
  "/document/document_id": {
    methods: { get: true }
  },
  "/document/update-document": {
    methods: { post: true }
  },


  //store
  "/store": {
    methods: { get: true }
  },

  //Materials
  "/material": {
    methods: { get: true }
  },
  "/material/update-status": {
    methods: { post: true }
  },
  "/material/material_id": {
    methods: { get: true }
  },
  "/material/create": {
    methods: { post: true } 
  },
  "/material/update-material": {
    methods: { post: true }
  },

  //outlet
  "/outlet": {
    methods: { get: true }
  },
  "/outlet/update-outlet": {
    methods: { post: true }
  },
  "/outlet/create": {
    methods: { post: true }
  },
  "/outlet/update-status": {
    methods: { post: true }
  },


  //family
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
