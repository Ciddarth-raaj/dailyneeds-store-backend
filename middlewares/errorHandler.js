const logger = require("../utils/logger");

function errorHandler(err, req, res, next) {
  if (err.type === "request.aborted" || err.message === "request aborted") {
    console.warn(`Client aborted the request to: ${req.originalUrl}`);

    return res.status(400).json({
      code: 400,
      msg: "Request aborted by client or proxy.",
    });
  }

  if (err.type === "entity.parse.failed") {
    const detail =
      err.message && err.message !== "Unexpected token"
        ? err.message
        : "Request body is not valid JSON";

    logger.Log({
      level: logger.LEVEL.WARN,
      component: "MIDDLEWARE.ERROR_HANDLER",
      code: "MIDDLEWARE.ERROR_HANDLER.PARSE_FAILED",
      description: `${req.method} ${req.originalUrl}: ${detail}`,
      category: "",
      ref: {},
    });

    return res.status(400).json({
      code: 400,
      msg: `Invalid JSON body: ${detail}. Ensure Content-Type is application/json and the payload is valid JSON (no trailing commas, NaN, or truncated data).`,
    });
  }

  if (err.type === "entity.too.large") {
    return res.status(413).json({
      code: 413,
      msg: "Request body too large.",
    });
  }

  console.error("Unhandled Error:", err);
  res.status(err.status || err.statusCode || 500).json({
    code: err.status || err.statusCode || 500,
    msg: global.isDev() ? err.message || "Internal Server Error" : "Internal Server Error",
  });
}

module.exports = errorHandler;
