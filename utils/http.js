module.exports = function respondError (res, err) {
    if (err.name && err.name === "ValidationError") {
      res.status(400)
      res.json({ code: 422, msg: err.toString() })
    } else if (err.name === "MissingProductIdsError") {
      res.status(400)
      const body = {
        code: 400,
        msg: err.message,
        missing_product_ids: err.missing_product_ids || [],
      }
      if (err.dn_ref_no != null) {
        body.dn_ref_no = err.dn_ref_no
      }
      res.json(body)
    } else {
      res.status(500)
      if (global.isDev()) {
        res.json({ code: 500, msg: err.toString() })
      } else {
        res.json({ code: 500, msg: "An error occurred !" })
      }
    }
  }
  