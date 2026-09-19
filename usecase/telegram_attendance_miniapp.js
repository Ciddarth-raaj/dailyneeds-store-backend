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
 *                             shows.
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
 * The list carries NO punch count. An employee is told which day needs a
 * correction, not how many times a machine saw them - the count stays where
 * it belongs, in the Missing Attendance report, the calculation and the
 * notification ledger.
 */

const missing = require("../utils/attendance_missing");
const { addDays } = require("../utils/attendance_engine");
const { toDateOnly } = require("../utils/shiftResolution");
const { istToday } = require("../utils/istDate");

/** What the Mini App shows on a card, and what it may do with it. */
const DATE_STATE = Object.freeze({
  /** Missing Attendance, nothing open: the employee may submit. */
  ACTIONABLE: "ACTIONABLE",
  /** A regularization is already raised and undecided. Read-only. */
  PENDING: "PENDING",
  /** Not (or no longer) a missing-attendance date the employee may act on. */
  NOT_ACTIONABLE: "NOT_ACTIONABLE",
});

const STATE_LABEL = Object.freeze({
  [DATE_STATE.ACTIONABLE]: missing.MISSING_ATTENDANCE_STATUS,
  [DATE_STATE.PENDING]: "Regularisation Pending",
  [DATE_STATE.NOT_ACTIONABLE]: "No Action Needed",
});

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
    if (!w.to || w.from > w.to) return { code: 200, employee_id: id, ...w, dates: [] };

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
    const dates = data
      .filter((row) => Number(row.employee_id) === id)
      .map((row) => shapeDate(row));

    return {
      code: 200,
      employee_id: id,
      today: w.today,
      from_date: w.from,
      to_date: meta.effective_to_date || w.to,
      dates,
    };
  };

  /** One card. No punch count, no other employee's anything. */
  const shapeDate = (row) => {
    const state = row.correction_request_pending ? DATE_STATE.PENDING : DATE_STATE.ACTIONABLE;
    return {
      attendance_date: row.attendance_date,
      shift_name: row.shift_name || null,
      shift_code: row.shift_code || null,
      work_shift_id: row.work_shift_id === undefined ? null : row.work_shift_id,
      state,
      state_label: STATE_LABEL[state],
      can_submit: state === DATE_STATE.ACTIONABLE,
      correction_request_id: row.correction_request_id || null,
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
      employee_id: id,
      attendance_date: date,
      state: card ? card.state : DATE_STATE.NOT_ACTIONABLE,
      state_label: card ? card.state_label : STATE_LABEL[DATE_STATE.NOT_ACTIONABLE],
      can_submit: card ? card.can_submit : false,
      correction_request_id: card ? card.correction_request_id : null,
      // Everything the form needs and nothing else. `shift_snapshot` carries
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

    audit("REGULARIZATION-SUBMITTED", "Telegram Mini App regularisation submitted", {
      employee_id: id,
      attendance_date: result.attendance_date,
      request_id: result.attendance_approval_request_id || result.request_id || null,
      session_id,
      telegram_user_id,
    });

    return { code: 200, ...result };
  };

  return {
    DATE_STATE,
    STATE_LABEL,
    backdateDays,
    window,
    listMissingDates,
    getDateDetail,
    submitRegularization,
  };
};

module.exports.DATE_STATE = DATE_STATE;
module.exports.STATE_LABEL = STATE_LABEL;
