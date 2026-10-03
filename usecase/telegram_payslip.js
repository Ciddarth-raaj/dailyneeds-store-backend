const { readFrozenSnapshot, payslipFilename } = require("../utils/payslip_snapshot");
const { monthLabel, PDF_LINK_SCOPE, PDF_LINK_TTL_SECONDS } = require("../constants/payslip");

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
 * A Telegram client that downloads through `WebApp.downloadFile` fetches the
 * URL itself, without our session header, so `pdfLink` mints a token that
 * says "employee N may fetch payslip R" for two minutes. Its scope is not
 * the session's scope, so it opens nothing else, and the ownership check is
 * repeated when it is spent.
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
 * @param {object} deps.jwtService   services/jwt.js
 * @param {object} [deps.log]
 */
module.exports = ({ payslipRepo, renderPdf, jwtService, log = null }) => {
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

  /** A two-minute, single-payslip link for Telegram's own downloader. */
  const pdfLink = async (employeeId, payslipRef) => {
    const { snapshot } = await ownPublished(employeeId, payslipRef);
    const token = await jwtService.sign({ scope: PDF_LINK_SCOPE, emp: employeeId, ref: payslipRef }, PDF_LINK_TTL_SECONDS);
    return {
      code: 200,
      path: `/telegram/payslips/pdf?token=${encodeURIComponent(token)}`,
      filename: payslipFilename(snapshot),
      expires_in: PDF_LINK_TTL_SECONDS,
    };
  };

  /** Spend a link token: the scope, the employee and the ownership are all re-checked. */
  const pdfByToken = async (token) => {
    if (typeof token !== "string" || token === "") throw linkInvalid();
    let decoded;
    try {
      decoded = await jwtService.verify(token);
    } catch (err) {
      throw linkInvalid();
    }
    if (!decoded || decoded.scope !== PDF_LINK_SCOPE) throw linkInvalid();
    const employeeId = Number(decoded.emp);
    if (!Number.isInteger(employeeId) || employeeId <= 0) throw linkInvalid();
    return pdf(employeeId, decoded.ref);
  };

  return { list, detail, pdf, pdfLink, pdfByToken };
};
module.exports.REF_RE = REF_RE;
module.exports.employeeView = employeeView;
