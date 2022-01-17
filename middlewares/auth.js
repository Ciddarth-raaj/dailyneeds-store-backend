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
  "/department/imageupload": {
    methods: { post: true }
  },
  "/department/product-department": {
    methods: { get: true }
  },
  "/department/update-prodstatus": {
    methods: { post: true }
  },

  //indents
  "/indent": {
    methods: { get: true }
  },
  "/indent/indentcount": {
    methods: { get: true }
  },
  "/indent/create": {
    methods: { post: true }
  },
  "/indent/despatch": {
    methods: { get: true }
  },
  "/indent/sent/store_id": {
    methods: { get: true }
  },
  "/indent/from/store_id": {
    methods: { get: true }
  },

  //despatch
  "/despatch/create": {
    methods: { post: true }
  },
  "/despatch": {
    methods: { get: true }
  },
  "/despatch/store_id": {
    methods: { get: true }
  },
  "/despatch/despatch_id": {
    methods: { get: true }
  },

  //categories
  "/category": {
    methods: { get: true }
  },
  "/category/catcount": {
    methods: { get: true }
  },
  "/category/imageupload": {
    methods: { post: true }
  },

  //subcategories
  "/subcategory": {
    methods: { get: true }
  },
  "/subcategory/subcatcount": {
    methods: { get: true }
  },
  "/subcategory/imageupload": {
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
  // "/designation/permissions": {
  //   methods: { get: true }
  // },


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
  "/employee/store_id": {
    methods: { get: true }
  },

  //salary
  "/salary": {
    methods: { get: true }
  },
  "/salary/create": {
    methods: { post: true }
  },
  "/salary/update-payment": {
    methods: { post: true }
  },
  "/salary/update-status": {
    methods: { post: true }
  },
  "/salary/payment_id": {
    methods: { get: true }
  },
  "/salary/update-paidstatus": {
    methods: { post: true }
  },

  //resignation
  "/resignation": {
    methods: { get: true }
  },
  "/resignation/create": {
    methods: { post: true }
  },
  "/resignation/employee_name": {
    methods: { get: true }
  },
  "/resignation/update-resignation": {
    methods: { post: true }
  },

  //product
  "/product/create": {
    methods: { post: true }
  },
  "/product/updatedata": {
    methods: { post: true }
  },
  "/product": {
    methods: { get: true }
  },
  "/product/product_id": {
    methods: { get: true }
  },
  "/product/getById": {
    methods: { get: true }
  },
  "/product/prodcount": {
    methods: { get: true }
  },
  "/product/filter": {
    methods: { get: true }
  },
  "/product/all": {
    methods: { get: true }
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

  //image
  "/image/product_id": {
    methods: { get: true }
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
  "/document/withoutadhaar": {
    methods: { get: true }
  },

  //store
  "/store": {
    methods: { get: true }
  },
  "/store/store_id": {
    methods: { get: true }
  },

  //Materialtype
  "/materialtype": {
    methods: { get: true }
  },
  "/materialtype/update-status": {
    methods: { post: true }
  },
  "/materialtype/type_id": {
    methods: { get: true }
  },
  "/materialtype/create": {
    methods: { post: true }
  },
  "/materialtype/type": {
    methods: { get: true }
  },
  "/materialtype/size": {
    methods: { get: true }
  },
  "/materialtype/typecount": {
    methods: { get: true }
  },
  "/materialtype/update-materialtype": {
    methods: { post: true }
  },

    //Materialsize
    "/materialsize": {
      methods: { get: true }
    },
    "/materialsize/update-status": {
      methods: { post: true }
    },
    "/materialsize/material_id": {
      methods: { get: true }
    },
    "/materialsize/create": {
      methods: { post: true }
    },
    "/materialsize/update-materialsize": {
      methods: { post: true }
    },
    "/materialsize/type": {
      methods: { get: true }
    },
    "/materialsize/size": {
      methods: { get: true }
    },
    "/materialsize/sizecount": {
      methods: { get: true }
    },
    "/materialsize/size_id": {
      methods: { get: true }
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
  "/outlet/outlet_id": {
    methods: { get: true }
  },

  //brand
  "/brand": {
    methods: { get: true }
  },
  "/brand/brandcount": {
    methods: { get: true }
  },

  //vechicle
  "/vehicle": {
    methods: { get: true }
  },

  //issue
  "/issue/create": {
    methods: { post: true }
  },
  "/issue": {
    methods: { get: true }
  },
  "/issue/store_id": {
    methods: { get: true }
  },
  "/issue/from/store_id": {
    methods: { get: true }
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
  },
  "/family/employee_name": {
    methods: { get: true }
  },

  //user
  "/user/login": { methods: { post: true } },
}

async function auth(req, res, next) {
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
      req.decoded = {};
      req.decoded.id = decoded.user_id;
      req.decoded.store_id = decoded.store_id;
      req.decoded.user_type = decoded.user_type;
      req.decoded.designation_id = decoded.designation_id;

      // if (decoded.role !== "ADMIN") {
      //   res.json({ code: 403, msg: "Access Denied" });
      //   res.end();
      //   return;
      // }
    }
  } catch (err) {
    res.json({ code: 403, msg: "Access Denied" });
    res.end();
    return;
  }

  next();
}

module.exports = auth;
