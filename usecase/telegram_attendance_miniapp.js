/**
 * THE TELEGRAM ATTENDANCE MINI APP - the employee-facing read and write.
 *
 * =================================== IT OWNS NO ATTENDANCE RULE WHATSOEVER =
 *
 * Every question this file answers is answered by asking something that
 * already exists, and it is wired that way on purpose:
 *
 *   which dates are missing   `usecase/attendance_missing.js`
 *                             #findMissingAttendance - the SAME builder the
 *                             Missing Attendance report and the 06:00
 *                             Telegram job use. The odd-punch test, the
 *                             zero-punch exclusion, the eligibility test and
 *                             the "today is never reportable" clamp are all
 *                             `utils/attendance_missing.js`, applied there.
 *                             THERE IS NO ODD-PUNCH ARITHMETIC IN THIS FILE.
 *
 *   what a date looks like    `usecase/attendance_calculation.js#readRange`
 *                             - the same read `/attendance/me` serves, so
 *                             the shift, the cutoff and the effective
 *                             punches are what every other attendance screen
 *                             shows. `getMonth` is that same call over a
 *                             month, which is My Attendance in its entirety.
 *
 *   what was filed, and       `usecase/attendance_regularization.js
 *   what came of it           #listForEmployee` - the request rows
 *                             themselves, so PENDING / APPROVED / REJECTED
 *                             are the engine's own statuses and not a
 *                             second reading of the attendance day.
 *
 *   may this be submitted     `usecase/attendance_regularization.js`
 *                             #raiseRequest, called with no transformation.
 *                             The open-request refusal, the "a punch cannot
 *                             be added to a complete day" refusal, the shift
 *                             policy, the cutoff check, the monthly limit and
 *                             the approval chain are all its rules, reached
 *                             by exactly the path `POST
 *                             /attendance/me/regularization` reaches them by.
 *
 *   how far back              `attendanceRegularizationUsecase
 *                             .MAX_BACKDATE_DAYS` - READ from the usecase
 *                             that owns it. The number is not repeated here.
 *
 * ================================================ THE EMPLOYEE IS AN INPUT =
 *
 * Every function below takes `employee_id` as its first argument and the
 * router supplies it from the verified Mini App session ONLY. Nothing in
 * this file reads a request, a query string or a body, so there is no path
 * by which a browser could name a different employee.
 *
 * ========================================================= WHAT IS NOT SENT
 *
 * NO PUNCH COUNT. An employee is told which day needs a correction, not how
 * many times a machine saw them - the count stays where it belongs, in the
 * Missing Attendance report, the calculation and the notification ledger.
 *
 * NO `employee_id`. Not because it is a secret - the employee plainly knows
 * who they are, and the scoped session token carries a signed `emp` claim -
 * but because the frontend has no use for one, and a field a client does not
 * need is a field that invites a client to start sending it back. The
 * guarantee this feature rests on is that THE BROWSER NEVER CHOOSES,
 * SUPPLIES OR CONTROLS the employee id; keeping it out of the response
 * bodies is what makes that guarantee easy to keep rather than something to
 * re-check at every screen.
 */

const missing = require("../utils/attendance_missing");
const { addDays } = require("../utils/attendance_engine");
const { toDateOnly } = require("../utils/shiftResolution");
const { istToday } = require("../utils/istDate");

/**
 * What a Corrections card shows, and what may be done with it.
 *
 * EVERY ONE OF THESE IS SOMETHING THE EXISTING SYSTEM ALREADY DECIDED.
 * ACTIONABLE is the shared Missing Attendance rule; PENDING, APPROVED and
 * REJECTED are `attendance_approval_request.status` as the existing
 * regularisation repository reports it. Nothing here is a new attendance
 * state and nothing here re-derives one.
 */
const DATE_STATE = Object.freeze({
  /** Missing Attendance, nothing open: the employee may submit. */
  ACTIONABLE: "ACTIONABLE",
  /** A regularization is raised and undecided. Read-only. */
  PENDING: "PENDING",
  /** A regularization was approved: the punch is effective. */
  APPROVED: "APPROVED",
  /** A regularization was refused. The date may be actionable again. */
  REJECTED: "REJECTED",
  /** Not (or no longer) a missing-attendance date the employee may act on. */
  NOT_ACTIONABLE: "NOT_ACTIONABLE",
});

const STATE_LABEL = Object.freeze({
  [DATE_STATE.ACTIONABLE]: missing.MISSING_ATTENDANCE_STATUS,
  [DATE_STATE.PENDING]: "Regularisation Pending",
  [DATE_STATE.APPROVED]: "Regularised",
  [DATE_STATE.REJECTED]: "Regularisation Rejected",
  [DATE_STATE.NOT_ACTIONABLE]: "No Action Needed",
});

/** `attendance_approval_request.status` -> the card state. */
const REQUEST_STATE = Object.freeze({
  PENDING: DATE_STATE.PENDING,
  APPROVED: DATE_STATE.APPROVED,
  REJECTED: DATE_STATE.REJECTED,
});

/** The widest month the Mini App will read. `YYYY-MM`. */
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function validationError(message) {
  const err = new Error(message);
  err.name = "ValidationError";
  return err;
}

module.exports = ({
  attendanceMissingUsecase,
  attendanceCalculationUsecase,
  attendanceRegularizationUsecase,
  log = null,
}) => {
  const COMPONENT = "USECASE.TELEGRAM-ATTENDANCE-MINIAPP";
  const audit = (code, description, ref) => {
    if (log && typeof log.Log === "function") {
      log.Log({
        level: (log.LEVEL && log.LEVEL.INFO) || "info",
        component: COMPONENT,
        code: `${COMPONENT}.${code}`,
        description,
        category: "",
        ref,
      });
    }
  };

  /**
   * The backdate window, READ from the usecase that owns it rather than
   * restated. If the regularization window ever moves, this moves with it and
   * the Mini App cannot offer a date the backend would refuse.
   */
  const backdateDays = () => {
    const n = Number(attendanceRegularizationUsecase.MAX_BACKDATE_DAYS);
    return Number.isFinite(n) && n > 0 ? n : 45;
  };

  const businessToday = (today = null) => istToday(today) || istToday();

  /** The window the Mini App is allowed to talk about at all. */
  const window = (today = null) => {
    const on = businessToday(today);
    return { today: on, from: addDays(on, -backdateDays()), to: missing.latestReportableDate(on) };
  };

  /**
   * THE MISSING-DATE LIST for ONE employee - every actionable date, not just
   * the one the Telegram message was about.
   *
   * The row shape is the report's own (`shapeRow`), narrowed: the date, the
   * shift, the state, and the request id when there is one. `punch_count` and
   * `punch_times` are deliberately dropped here, at the boundary, so a punch
   * count cannot reach an employee's screen by somebody forgetting not to
   * render it.
   */
  const listMissingDates = async (employeeId, { today = null } = {}) => {
    const id = Number(employeeId);
    if (!Number.isInteger(id) || id <= 0) throw validationError("An employee identity is required");
    const w = window(today);
    if (!w.to || w.from > w.to) {
      return { code: 200, today: w.today, from_date: w.from, to_date: w.to, dates: [] };
    }

    const { meta, data } = await attendanceMissingUsecase.findMissingAttendance({
      from_date: w.from,
      to_date: w.to,
      today: w.today,
      // The employee is pinned here and comes from the session. `store_ids`
      // is null for the same reason the 06:00 job passes null: there is no
      // branch decision to make when somebody is reading their OWN dates.
      store_ids: null,
      department_id: null,
      employee_id: id,
      work_shift_id: null,
      search: null,
    });

    // BELT AND BRACES ON THE ONE THING THAT MUST NOT GO WRONG. The filter
    // above is applied in SQL; this refuses to hand over a row for anybody
    // else even if that query were ever changed.
    const missingRows = data.filter((row) => Number(row.employee_id) === id);

    // THE DECIDED REQUESTS, from the regularisation repository that owns
    // them. An APPROVED correction makes the day EVEN, so it leaves the
    // Missing Attendance population entirely - which is correct for the
    // report and wrong for a screen whose whole job is to show the employee
    // what happened to what they filed. So the two are merged rather than
    // either one being re-implemented.
    const requestByDate = await latestRequestsByDate(id, w.from, w.to);

    const byDate = new Map();
    missingRows.forEach((row) => {
      const request = requestByDate.get(row.attendance_date) || null;
      byDate.set(row.attendance_date, shapeDate(row, request));
    });

    // Dates the shared rule no longer reports (approved, or rejected on a day
    // that has since been settled) still belong on this screen.
    requestByDate.forEach((request, date) => {
      if (byDate.has(date)) return;
      const state = REQUEST_STATE[request.status] || DATE_STATE.NOT_ACTIONABLE;
      byDate.set(date, {
        attendance_date: date,
        shift_name: null,
        shift_code: null,
        work_shift_id: null,
        state,
        state_label: STATE_LABEL[state],
        can_submit: false,
        correction_request_id: request.attendance_approval_request_id || null,
      });
    });

    const dates = [...byDate.values()].sort((a, b) =>
      a.attendance_date < b.attendance_date ? -1 : a.attendance_date > b.attendance_date ? 1 : 0
    );

    // `employee_id` is NOT returned - see the header. The caller already
    // knows which employee it authenticated, and the browser must not be
    // handed a value it has no use for.
    return {
      code: 200,
      today: w.today,
      from_date: w.from,
      to_date: meta.effective_to_date || w.to,
      dates,
    };
  };

  /**
   * The latest REGULARIZATION request per date, from the usecase that owns
   * them. `listForEmployee` pins `requested_for_employee_id` in SQL, so this
   * cannot read anybody else's - and the id it is given comes from the
   * session.
   *
   * Optional: an older repository double without the reader simply yields no
   * request states, and the Missing Attendance half still works.
   */
  const latestRequestsByDate = async (employeeId, from, to) => {
    const byDate = new Map();
    if (typeof attendanceRegularizationUsecase.listForEmployee !== "function") return byDate;
    const rows = await attendanceRegularizationUsecase.listForEmployee({
      employee_id: employeeId,
      from_date: from,
      to_date: to,
      limit: 500,
    });
    // Ordered newest-first by the repository, so the FIRST row seen for a
    // date is the current one and later (older) rows do not overwrite it.
    (rows || []).forEach((row) => {
      if (row.request_type !== "REGULARIZATION") return;
      if (byDate.has(row.attendance_date)) return;
      byDate.set(row.attendance_date, row);
    });
    return byDate;
  };

  /**
   * One card. No punch count, no other employee's anything.
   *
   * A date the shared rule still reports as Missing Attendance is ACTIONABLE
   * unless a request is OPEN on it. A REJECTED request does not block it -
   * that is the existing engine's rule (`findOpenRequest`), not a new one
   * here, and the screen must not offer less than the backend allows.
   */
  const shapeDate = (row, request = null) => {
    const open = row.correction_request_pending || (request && request.status === "PENDING");
    let state = DATE_STATE.ACTIONABLE;
    if (open) state = DATE_STATE.PENDING;
    else if (request && request.status === "REJECTED") state = DATE_STATE.REJECTED;

    return {
      attendance_date: row.attendance_date,
      shift_name: row.shift_name || null,
      shift_code: row.shift_code || null,
      work_shift_id: row.work_shift_id === undefined ? null : row.work_shift_id,
      state,
      state_label: STATE_LABEL[state],
      // Still submittable after a rejection - see above.
      can_submit: state === DATE_STATE.ACTIONABLE || state === DATE_STATE.REJECTED,
      correction_request_id:
        row.correction_request_id || (request && request.attendance_approval_request_id) || null,
    };
  };

  /**
   * ==================== MY ATTENDANCE: ONE MONTH, READ-ONLY ===============
   *
   * `attendanceCalculationUsecase.readRange` - the SAME call `/attendance/me`
   * serves and the same one the web My Attendance screen uses. Stored history
   * for a closed date, the engine's answer otherwise; it stores nothing,
   * queues nothing and calculates nothing new here.
   *
   * THE DAYS ARE RETURNED AS THE ENGINE SHAPES THEM. Worked minutes, NRM,
   * short minutes, the shift snapshot, the effective punches, the OT claim
   * state and the attendance status are all its fields, rendered by the
   * frontend's existing attendance helpers. This function adds no field and
   * re-labels nothing: every state the screen shows - Final, Missing Punch,
   * Regularization Pending, Review Required, No Shift, Absent - is one the
   * engine already produced.
   *
   * THE WINDOW ENDS AT TODAY. A month in the future has nothing to read, and
   * the current month is clamped to today rather than returning a tail of
   * empty future days.
   */
  const getMonth = async (employeeId, month, { today = null } = {}) => {
    const id = Number(employeeId);
    if (!Number.isInteger(id) || id <= 0) throw validationError("An employee identity is required");
    if (typeof month !== "string" || !MONTH_RE.test(month)) {
      throw validationError("month must be YYYY-MM");
    }

    const on = businessToday(today);
    const from = `${month}-01`;
    const lastDay = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0))
      .getUTCDate();
    const monthEnd = `${month}-${String(lastDay).padStart(2, "0")}`;
    const to = monthEnd > on ? on : monthEnd;

    // Wholly in the future: there is nothing to read, and saying so is not
    // the same as showing an empty month.
    if (from > on) {
      return { code: 200, month, from_date: from, to_date: monthEnd, today: on, days: [] };
    }

    const days = await attendanceCalculationUsecase.readRange({
      employee_id: id,
      from_date: from,
      to_date: to,
    });

    return {
      code: 200,
      month,
      from_date: from,
      to_date: to,
      today: on,
      days: Array.isArray(days) ? days : [],
    };
  };

  /**
   * ONE DATE, for the detail screen.
   *
   * The punches come back as the engine's effective punches - the same list
   * `/attendance/me` returns - and are READ-ONLY by construction: there is no
   * endpoint on this namespace that takes a punch id, so the Mini App cannot
   * name an existing punch to edit or delete it.
   *
   * A date that is no longer actionable is NOT refused: it is returned with
   * its current state, which is what the approved behaviour asks for - the
   * employee sees why they cannot submit rather than a dead button.
   */
  const getDateDetail = async (employeeId, attendanceDate, { today = null } = {}) => {
    const id = Number(employeeId);
    if (!Number.isInteger(id) || id <= 0) throw validationError("An employee identity is required");
    const date = toDateOnly(attendanceDate);
    if (date === null) throw validationError("attendance_date must be a date as YYYY-MM-DD");

    const w = window(today);
    if (!w.to || date > w.to) {
      throw validationError(`${date} is not a completed attendance date`);
    }
    if (date < w.from) {
      throw validationError(
        `${date} is outside the ${backdateDays()}-day regularisation window`
      );
    }

    // The list is the authority on state, and it is the SHARED rule's answer
    // for this employee - so the detail screen and the list cannot disagree.
    const list = await listMissingDates(id, { today });
    const card = list.dates.find((d) => d.attendance_date === date) || null;

    const days = await attendanceCalculationUsecase.readRange({
      employee_id: id,
      from_date: date,
      to_date: date,
    });
    const day = Array.isArray(days) && days.length > 0 ? days[0] : null;

    return {
      code: 200,
      attendance_date: date,
      state: card ? card.state : DATE_STATE.NOT_ACTIONABLE,
      state_label: card ? card.state_label : STATE_LABEL[DATE_STATE.NOT_ACTIONABLE],
      can_submit: card ? card.can_submit : false,
      correction_request_id: card ? card.correction_request_id : null,
      // Everything the form needs and nothing else - built field by field
      // rather than spread, so a column the attendance read happens to
      // carry (`employee_id` among them) cannot arrive here by accident.
      // `shift_snapshot` carries
      // the attendance-day cutoff, which is what decides whether a clock time
      // belongs to this date or the next calendar day - the same value the
      // web form uses, so both build the punch timestamp identically.
      day: day
        ? {
            attendance_date: day.attendance_date,
            status: day.status || null,
            shift_name: day.shift_name || null,
            shift_snapshot: day.shift_snapshot || null,
            effective_punches: Array.isArray(day.effective_punches) ? day.effective_punches : [],
            regularization_request_id: day.regularization_request_id || null,
            regularization_request_pending: !!day.regularization_request_pending,
          }
        : null,
    };
  };

  /**
   * SUBMIT - and the whole of this function's job is to add nothing.
   *
   * The actor and the employee the request is for are the SAME authenticated
   * employee, both taken from the session argument. There is no parameter for
   * a second employee, so the existing "raising for somebody else needs
   * `raise_attendance_regularization_for_others`" rule cannot even be
   * approached from here.
   */
  const submitRegularization = async (
    employeeId,
    { attendance_date, punch_time, reason },
    { session_id = null, telegram_user_id = null } = {}
  ) => {
    const id = Number(employeeId);
    if (!Number.isInteger(id) || id <= 0) throw validationError("An employee identity is required");

    const result = await attendanceRegularizationUsecase.raiseRequest({
      actor: { employee_id: id },
      requested_for_employee_id: id,
      attendance_date,
      reason,
      punch_time,
    });

    const requestId = result.attendance_approval_request_id || result.request_id || null;

    // THE AUDIT TRAIL KEEPS EVERYTHING. `employee_id` belongs in the log,
    // where it answers "who filed this", and not in the response, where it
    // answers nothing the screen asked.
    audit("REGULARIZATION-SUBMITTED", "Telegram Mini App regularisation submitted", {
      employee_id: id,
      attendance_date: result.attendance_date,
      request_id: requestId,
      session_id,
      telegram_user_id,
    });

    // NARROWED, NOT SPREAD. `raiseRequest` returns the whole created request
    // - the chain, the proposed day, both employee ids - which is right for
    // an HR screen and far more than a Mini App confirmation needs. Only what
    // the confirmation shows is returned.
    return {
      code: 200,
      request_id: requestId,
      status: result.status || null,
      attendance_date: result.attendance_date,
      auto_approved: !!result.auto_approved,
    };
  };

  return {
    DATE_STATE,
    STATE_LABEL,
    MONTH_RE,
    backdateDays,
    window,
    listMissingDates,
    getDateDetail,
    getMonth,
    submitRegularization,
  };
};

module.exports.DATE_STATE = DATE_STATE;
module.exports.STATE_LABEL = STATE_LABEL;
module.exports.MONTH_RE = MONTH_RE;
