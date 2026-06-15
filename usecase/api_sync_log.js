const moment = require("moment");
const { API_SYNC_TYPES, TYPE_BY_LOG_TYPE } = require("../constants/api_sync_types");
const {
  getNextCronRun,
  getExpectedRuns,
  findMatchingLog,
} = require("../utils/api_sync_log_helpers");

class ApiSyncLogUsecase {
  constructor(repo) {
    this.repo = repo;
  }

  async getLogs(filters = {}) {
    const rows = await this.repo.getLogs(filters);
    return { code: 200, data: rows };
  }

  async getCronConfigs() {
    const rows = await this.repo.getAllCronConfigs();
    return { code: 200, data: rows };
  }

  async updateCronConfig(payload) {
    const { log_type, label, cron_expression, is_enabled } = payload;
    if (!log_type) {
      return { code: 400, msg: "log_type is required" };
    }
    const typeDef = TYPE_BY_LOG_TYPE[log_type];
    if (!typeDef) {
      return { code: 400, msg: "Unknown log type" };
    }
    await this.repo.upsertCronConfig({
      log_type,
      label: label || typeDef.label,
      category: typeDef.category,
      cron_expression: cron_expression ?? "",
      is_enabled: is_enabled !== false,
    });
    return { code: 200, msg: "Cron config updated" };
  }

  buildTimelineItem(config, typeLogs, days) {
    const lastLog = typeLogs[0] || null;
    const typeDef = TYPE_BY_LOG_TYPE[config.log_type];
    const hasCron = config.is_enabled && config.cron_expression;
    const nextSyncAt = hasCron ? getNextCronRun(config.cron_expression) : null;

    const expectedRuns = hasCron
      ? getExpectedRuns(config.cron_expression, days)
      : [];

    const slots = expectedRuns.map((expectedAt) => {
      const matched = findMatchingLog(typeLogs, expectedAt);
      return {
        expected_at: expectedAt.toISOString(),
        status: matched
          ? matched.status
          : expectedAt < new Date()
          ? "missed"
          : "pending",
        error_message: matched?.error_message || null,
        log: matched,
      };
    });

    const recentEvents = typeLogs.slice(0, 20).map((log) => ({
      log_id: log.log_id,
      status: log.status,
      source: log.source,
      row_count: log.row_count,
      duration_ms: log.duration_ms,
      error_message: log.error_message,
      metadata_json: log.metadata_json,
      created_at: log.created_at,
    }));

    return {
      log_type: config.log_type,
      label: config.label,
      category: config.category,
      path: typeDef?.match || null,
      server_script: typeDef?.server_script || null,
      cron_expression: config.cron_expression,
      is_enabled: !!config.is_enabled,
      last_run: lastLog
        ? {
            status: lastLog.status,
            source: lastLog.source,
            row_count: lastLog.row_count,
            duration_ms: lastLog.duration_ms,
            created_at: lastLog.created_at,
            error_message: lastLog.error_message,
          }
        : null,
      next_sync_at: nextSyncAt ? nextSyncAt.toISOString() : null,
      slots,
      recent_events: recentEvents,
    };
  }

  async getTimeline({ days = 7 } = {}) {
    const configs = await this.repo.getAllCronConfigs();
    const since = moment().subtract(days, "days").format("YYYY-MM-DD 00:00:00");
    const logTypes = configs.map((c) => c.log_type);
    const logs = await this.repo.getRecentByTypes(logTypes, since);

    const byType = {};
    logs.forEach((log) => {
      if (!byType[log.log_type]) byType[log.log_type] = [];
      byType[log.log_type].push(log);
    });

    const sync = [];
    const bulk = [];

    configs.forEach((config) => {
      const typeLogs = byType[config.log_type] || [];
      const item = this.buildTimelineItem(config, typeLogs, days);
      if (config.category === "bulk") bulk.push(item);
      else sync.push(item);
    });

    return { code: 200, data: { sync, bulk } };
  }
}

module.exports = (repo) => new ApiSyncLogUsecase(repo);
