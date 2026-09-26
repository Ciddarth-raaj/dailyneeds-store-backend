/**
 * How the API process ends. Node 14 syntax only.
 *
 * BEFORE: one handler for SIGINT/SIGTERM/SIGQUIT/SIGUSR1/SIGUSR2, 'exit' and
 * 'uncaughtException' called `process.removeAllListeners()`, stopped the
 * crons, ended both pools and closed the HTTP server - and never exited. After
 * an uncaught exception the process therefore stayed alive with no listener,
 * no pools and no crons: pm2 reported it `online` while every request was
 * refused, and nothing restarted it (test_support/api_db_stress/zombie.js).
 *
 * NOW:
 *   fatal (uncaughtException)       log once -> stop crons, stop accepting
 *                                   HTTP, end pools -> exit(1) so pm2
 *                                   restarts it
 *   SIGTERM / SIGINT / SIGQUIT /     same cleanup -> exit(0): a deploy's
 *   SIGUSR1 / SIGUSR2               reload or a stop is not a crash
 *   'exit'                          log only (nothing async can run there)
 *
 * Bounded: whatever cleanup does, the process exits within `deadlineMs`
 * (default 1500 ms for a signal - under pm2's default kill_timeout of
 * 1600 ms - and 5000 ms for a fatal error).
 *
 * No tight restart loop: a fatal error in the first `minUptimeMs` (5 s) of the
 * process waits out the remainder before exiting, so a crash that recurs at
 * boot becomes a restart every ~5 s rather than a spin. A second fatal error
 * during shutdown is logged and does not start a second shutdown.
 *
 * NOT CHANGED: an unhandled promise REJECTION still only warns, as on Node 14
 * today - turning it into an exit could crash-loop on rejections that are
 * currently harmless. It is counted in the stats instead.
 */
const SIGNALS = ["SIGINT", "SIGTERM", "SIGQUIT", "SIGUSR1", "SIGUSR2"];

function installProcessLifecycle({ onClose, log, signalDeadlineMs = 1500, fatalDeadlineMs = 5000, minUptimeMs = 5000, exit = (code) => process.exit(code), proc = process } = {}) {
  let shuttingDown = null; // {reason, code, at}
  const counters = { unhandled_rejections: 0, errors_during_shutdown: 0 };

  function shutdown(reason, code, err) {
    if (shuttingDown) {
      counters.errors_during_shutdown += 1;
      if (log) log("SERVER.EXIT_DURING_SHUTDOWN", err && err.stack ? err.stack : String(err || reason), { reason, first_reason: shuttingDown.reason });
      return;
    }
    shuttingDown = { reason, code, at: Date.now() };
    if (log) log("SERVER.EXIT", err && err.stack ? err.stack : String(err || reason), { reason, exit_code: code });

    const deadline = code === 0 ? signalDeadlineMs : fatalDeadlineMs;
    const uptimeMs = Math.round(proc.uptime() * 1000);
    const floor = code === 0 ? 0 : Math.max(0, minUptimeMs - uptimeMs);
    let exited = false;
    const finish = () => {
      if (exited) return;
      exited = true;
      exit(code);
    };
    // Hard deadline: exit whatever cleanup is doing. Deliberately NOT unref'd.
    setTimeout(finish, Math.max(deadline, floor));
    Promise.resolve()
      .then(() => onClose && onClose())
      .catch((closeErr) => {
        if (log) log("SERVER.EXIT_CLEANUP_FAILED", closeErr && closeErr.stack ? closeErr.stack : String(closeErr), { reason });
      })
      .then(() => {
        const waited = Date.now() - shuttingDown.at;
        if (waited >= floor) finish();
        else setTimeout(finish, floor - waited);
      });
  }

  for (const sig of SIGNALS) proc.on(sig, () => shutdown(sig, 0));
  proc.on("uncaughtException", (err) => shutdown("uncaughtException", 1, err));
  proc.on("unhandledRejection", () => {
    counters.unhandled_rejections += 1;
  });
  proc.on("exit", (code) => {
    if (!shuttingDown && log) log("SERVER.EXIT", `process exiting with code ${code}`, { reason: "exit", exit_code: code });
  });

  return { shutdown, stats: () => ({ ...counters, shutting_down: shuttingDown ? shuttingDown.reason : null }) };
}

module.exports = { installProcessLifecycle, SIGNALS };
