const { readFrozenSnapshot, payslipFilename } = require("../utils/payslip_snapshot");
const crypto = require("crypto");
const { monthLabel, PDF_LINK_TTL_SECONDS } = require("../constants/payslip");

/**
 * MY PAYSLIPS - the Telegram Mini App's self-service payslip reads.
 *
 * =============================================== WHO THE EMPLOYEE IS ====
 *
 * Every function takes `employeeId` FIRST, and the only caller
 * (`routes/telegram_payslip.js`) passes `req.miniApp.employee_id` - the
 * signed `emp` claim of the Mini App session, which
 * `telegram_attendance_session#exchange` minted from Telegram-signed initData
 * and the ACTIVE `employee_telegram_identity` row. Nothing here reads an
 * employee from a request, and the repository pins every statement to it.
 *
 * ====================================================== WHAT IS SHOWN ===
 *
 * Only ACTIVE payslips whose month is still published, read from the FROZEN
 * snapshot (integrity-checked against its SHA-256) - never from attendance,
 * Salary Master, OT or adjustments. Another employee's payslip, an archived
 * one and an unpublished month are all the same answer: 404.
 *
 * ========================================================= THE PDF ======
 *
 * Rendered on demand from the same snapshot the detail screen shows, then
 * streamed and forgotten. Nothing is written to disk, S3 or the database.
 *
 * THE NORMAL DOWNLOAD IS `pdf(employeeId, ref)` behind the session header.
 *
 * THE LINK FALLBACK exists only for Telegram's own downloader
 * (`WebApp.downloadFile`), which fetches a URL itself and cannot send our
 * header. `pdfLink` issues an OPAQUE random token (32 bytes) that:
 *   - names ONE payslip of ONE employee (both re-checked when it is spent);
 *   - lives PDF_LINK_TTL_SECONDS (60 s);
 *   - is SINGLE-USE - removed from the store on its first presentation,
 *     whatever the outcome;
 *   - is not a JWT and not signed with the session key: it is meaningless to
 *     the session gate and to the login middleware;
 *   - is kept in this process's memory ONLY AS ITS SHA-256 - a restart
 *     invalidates every outstanding link (fail closed).
 */
const REF_RE = /^[0-9a-f]{32}$/;

function notFound() {
  const err = new Error("Payslip not found");
  err.name = "NotFoundError";
  err.status = 404;
  return err;
}

function linkInvalid() {
  const err = new Error("This download link has expired. Please try again from My Payslips.");
  err.name = "TelegramAuthError";
  err.code = "PAYSLIP_LINK_INVALID";
  err.status = 401;
  return err;
}

/** The snapshot without its internal source references - the employee needs none of them. */
function employeeView(snapshot) {
  const { source, ...visible } = snapshot || {};
  return visible;
}

/**
 * @param {object} deps
 * @param {object} deps.payslipRepo  repository/payrun_payslip.js
 * @param {function(object):Promise<Buffer>} deps.renderPdf  services/payslip_pdf.js#renderPayslipPdf
 * @param {function():number} [deps.now]  ms, injected in tests
 * @param {object} [deps.log]
 */
module.exports = ({ payslipRepo, renderPdf, log = null, now = () => Date.now(), linkTtlSeconds = PDF_LINK_TTL_SECONDS, maxLinks = 5000 }) => {
  /** sha256(token) -> { employee_id, ref, expires_at } */
  const links = new Map();
  const hash = (token) => crypto.createHash("sha256").update(token, "utf8").digest("hex");
  const prune = () => {
    const t = now();
    for (const [k, v] of links) if (v.expires_at <= t) links.delete(k);
    while (links.size >= maxLinks) links.delete(links.keys().next().value);
  };
  const COMPONENT = "USECASE.TELEGRAM-PAYSLIP";
  const audit = (code, ref) => {
    if (!log || typeof log.Log !== "function") return;
    try {
      log.Log({ level: (log.LEVEL && log.LEVEL.INFO) || "info", component: COMPONENT, code: `${COMPONENT}.${code}`, description: code, category: "", ref });
    } catch (err) {
      // never breaks a read
    }
  };

  const ownPublished = async (employeeId, payslipRef) => {
    if (!Number.isInteger(employeeId) || employeeId <= 0) throw notFound();
    if (typeof payslipRef !== "string" || !REF_RE.test(payslipRef)) throw notFound();
    const row = await payslipRepo.getPublishedForEmployee(employeeId, payslipRef);
    if (!row || Number(row.employee_id) !== employeeId) throw notFound();
    return { row, snapshot: readFrozenSnapshot(row.snapshot_json, row.snapshot_sha256) };
  };

  /** "September 2026 - Published - View", newest month first. */
  const list = async (employeeId) => {
    const rows = await payslipRepo.listPublishedForEmployee(employeeId);
    return {
      code: 200,
      payslips: rows.map((r) => ({
        payslip_ref: r.payslip_ref,
        period_year: Number(r.period_year),
        period_month: Number(r.period_month),
        label: monthLabel(r.period_year, r.period_month),
        status: "Published",
        published_at: r.published_at,
      })),
    };
  };

  /** One payslip's detail. A successful open is recorded as a view. */
  const detail = async (employeeId, payslipRef) => {
    const { row, snapshot } = await ownPublished(employeeId, payslipRef);
    await payslipRepo.recordView(row.payslip_id, employeeId);
    audit("VIEW", { employee_id: employeeId, payslip_id: row.payslip_id });
    return {
      code: 200,
      payslip: {
        payslip_ref: row.payslip_ref,
        label: monthLabel(row.period_year, row.period_month),
        published_at: row.published_at,
        filename: payslipFilename(snapshot),
        snapshot: employeeView(snapshot),
      },
    };
  };

  /** The PDF bytes and a safe filename. Never stored. */
  const pdf = async (employeeId, payslipRef) => {
    const { row, snapshot } = await ownPublished(employeeId, payslipRef);
    const buffer = await renderPdf(snapshot);
    audit("PDF", { employee_id: employeeId, payslip_id: row.payslip_id });
    return { buffer, filename: payslipFilename(snapshot) };
  };

  /** A one-minute, single-use, single-payslip link for Telegram's own downloader. */
  const pdfLink = async (employeeId, payslipRef) => {
    const { snapshot } = await ownPublished(employeeId, payslipRef);
    prune();
    const token = crypto.randomBytes(32).toString("base64url");
    links.set(hash(token), { employee_id: employeeId, ref: payslipRef, expires_at: now() + linkTtlSeconds * 1000 });
    return {
      code: 200,
      path: `/telegram/payslips/pdf?t=${token}`,
      filename: payslipFilename(snapshot),
      expires_in: linkTtlSeconds,
    };
  };

  /** Spend a link token: once, before it expires, for its own employee and payslip. */
  const pdfByToken = async (token) => {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw linkInvalid();
    const key = hash(token);
    const grant = links.get(key);
    links.delete(key); // single use: gone on first presentation, whatever happens next
    if (!grant || grant.expires_at <= now()) throw linkInvalid();
    return pdf(grant.employee_id, grant.ref);
  };

  return { list, detail, pdf, pdfLink, pdfByToken };
};
module.exports.REF_RE = REF_RE;
module.exports.employeeView = employeeView;
