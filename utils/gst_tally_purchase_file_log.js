const fs = require("fs");
const path = require("path");

const TMP_DIR = path.join(__dirname, "..", "tmp");
const INPUT_FILE = path.join(TMP_DIR, "gst-tally-purchase-input.json");
const RESPONSE_FILE = path.join(TMP_DIR, "gst-tally-purchase-response.json");
const ERROR_FILE = path.join(TMP_DIR, "gst-tally-purchase-error.json");
const LOG_FILES = [INPUT_FILE, RESPONSE_FILE, ERROR_FILE];

function removeFileIfExists(filePath) {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

/** Deletes previous gst-purchase log files before writing the latest request. */
function clearPreviousLogs() {
  try {
    ensureTmpDir();
    for (const filePath of LOG_FILES) {
      removeFileIfExists(filePath);
    }
  } catch (err) {
    console.error("[gst-tally-purchase-file-log] clear:", err.message);
  }
}

function ensureTmpDir() {
  if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  }
}

function writeJsonFile(filePath, payload) {
  try {
    ensureTmpDir();
    const envelope = {
      logged_at: new Date().toISOString(),
      ...payload,
    };
    fs.writeFileSync(filePath, JSON.stringify(envelope, null, 2), "utf8");
  } catch (err) {
    console.error("[gst-tally-purchase-file-log]", err.message);
  }
}

function writeInput(body) {
  writeJsonFile(INPUT_FILE, { input: body ?? null });
}

function writeResponse(body) {
  writeJsonFile(RESPONSE_FILE, { response: body ?? null });
}

function writeError(body, httpStatus) {
  writeJsonFile(ERROR_FILE, {
    http_status: httpStatus ?? null,
    error: body ?? null,
  });
}

module.exports = {
  TMP_DIR,
  INPUT_FILE,
  RESPONSE_FILE,
  ERROR_FILE,
  clearPreviousLogs,
  writeInput,
  writeResponse,
  writeError,
};
