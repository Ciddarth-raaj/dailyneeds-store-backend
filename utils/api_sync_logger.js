const logger = require("./logger");
const { resolveLogType } = require("../constants/api_sync_types");
const {
  extractMetadata,
  extractRowCount,
  inferSource,
  isSuccess,
  formatSyncError,
  collectSyncWarnings,
} = require("./api_sync_log_helpers");

class ApiSyncLogger {
  constructor(repo) {
    this.repo = repo;
    this.cronConfigByType = null;
    this.cronConfigLoadedAt = 0;
  }

  async getCronExpression(logType) {
    if (!this.repo) return "";
    const ttlMs = 5 * 60 * 1000;
    if (
      !this.cronConfigByType ||
      Date.now() - this.cronConfigLoadedAt > ttlMs
    ) {
      const configs = await this.repo.getAllCronConfigs();
      this.cronConfigByType = configs.reduce((acc, config) => {
        acc[config.log_type] = config;
        return acc;
      }, {});
      this.cronConfigLoadedAt = Date.now();
    }
    return this.cronConfigByType[logType]?.cron_expression || "";
  }

  write(entry) {
    if (!this.repo) return Promise.resolve();
    return this.repo.create(entry).catch((err) => {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "API_SYNC_LOGGER",
        code: "API_SYNC_LOGGER.WRITE",
        description: err.toString(),
        category: "",
        ref: { log_type: entry.log_type },
      });
    });
  }

  middleware() {
    return (req, res, next) => {
      if (req.method !== "POST") return next();

      const fullPath = `${req.baseUrl || ""}${req.path || ""}`;
      const typeDef = resolveLogType(req.method, fullPath);
      if (!typeDef) return next();

      const startedAt = Date.now();
      let responsePayload = null;
      const originalJson = res.json.bind(res);
      res.json = (body) => {
        responsePayload = body;
        return originalJson(body);
      };

      res.on("finish", () => {
        const duration_ms = Date.now() - startedAt;
        const metadata = extractMetadata(typeDef.type, req, responsePayload);
        const row_count =
          metadata?.row_count ?? extractRowCount(req, responsePayload);
        const success = isSuccess(res.statusCode, responsePayload);
        const postedAt = new Date(startedAt);

        const writeEntry = async () => {
          const cronExpression = await this.getCronExpression(typeDef.type);
          await this.write({
            log_type: typeDef.type,
            method: req.method,
            path: fullPath,
            status: success ? "success" : "failed",
            status_code: res.statusCode,
            duration_ms,
            row_count,
            source: inferSource(req, typeDef, cronExpression, postedAt),
            employee_id: req.decoded?.employee_id ?? null,
            metadata_json: metadata,
            error_message: success
              ? null
              : formatSyncError({
                  message:
                    responsePayload?.msg ||
                    responsePayload?.message ||
                    "Request failed",
                  response: { status: res.statusCode, data: responsePayload },
                }).slice(0, 512),
          });
        };

        writeEntry().catch((err) => {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "API_SYNC_LOGGER",
            code: "API_SYNC_LOGGER.WRITE",
            description: err.toString(),
            category: "",
            ref: { log_type: typeDef.type },
          });
        });
      });

      next();
    };
  }

  wrapCron(logType, path, fn) {
    return async () => {
      const startedAt = Date.now();
      try {
        const result = await fn();
        const warnings = collectSyncWarnings(result);
        const row_count = extractRowCount({ body: {} }, result);
        const error_message = warnings.length
          ? warnings.join("; ").slice(0, 512)
          : null;

        await this.write({
          log_type: logType,
          method: "POST",
          path,
          status: error_message ? "failed" : "success",
          status_code: error_message ? 500 : 200,
          duration_ms: Date.now() - startedAt,
          row_count,
          source: "cron",
          employee_id: null,
          metadata_json: extractMetadata(logType, { body: {} }, result),
          error_message,
        });
        return result;
      } catch (err) {
        await this.write({
          log_type: logType,
          method: "POST",
          path,
          status: "failed",
          status_code: err?.response?.status || 500,
          duration_ms: Date.now() - startedAt,
          row_count: null,
          source: "cron",
          employee_id: null,
          metadata_json: null,
          error_message: formatSyncError(err).slice(0, 512),
        });
        throw err;
      }
    };
  }
}

module.exports = ApiSyncLogger;
