const winston = require("winston");
const serviceName = "example-service";

const logger = winston.createLogger({
  format: winston.format.json(),
  defaultMeta: { service: serviceName },
  transports: [new winston.transports.Console()]
});

logger.LEVEL = {
  ERROR: "error",
  WARN: "warning",
  INFO: "info",
  VERBOSE: "verbose",
  DEBUG: "debug",
  SILLY: "silly"
};

logger.Log = ({
  level = logger.LEVEL.INFO,
  component = "",
  code = "",
  description = "",
  category = "",
  ref = {}
}) => {
  logger.log({
    level: level,
    component: component,
    code: code,
    description: description,
    category: category,
    ref: ref
  });
};

module.exports = logger;
