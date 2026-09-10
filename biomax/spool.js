/**
 * Last-resort disk spool.
 *
 * A frame that could not be written to EITHER table (database down, disk
 * full on the DB host, ...) is appended here as `<ts>-<dev_id>.bin` so it
 * can be examined. It is NOT a recovery queue: under R1 such a frame is not
 * acknowledged, so the device retransmits it in ~3 minutes and the database
 * gets it then. The spool exists so an operator can see what was refused
 * and why, not so the receiver can pretend it succeeded.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

function createSpool(dir) {
  const target = dir || path.join(os.homedir(), "biomax-spool");
  let ready = false;

  function ensure() {
    if (ready) return;
    fs.mkdirSync(target, { recursive: true });
    ready = true;
  }

  function write(devId, frame, reason) {
    ensure();
    const safeDev = String(devId || "unknown").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
    const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeDev}.bin`;
    const file = path.join(target, name);
    fs.writeFileSync(file, frame);
    fs.writeFileSync(`${file}.reason.txt`, String(reason || ""));
    return file;
  }

  return { write, dir: target };
}

module.exports = { createSpool };
