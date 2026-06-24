const cron = require("node-cron");

const CRON_TZ_OFFSET_MS = 330 * 60 * 1000;
const BULK_CRON_WINDOW_MS = 10 * 60 * 1000;

function toIstParts(date) {
  const istMs = date.getTime() + CRON_TZ_OFFSET_MS;
  const d = new Date(istMs);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    date: d.getUTCDate(),
    dayOfWeek: d.getUTCDay(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

function istToUtcDate(year, month, date, hour, minute) {
  const istMs = Date.UTC(year, month - 1, date, hour, minute, 0, 0);
  return new Date(istMs - CRON_TZ_OFFSET_MS);
}

function startOfIstDay(date) {
  const parts = toIstParts(date);
  return istToUtcDate(parts.year, parts.month, parts.date, 0, 0);
}

function parseSimpleCronField(field) {
  if (!/^\d+$/.test(String(field || "").trim())) return null;
  const value = Number(field);
  return Number.isFinite(value) ? value : null;
}

function isWithinCronWindow(at, cronExpression, toleranceMs = BULK_CRON_WINDOW_MS) {
  const expr = cronExpression?.trim().split(/\s+/);
  if (!expr || expr.length < 2) return false;

  const hour = parseSimpleCronField(expr[1]);
  const minute = parseSimpleCronField(expr[0]);
  if (hour == null || minute == null) return false;

  const parts = toIstParts(at);
  const expectedRun = istToUtcDate(
    parts.year,
    parts.month,
    parts.date,
    hour,
    minute
  );
  return Math.abs(at.getTime() - expectedRun.getTime()) <= toleranceMs;
}

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

function inferSource(req, typeDef, cronExpression, postedAt = new Date()) {
  if (typeDef?.category === "bulk" || typeDef?.category === "sync") {
    if (cronExpression && isWithinCronWindow(postedAt, cronExpression)) {
      return "cron";
    }
    return typeDef?.category === "bulk" ? "manual" : inferSyncSource(req);
  }

  if (req.decoded?.employee_id) return "manual";
  const path = `${req.baseUrl || ""}${req.path || ""}`;
  if (path.includes("/gofrugal-synker/")) return "external";
  return "external";
}

function inferSyncSource(req) {
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

function getNextCronRunIst(cronExpression, fromDate = new Date()) {
  const expr = cronExpression.trim().split(/\s+/);
  if (expr.length < 5) return null;

  const hour = parseSimpleCronField(expr[1]);
  const minute = parseSimpleCronField(expr[0]);
  if (hour == null || minute == null) return null;

  let cursor = startOfIstDay(fromDate);
  const end = new Date(fromDate.getTime() + 14 * 24 * 60 * 60 * 1000);

  while (cursor <= end) {
    const parts = toIstParts(cursor);
    if (
      matchesCronField(expr[2], parts.date, 1, 31) &&
      matchesCronField(expr[3], parts.month, 1, 12) &&
      matchesCronField(expr[4], parts.dayOfWeek, 0, 6)
    ) {
      const runAt = istToUtcDate(
        parts.year,
        parts.month,
        parts.date,
        hour,
        minute
      );
      if (runAt > fromDate) return runAt;
    }
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }
  return null;
}

/**
 * Brute-force next cron run within 14 days (minute granularity, IST).
 */
function getNextCronRun(cronExpression, fromDate = new Date()) {
  if (!cronExpression || !cron.validate(cronExpression)) return null;

  const istNext = getNextCronRunIst(cronExpression, fromDate);
  if (istNext) return istNext;

  const start = new Date(fromDate.getTime());
  start.setSeconds(0, 0);

  for (let i = 1; i <= 14 * 24 * 60; i++) {
    const candidate = new Date(start.getTime() + i * 60000);
    const parts = toIstParts(candidate);
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

function getExpectedRunsIst(cronExpression, daysBack = 7) {
  const expr = cronExpression.trim().split(/\s+/);
  if (expr.length < 5) return [];

  const hour = parseSimpleCronField(expr[1]);
  const minute = parseSimpleCronField(expr[0]);
  if (hour == null || minute == null) return null;

  const runs = [];
  const now = new Date();
  let cursor = startOfIstDay(
    new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000)
  );
  const endDay = startOfIstDay(now);

  while (cursor <= endDay) {
    const parts = toIstParts(cursor);
    if (
      matchesCronField(expr[2], parts.date, 1, 31) &&
      matchesCronField(expr[3], parts.month, 1, 12) &&
      matchesCronField(expr[4], parts.dayOfWeek, 0, 6)
    ) {
      const runAt = istToUtcDate(
        parts.year,
        parts.month,
        parts.date,
        hour,
        minute
      );
      if (runAt <= now) runs.push(runAt);
    }
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }
  return runs;
}

function getExpectedRuns(cronExpression, daysBack = 7) {
  if (!cronExpression || !cron.validate(cronExpression)) return [];

  const istRuns = getExpectedRunsIst(cronExpression, daysBack);
  if (istRuns) return istRuns;

  const runs = [];
  const now = new Date();
  const start = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);
  start.setSeconds(0, 0);

  for (let i = 0; i <= daysBack * 24 * 60; i++) {
    const candidate = new Date(start.getTime() + i * 60000);
    const parts = toIstParts(candidate);
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

function findMatchingLog(logs, expectedAt, toleranceMs = BULK_CRON_WINDOW_MS) {
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
  isWithinCronWindow,
  isSuccess,
  formatSyncError,
  collectSyncWarnings,
  getNextCronRun,
  getExpectedRuns,
  findMatchingLog,
  BULK_CRON_WINDOW_MS,
};
