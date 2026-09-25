const logger = require("./logger");
const readTiming = require("./attendance_read_timing");

/**
 * BULK RECALCULATION TIMING - one concise log line per employee a bulk run
 * (the Recalculate Attendance screen, the daily run, a Work Shift save's
 * queued propagation) recalculates, and one per run.
 *
 * It MEASURES and changes nothing. The employee's recalculation runs inside
 * a timing context (the same AsyncLocalStorage context the month read uses),
 * so the calculation repository's reads report their pool wait and execution
 * time, and the write transaction reports its connection wait and its
 * statements, without a parameter being threaded through any signature.
 *
 *   queued_at     when the employee's work was queued: the run's queue time
 *                 for a propagation, the run's start for a manual run
 *   claimed_at    when the run was claimed from the queue (a propagation)
 *                 or started (a manual run)
 *   started_at    when THIS employee's recalculation began
 *   data_load_ms  employment lookup + punch re-derive + the context reads
 *                 + the payroll-lock pre-flight
 *   calculation_ms  the engine over every date (no database access)
 *   write_ms      the transaction: payroll-lock gate, upsert, reconcile
 *   total_ms      started_at to finished, this employee only
 *   pool_wait_ms  summed wait for a pooled connection, reads and write
 *   query_count   calculation-repository reads + write statements
 *
 * The punch re-derive of a BULK run happens once for the batch, before the
 * employees, and is logged on the run line rather than attributed to any one
 * employee.
 */
const COMPONENT = "ATTENDANCE.RECALC_TIMING";

const round = (ms) => Math.round(ms);

// Quiet under the test runner unless a test asks for the lines.
const enabled = () => process.env.IS_TEST !== "true" || process.env.ATTENDANCE_RECALC_TIMING_LOG === "1";

const isoNow = () => new Date().toISOString();

/** Sum of the named phases present in a context. */
const sumPhases = (phases, names) => names.reduce((sum, name) => sum + (phases.get(name) || 0), 0);

function employeeSummary(ctx) {
  const waits = ctx.queries.map((q) => q.wait_ms).filter((ms) => typeof ms === "number");
  const reads = ctx.queries.filter((q) => q.code !== "TX-CONNECTION").length;
  return {
    data_load_ms: round(
      sumPhases(ctx.phases, ["employment_lookup", "punch_redrive", "db_reads_wall", "payroll_lock_preflight"])
    ),
    calculation_ms: round(sumPhases(ctx.phases, ["live_calculation", "date_generation"])),
    write_ms: round(sumPhases(ctx.phases, ["write"])),
    total_ms: round(readTiming.nowMs() - ctx.t0),
    pool_wait_ms: round(waits.reduce((a, b) => a + b, 0)),
    query_count: reads + (ctx.statements || 0),
  };
}

/**
 * Run one employee's recalculation inside a timing context and log its line.
 * The recalculation's result or error passes through untouched.
 */
async function timeEmployee(meta, fn) {
  const ctx = readTiming.create(`recalc:${meta.employee_id}`);
  const startedAt = isoNow();
  let outcome = "ok";
  let result = null;
  try {
    result = await readTiming.run(ctx, fn);
    return result;
  } catch (err) {
    outcome = (err && err.code) || "error";
    throw err;
  } finally {
    // NO `return` in here: it would replace the recalculation's own result
    // or error. The log is simply skipped when disabled.
    if (enabled()) logEmployee(meta, ctx, startedAt, outcome, result);
  }
}

function logEmployee(meta, ctx, startedAt, outcome, result) {
  try {
    const s = employeeSummary(ctx);
    const days = result && Number.isFinite(Number(result.written)) ? Number(result.written) : 0;
    logger.Log({
      level: logger.LEVEL.INFO,
      component: COMPONENT,
      code: `${COMPONENT}.EMPLOYEE`,
      description:
        `run=${meta.run_id || "-"} src=${meta.source} emp=${meta.employee_id} ` +
        `${meta.from}..${meta.to} ${outcome} days=${days} total=${s.total_ms}ms ` +
        `load=${s.data_load_ms} calc=${s.calculation_ms} write=${s.write_ms} ` +
        `pool_wait=${s.pool_wait_ms} queries=${s.query_count}`,
      category: "",
      ref: {
        run_id: meta.run_id || null,
        source: meta.source,
        employee_id: meta.employee_id,
        from_date: meta.from,
        to_date: meta.to,
        queued_at: meta.queued_at || null,
        claimed_at: meta.claimed_at || null,
        started_at: startedAt,
        outcome,
        days_written: days,
        ...s,
      },
    });
  } catch (logErr) {
    // Measurement must never cost the recalculation.
  }
}

/** The run's own line: how long, how wide, and the batch-level work. */
function logRun(meta) {
  if (!enabled()) return;
  try {
    logger.Log({
      level: logger.LEVEL.INFO,
      component: COMPONENT,
      code: `${COMPONENT}.RUN`,
      description:
        `run=${meta.run_id || "-"} src=${meta.source} ${meta.status} employees=${meta.employees} ` +
        `items=${meta.items} concurrency=${meta.concurrency} total=${round(meta.total_ms)}ms ` +
        `redrive=${round(meta.redrive_ms)}ms`,
      category: "",
      ref: { ...meta, total_ms: round(meta.total_ms), redrive_ms: round(meta.redrive_ms) },
    });
  } catch (err) {
    // Measurement must never cost the run.
  }
}

module.exports = { timeEmployee, logRun, employeeSummary, isoNow };
