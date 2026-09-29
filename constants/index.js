require("dotenv").config();

// NOT a reliable production signal: the production PM2 process does not set
// IS_TEST=false (nor NODE_ENV), so this is false there. services/pdf.js used
// it to pick system Chrome and so ran bundled Chromium in production (2026-09
// orphaned-Chrome incident); it now resolves Chrome in services/pdf_browser.js.
// No code reads IS_PROD any more - do not start using it.
const IS_PROD = process.env.IS_TEST === "false"

module.exports = { IS_PROD };
