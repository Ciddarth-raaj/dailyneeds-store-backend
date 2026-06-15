function errorHandler(err, req, res, next) {
  if (err.type === "request.aborted" || err.message === "request aborted") {
    console.warn(`Client aborted the request to: ${req.originalUrl}`);

    return res.status(400).json({
      error: "Request aborted by client or proxy.",
    });
  }

  console.error("Unhandled Error:", err);
  res.status(500).json({ error: "Internal Server Error" });
}

module.exports = errorHandler;
