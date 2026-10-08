/**
 * HISTORICAL OT REVIEW.
 *
 * Calculated OT dated before the automatic-OT cutover never reached
 * approval (the automation may not raise OT before its cutover, and the
 * deploy backfill only reached each employee's previous five attendance
 * days). This is the CONTROLLED way to put it in front of approvers:
 *
 *   PREVIEW    read only. Every stored day in the window with calculated OT,
 *              classified by `utils/ot_historical_review.js` (existing
 *              request, paid, reviewed, incomplete, correction pending,
 *              payroll status) and then DRY-RUN through the real OT sync -
 *              the live engine's minutes, the approval chain, every gate -
 *              exactly as an authorised apply would run it. Writes nothing.
 *
 *   AUTHORISE  an administrator with `attendance_ot_historical_review`
 *              names the preview (its hash) and the dates. A preview that
 *              no longer matches the database is refused. The batch and its
 *              items are recorded, then each date is opened (a
 *              HISTORICAL_REVIEW deferred marker) and the ordinary OT sync
 *              runs for that date alone. It creates a PENDING OT request on
 *              the employee's normal approval chain - nothing more.
 *
 * WHAT IT NEVER DOES. Approve or pay anything; unlock, recalculate or write
 * a payroll row; touch a locked or published month (an approval there later
 * settles forward as Prior-Month OT through the existing late-settlement
 * path, priced from the locked calculation); raise a second request for a
 * date that has, or had, one; raise any date twice
 * (`attendance_ot_historical_review_raised`); move the automatic-OT cutover.
 */
const {
  HISTORICAL_REVIEW_FROM,
  ACTION,
  CREATE_ACTIONS,
  buildPreview,
  previewHash,
  summarize,
} = require("../utils/ot_historical_review");

const validationError = (message, code = "VALIDATION") => {
  const err = new Error(message);
  err.name = "ValidationError";
  err.code = code;
  return err;
};
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

module.exports = ({ reviewRepo, regularization }) => {
  /** The window: from 1 Sep 2026 to the day before the automatic-OT cutover. */
  const windowFor = async ({ from_date, to_date }) => {
    const setting = await reviewRepo.getAutoOtSetting();
    if (!setting || !setting.auto_pending_from_date) {
      throw validationError("Automatic OT is not installed: there is no cutover to review before");
    }
    const cutover = setting.auto_pending_from_date;
    const lastDay = addDays(cutover, -1);
    const from = from_date || HISTORICAL_REVIEW_FROM;
    const to = to_date || lastDay;
    if (!DATE_RE.test(from) || !DATE_RE.test(to)) throw validationError("from_date and to_date must be YYYY-MM-DD");
    if (from < HISTORICAL_REVIEW_FROM) throw validationError(`The review starts on ${HISTORICAL_REVIEW_FROM}`);
    if (to > lastDay) {
      throw validationError(`The review ends before the automatic-OT cutover (${cutover}); later dates are processed automatically`);
    }
    if (from > to) throw validationError("from_date must not be after to_date");
    return { from, to, cutover };
  };

  /**
   * DRY RUN every proposed creation through the real sync, per employee, as
   * if the review had opened its dates. A date the sync would not raise is
   * re-labelled with the sync's own reason; a raised one carries the live
   * minutes and its first approver.
   */
  const dryRun = async (lines, now) => {
    const byEmployee = new Map();
    lines.filter((l) => CREATE_ACTIONS.includes(l.proposed_action)).forEach((l) => {
      if (!byEmployee.has(l.employee_id)) byEmployee.set(l.employee_id, []);
      byEmployee.get(l.employee_id).push(l);
    });
    for (const [employeeId, mine] of byEmployee) {
      const dates = mine.map((l) => l.attendance_date);
      // eslint-disable-next-line no-await-in-loop
      const out = await regularization.syncAutoOt({
        employee_id: employeeId,
        dates,
        now,
        dry_run: true,
        notify: false,
        source: "HISTORICAL_REVIEW_PREVIEW",
        assume_review_dates: dates,
      });
      mine.forEach((line) => {
        const hit = (list) => (list || []).find((x) => x.attendance_date === line.attendance_date);
        const created = hit(out.created);
        if (created) {
          line.dry_run = {
            outcome: "WOULD_CREATE_PENDING",
            ot_minutes: created.ot_minutes,
            minutes_differ_from_stored: created.ot_minutes !== line.calculated_ot_minutes,
            first_approver_employee_id: created.first_approver_employee_id || null,
            chain_error: created.chain_error || null,
            settles_as_prior_month_ot: Boolean(created.source_payroll_locked),
          };
          if (created.chain_error) line.proposed_action = "SKIP_NO_APPROVAL_CHAIN";
          return;
        }
        const other =
          hit(out.skipped) || hit(out.unchanged) || hit(out.preserved_approved) || hit(out.preserved_rejected) || hit(out.errors);
        line.dry_run = { outcome: "WOULD_NOT_CREATE", reason: other ? other.reason || other.message || "UNCHANGED" : "NO_ELIGIBLE_OT" };
        line.proposed_action = `SKIP_${line.dry_run.reason}`.replace(/^SKIP_SKIP_/, "SKIP_");
      });
    }
    return lines;
  };

  const preview = async ({ from_date = null, to_date = null, employee_id = null, now = null } = {}) => {
    const { from, to, cutover } = await windowFor({ from_date, to_date });
    const schema =
      typeof reviewRepo.reviewSchema === "function"
        ? await reviewRepo.reviewSchema()
        : { installed: true, raised_table: true, present: [] };
    const rows = await reviewRepo.listCandidates({ from_date: from, to_date: to, employee_id, schema });
    const lines = await dryRun(buildPreview(rows, { cutover }), now);
    return {
      from_date: from,
      to_date: to,
      cutover,
      /*
       * WHETHER REVIEW HISTORY WAS CHECKED. Before migration 20261128120000
       * the review has never run, so no date can have been raised by one;
       * the preview says so rather than implying it looked.
       */
      review_installed: schema.installed,
      review_history: schema.raised_table ? "CHECKED" : "NONE_FEATURE_NOT_INSTALLED",
      preview_hash: previewHash(lines),
      summary: summarize(lines),
      lines,
    };
  };

  /**
   * AUTHORISE AND APPLY. `items` names the dates ({employee_id,
   * attendance_date}); omitted, every creatable line of the preview.
   */
  const authorise = async ({ actor, from_date = null, to_date = null, preview_hash, items = null, note = null, now = null }) => {
    if (!actor || !actor.employee_id) throw validationError("An authorising administrator is required");
    if (!preview_hash) throw validationError("preview_hash is required: authorise the preview you reviewed");
    const current = await preview({ from_date, to_date, now });
    // Nothing is created by a review that cannot record itself: without its
    // tables there is no audit and no never-twice guard.
    if (!current.review_installed) {
      throw validationError(
        "The Historical OT Review is not installed (migration 20261128120000 has not run). The preview works; authorising does not.",
        "REVIEW_NOT_INSTALLED"
      );
    }
    if (current.preview_hash !== preview_hash) {
      throw validationError(
        "The data changed since this preview was taken. Refresh the preview, review it again, and authorise the new one.",
        "PREVIEW_STALE"
      );
    }
    const creatable = current.lines.filter((l) => CREATE_ACTIONS.includes(l.proposed_action));
    const wanted = Array.isArray(items)
      ? new Set(items.map((i) => `${Number(i.employee_id)}|${String(i.attendance_date).slice(0, 10)}`))
      : null;
    const chosen = wanted ? creatable.filter((l) => wanted.has(`${l.employee_id}|${l.attendance_date}`)) : creatable;
    if (wanted && chosen.length !== wanted.size) {
      throw validationError("Some named dates are not creatable in the current preview; only CREATE lines may be authorised");
    }
    if (chosen.length === 0) throw validationError("Nothing to create in this preview");

    const batchId = await reviewRepo.createBatch({
      from_date: current.from_date,
      to_date: current.to_date,
      preview_hash,
      actor,
      items: chosen,
      note,
    });
    const items_ = await reviewRepo.listItems(batchId);
    const results = [];
    for (const item of items_) {
      const employeeId = Number(item.employee_id);
      const date = item.attendance_date;
      /* eslint-disable no-await-in-loop */
      try {
        if (await reviewRepo.wasRaised(employeeId, date)) {
          await reviewRepo.setItemOutcome({ review_item_id: item.review_item_id, outcome: "SKIPPED", detail: ACTION.SKIP_ALREADY_REVIEWED });
          results.push({ ...item, outcome: "SKIPPED", detail: ACTION.SKIP_ALREADY_REVIEWED });
          continue;
        }
        const marker = await reviewRepo.openMarker({
          employee_id: employeeId,
          attendance_date: date,
          minutes: item.calculated_ot_minutes,
          review_item_id: item.review_item_id,
        });
        const out = await regularization.syncAutoOt({
          employee_id: employeeId,
          dates: [date],
          now,
          notify: false,
          source: `HISTORICAL_REVIEW#${batchId}`,
          reason_note: `Historical OT review #${batchId} (item ${item.review_item_id}) for the ${date} work date`,
        });
        const created = (out.created || []).find((c) => c.attendance_date === date && c.attendance_approval_request_id);
        if (created) {
          const requestId = Number(created.attendance_approval_request_id);
          await reviewRepo.recordRaised({
            employee_id: employeeId,
            attendance_date: date,
            review_item_id: item.review_item_id,
            attendance_approval_request_id: requestId,
          });
          const detail = created.source_payroll_locked
            ? `Pending OT #${requestId}, ${created.ot_minutes} min; payroll locked: an approval settles as Prior-Month OT`
            : `Pending OT #${requestId}, ${created.ot_minutes} min`;
          await reviewRepo.setItemOutcome({ review_item_id: item.review_item_id, outcome: "CREATED", created_request_id: requestId, detail });
          results.push({ ...item, outcome: "CREATED", created_request_id: requestId, ot_minutes: created.ot_minutes, detail });
          continue;
        }
        const why =
          ((out.skipped || []).find((x) => x.attendance_date === date) || {}).reason ||
          ((out.errors || []).find((x) => x.attendance_date === date) || {}).message ||
          (((out.unchanged || []).find((x) => x.attendance_date === date) || {}).duplicate_prevented ? "DUPLICATE_PREVENTED" : null) ||
          "NOT_RAISED";
        await reviewRepo.closeMarker({ ...marker, employee_id: employeeId, attendance_date: date, detail: `Historical OT review #${batchId}: ${why}` });
        await reviewRepo.setItemOutcome({ review_item_id: item.review_item_id, outcome: "SKIPPED", detail: why });
        results.push({ ...item, outcome: "SKIPPED", detail: why });
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        await reviewRepo.setItemOutcome({ review_item_id: item.review_item_id, outcome: "FAILED", detail: message });
        results.push({ ...item, outcome: "FAILED", detail: message });
      }
      /* eslint-enable no-await-in-loop */
    }
    const count = (o) => results.filter((r) => r.outcome === o).length;
    const summary = {
      authorised: results.length,
      created: count("CREATED"),
      skipped: count("SKIPPED"),
      failed: count("FAILED"),
      created_minutes: results.filter((r) => r.outcome === "CREATED").reduce((n, r) => n + (Number(r.ot_minutes) || 0), 0),
    };
    await reviewRepo.finishBatch({ review_batch_id: batchId, status: summary.failed > 0 ? "FAILED" : "APPLIED", summary });
    return { review_batch_id: batchId, summary, results };
  };

  const listBatches = () => reviewRepo.listBatches();

  return { preview, authorise, listBatches, windowFor };
};
