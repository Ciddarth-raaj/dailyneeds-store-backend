const cron = require("node-cron");

function safeJsonParse(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

function extractRowCount(req, payload) {
  if (Array.isArray(req.body)) return req.body.length;
  if (Array.isArray(req.body?.table_items)) return req.body.table_items.length;
  if (Array.isArray(req.body?.items)) return req.body.items.length;
  if (Array.isArray(req.body?.data)) return req.body.data.length;

  const p = payload && typeof payload === "object" ? payload : {};
  const candidates = [
    p.row_count,
    p.rows_processed,
    p.rows_imported,
    p.productsProcessed,
    p.inserted,
    p.count,
    p.total,
    p.data?.row_count,
    p.data?.rows_imported,
    p.data?.inserted,
    p.data?.count,
    Array.isArray(p.data) ? p.data.length : null,
  ];
  for (const n of candidates) {
    const v = Number(n);
    if (Number.isFinite(v) && v >= 0) return v;
  }
  return null;
}

function extractMetadata(logType, req, payload) {
  const metadata = {};
  const rowCount = extractRowCount(req, payload);
  if (rowCount != null) metadata.row_count = rowCount;

  if (logType === "gofrugal_synker_sync" && req.body?.table_name) {
    metadata.table_name = req.body.table_name;
  }

  if (payload && typeof payload === "object") {
    if (payload.msg) metadata.message = String(payload.msg).slice(0, 200);
    if (Array.isArray(payload.warnings) && payload.warnings.length) {
      metadata.warnings = payload.warnings;
    }
    if (payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)) {
      const d = payload.data;
      ["inserted", "updated", "skipped", "groups_imported", "categories", "subcategories", "productsProcessed", "categoriesProcessed", "brandsProcessed", "departmentsProcessed"].forEach(
        (key) => {
          if (d[key] != null) metadata[key] = d[key];
        }
      );
    }
  }

  return Object.keys(metadata).length ? metadata : null;
}

function inferSource(req) {
  if (req.decoded?.employee_id) return "manual";
  const path = `${req.baseUrl || ""}${req.path || ""}`;
  if (path.includes("/gofrugal-synker/")) return "external";
  return "external";
}

function isSuccess(statusCode, payload) {
  if (statusCode < 200 || statusCode >= 400) return false;
  if (!payload || typeof payload !== "object") return true;
  const code = Number(payload.code);
  if (Number.isFinite(code) && code !== 200) return false;
  return true;
}

/**
 * Brute-force next cron run within 14 days (minute granularity).
 */
function getNextCronRun(cronExpression, fromDate = new Date()) {
  if (!cronExpression || !cron.validate(cronExpression)) return null;

  const start = new Date(fromDate.getTime());
  start.setSeconds(0, 0);

  for (let i = 1; i <= 14 * 24 * 60; i++) {
    const candidate = new Date(start.getTime() + i * 60000);
    const parts = {
      minute: candidate.getMinutes(),
      hour: candidate.getHours(),
      date: candidate.getDate(),
      month: candidate.getMonth() + 1,
      dayOfWeek: candidate.getDay(),
    };
    const expr = cronExpression.trim().split(/\s+/);
    if (expr.length < 5) continue;
    if (!matchesCronField(expr[0], parts.minute, 0, 59)) continue;
    if (!matchesCronField(expr[1], parts.hour, 0, 23)) continue;
    if (!matchesCronField(expr[2], parts.date, 1, 31)) continue;
    if (!matchesCronField(expr[3], parts.month, 1, 12)) continue;
    if (!matchesCronField(expr[4], parts.dayOfWeek, 0, 6)) continue;
    return candidate;
  }
  return null;
}

function matchesCronField(field, value, min, max) {
  if (field === "*") return true;
  return field.split(",").some((part) => {
    part = part.trim();
    if (part.includes("/")) {
      const [base, step] = part.split("/");
      const stepNum = Number(step);
      if (!Number.isFinite(stepNum) || stepNum <= 0) return false;
      if (base === "*") return value % stepNum === 0;
      const baseNum = Number(base);
      if (!Number.isFinite(baseNum)) return false;
      return value >= baseNum && (value - baseNum) % stepNum === 0;
    }
    if (part.includes("-")) {
      const [a, b] = part.split("-").map(Number);
      return value >= a && value <= b;
    }
    return Number(part) === value;
  });
}

function getExpectedRuns(cronExpression, daysBack = 7) {
  if (!cronExpression || !cron.validate(cronExpression)) return [];
  const runs = [];
  const now = new Date();
  const start = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);
  start.setSeconds(0, 0);

  for (let i = 0; i <= daysBack * 24 * 60; i++) {
    const candidate = new Date(start.getTime() + i * 60000);
    const parts = {
      minute: candidate.getMinutes(),
      hour: candidate.getHours(),
      date: candidate.getDate(),
      month: candidate.getMonth() + 1,
      dayOfWeek: candidate.getDay(),
    };
    const expr = cronExpression.trim().split(/\s+/);
    if (expr.length < 5) continue;
    if (!matchesCronField(expr[0], parts.minute, 0, 59)) continue;
    if (!matchesCronField(expr[1], parts.hour, 0, 23)) continue;
    if (!matchesCronField(expr[2], parts.date, 1, 31)) continue;
    if (!matchesCronField(expr[3], parts.month, 1, 12)) continue;
    if (!matchesCronField(expr[4], parts.dayOfWeek, 0, 6)) continue;
    if (candidate <= now) runs.push(candidate);
  }
  return runs;
}

function findMatchingLog(logs, expectedAt, toleranceMs = 20 * 60 * 1000) {
  if (!logs?.length) return null;
  const target = expectedAt.getTime();
  let best = null;
  let bestDiff = Infinity;
  for (const log of logs) {
    const t = new Date(log.created_at).getTime();
    const diff = Math.abs(t - target);
    if (diff <= toleranceMs && diff < bestDiff) {
      best = log;
      bestDiff = diff;
    }
  }
  return best;
}

function formatSyncError(err) {
  if (!err) return "Unknown error";
  const status = err?.response?.status;
  const dataMsg =
    err?.response?.data?.message ||
    err?.response?.data?.msg ||
    err?.response?.data?.error;
  const msg = dataMsg || err?.message || String(err);
  return status ? `HTTP ${status}: ${msg}` : msg;
}

function collectSyncWarnings(result) {
  if (!result || typeof result !== "object") return [];
  if (Array.isArray(result.warnings)) return result.warnings.filter(Boolean);
  return [];
}

module.exports = {
  safeJsonParse,
  extractRowCount,
  extractMetadata,
  inferSource,
  isSuccess,
  formatSyncError,
  collectSyncWarnings,
  getNextCronRun,
  getExpectedRuns,
  findMatchingLog,
};
