require("dotenv").config();

const IS_PROD = process.env.IS_TEST === "false"

module.exports = { IS_PROD };
