module.exports = function respondError (res, err) {
    if (err.name && err.name === "ValidationError") {
      res.status(400)
      res.json({ code: 422, msg: err.toString() })
    } else {
      res.status(500)
      if (global.isDev()) {
        res.json({ code: 500, msg: err.toString() })
      } else {
        res.json({ code: 500, msg: "An error occurred !" })
      }
    }
  }
  