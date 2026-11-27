// Stock Audit Stage 4 - one manual sync run ON THE SERVER, from the backend
// directory, with the application's own code (built exactly as server.js
// builds it). READ-ONLY towards RetailPilot. Usage: node stage4_sync.js DRY_RUN|HISTORICAL
global.env = process.env.NODE_ENV === undefined ? "development" : process.env.NODE_ENV;
const cwd = process.cwd();
const R = (p) => require(cwd + p);
(async () => {
  const kind = process.argv[2];
  if (!["DRY_RUN", "HISTORICAL"].includes(kind)) throw new Error("kind must be DRY_RUN or HISTORICAL");
  const db = await R("/drivers/mysql")().connect();
  try {
    const repo = R("/repository/stock_audit")(db.connection);
    const running = await new Promise((res) => db.connection.query("SELECT COUNT(*) AS n FROM sa_sync_run WHERE status = 'RUNNING'", (e, r) => res(e ? -1 : Number(r[0].n))));
    if (running !== 0) { console.log("@@STOP a sync run is already RUNNING (" + running + ")"); process.exitCode = 1; return; }
    const F = R("/services/retailpilot_spectra");
    const sync = R("/usecase/stock_audit_sync")(F({ ...R("/config/retailpilot"), retry: F.DEFAULT_RETRY }), repo);
    const t0 = Date.now();
    const r = await sync.run({ kind, trigger: "manual", startedBy: null });
    console.log("@@SYNC " + JSON.stringify({ ...r, seconds: Math.round((Date.now() - t0) / 1000) }));
    if (r.code !== 200) process.exitCode = 1;
  } finally {
    db.close();
  }
})().catch((e) => { console.log("@@STOP " + String(e.message).slice(0, 200)); process.exitCode = 1; });
