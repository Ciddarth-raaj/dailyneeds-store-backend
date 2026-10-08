#!/usr/bin/env node
/**
 * HISTORICAL OT REVIEW - THE READ-ONLY IMPACT REPORT AND DRY-RUN PREVIEW.
 *
 *   NODE_ENV=production node scripts/attendance/ot-historical-review-preview.js \
 *     [--from 2026-09-01] [--to 2026-10-06] [--employee 945] [--json]
 *
 * Exactly the preview the Historical OT Review screen shows - the same
 * usecase - over a database handle that CANNOT WRITE
 * (`scripts/diagnostics/lib/read_only_db.js`: a READ ONLY session and a
 * SELECT-only statement filter). Every stored day in the window with
 * calculated OT, its existing request, settlement, marker and payroll status,
 * the proposed action, and the real OT sync's dry run (the live engine's
 * minutes and approval chain). Prints the company-wide totals, then one line
 * per date; --json prints the whole preview, including its preview_hash.
 *
 * It creates, approves and pays nothing. Applying is a separate, authorised
 * action on the screen (POST /attendance/ot/historical-review/authorise).
 */
const { openReadOnly, arg } = require("../diagnostics/lib/read_only_db");

(async () => {
  const { db, end } = openReadOnly();
  try {
    const calcRepo = require("../../repository/attendance_calculation")(db);
    const regRepo = require("../../repository/attendance_regularization")(db);
    const approverSetupRepo = require("../../repository/attendance_approver_setup")(db);
    const calculation = require("../../usecase/attendance_calculation")(calcRepo);
    const regularization = require("../../usecase/attendance_regularization")(regRepo, calculation, approverSetupRepo);
    const review = require("../../usecase/attendance_ot_historical_review")({
      reviewRepo: require("../../repository/attendance_ot_historical_review")(db),
      regularization,
    });
    const out = await review.preview({
      from_date: arg("from"),
      to_date: arg("to"),
      employee_id: arg("employee") ? Number(arg("employee")) : null,
    });
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify(out, null, 2));
      return;
    }
    console.log(`Historical OT Review preview ${out.from_date}..${out.to_date} (automatic-OT cutover ${out.cutover})`);
    console.log(`preview_hash ${out.preview_hash}\n`);
    console.log(JSON.stringify(out.summary, null, 2));
    console.log("\nemployee_id\temployee\tdate\tcalc_min\tdry_run_min\texisting\tpayroll\tproposed_action");
    out.lines.forEach((l) =>
      console.log(
        [
          l.employee_id,
          l.employee_name,
          l.attendance_date,
          l.calculated_ot_minutes,
          l.dry_run && l.dry_run.ot_minutes !== undefined ? l.dry_run.ot_minutes : "",
          l.existing_status ? `${l.existing_status} #${l.existing_request_id}` : l.withdrawn_request_id ? `withdrawn #${l.withdrawn_request_id}` : "none",
          l.payroll_status,
          l.proposed_action,
        ].join("\t")
      )
    );
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await end();
  }
})();
