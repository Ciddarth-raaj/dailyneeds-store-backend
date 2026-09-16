/**
 * EMPLOYEE MASTER BULK EXPORT / IMPORT — the field catalogue, the labels HR
 * sees in Excel, and the one place a cell is turned into a value.
 *
 * PURE FUNCTIONS ONLY. No database, no Express, no business rule about what an
 * edit is allowed to do — every one of those stays where it already lives
 * (`usecase/employee_master.js` for the edit and the joining-date correction,
 * `middlewares/employee_branch_scope.js` for which employees are reachable,
 * `utils/employment_classification.js` for the two classification lists). This
 * module's whole job is the SPREADSHEET: which columns exist, what they are
 * called, and how to read a cell somebody typed into one.
 *
 * ======================================= WHY THE FIELD LIST IS CLOSED =====
 *
 * The six updatable fields below are the ones the approved scope names, and a
 * seventh cannot be smuggled in by a crafted file: the importer only ever
 * looks at the header labels declared here, builds its patch from THESE keys,
 * and hands that patch to `editEmployee`, which refuses anything outside
 * `EDITABLE_FIELDS` by name. A column headed `salary` or `status` in an
 * uploaded sheet is not "ignored quietly" — `unknownColumns` reports it and
 * the upload is refused, because a column somebody filled in and the system
 * silently dropped is worse than one that was never offered.
 *
 * SHIFT IS DELIBERATELY ABSENT. Employee Shift Assignment owns
 * `default_work_shift_id` and writes a dated history row with it; a generic
 * bulk column that set the live column without that row would produce an
 * employee who reads as assigned on one screen and NO_SHIFT_FOR_DATE on
 * every other. It is not in this version.
 *
 * ================================ EMPLOYEE NAME IS NEVER AN UPDATE ========
 *
 * `Employee Name` is exported because a spreadsheet of bare id numbers is
 * unreadable and unreviewable. It is NOT an identity and NOT an update: the
 * employee is found by `Employee ID` alone, and a name in the file that
 * disagrees with the master raises a WARNING on the preview rather than
 * changing anything or selecting a different person. Both of those would be
 * the same class of mistake — letting a display column decide a record.
 */

const {
  EMPLOYMENT_TYPES,
  GRADES,
} = require("./employment_classification");

/** The two columns every export carries, whatever the user selected. */
const IDENTITY_FIELDS = Object.freeze([
  Object.freeze({ key: "employee_id", label: "Employee ID", role: "identity" }),
  Object.freeze({ key: "employee_name", label: "Employee Name", role: "reference" }),
]);

/**
 * The updatable fields, keyed by the name the API and the UI use.
 *
 * `column` is the `new_employee` column the value ends up in, and it is here
 * so the preview can read the CURRENT value to compare against. It is never
 * interpolated into SQL from a request: the importer only ever reaches these
 * frozen entries by key, and the write itself goes through `editEmployee` /
 * `correctJoiningDate`, which name their own columns.
 *
 * `master` names the lookup a human-readable cell is resolved against. A field
 * with no `master` is either a fixed list (`choices`) or a date.
 */
const UPDATE_FIELDS = Object.freeze([
  Object.freeze({
    key: "store_id",
    label: "Location",
    column: "store_id",
    kind: "master",
    master: "outlet",
  }),
  Object.freeze({
    key: "department_id",
    label: "Department",
    column: "department_id",
    kind: "master",
    master: "department",
  }),
  Object.freeze({
    key: "designation_id",
    label: "Designation",
    column: "designation_id",
    kind: "master",
    master: "designation",
  }),
  Object.freeze({
    key: "employment_type",
    label: "Employment Type",
    column: "employment_type",
    kind: "choice",
    choices: EMPLOYMENT_TYPES,
  }),
  Object.freeze({
    key: "grade",
    label: "Grade",
    column: "grade",
    kind: "choice",
    choices: GRADES,
  }),
  Object.freeze({
    key: "date_of_joining",
    label: "Date of Joining",
    column: "date_of_joining",
    kind: "date",
    /**
     * THE ONE FIELD THAT IS NOT AN ORDINARY EDIT. It describes the current
     * EMPLOYMENT PERIOD as well as the master row, so it is applied through
     * `correctJoiningDate`, which moves the period with it and records a
     * `period_corrected` lifecycle event. `editEmployee` refuses it by name
     * (`LIFECYCLE_CONTROLLED_FIELDS`), which is what guarantees a bulk DOJ
     * cannot become a plain column write even by mistake.
     */
    lifecycle: true,
  }),
]);

const UPDATE_FIELD_KEYS = Object.freeze(UPDATE_FIELDS.map((f) => f.key));

const byKey = new Map(UPDATE_FIELDS.map((f) => [f.key, f]));
/** Header label -> field, case-insensitively and ignoring surrounding space. */
const byLabel = new Map(
  [...IDENTITY_FIELDS, ...UPDATE_FIELDS].map((f) => [f.label.trim().toLowerCase(), f])
);

const getUpdateField = (key) => byKey.get(key) || null;
const fieldForLabel = (label) => byLabel.get(String(label ?? "").trim().toLowerCase()) || null;

/**
 * The selected fields, in the CANONICAL order, refusing anything unknown.
 *
 * The order is the catalogue's and not the caller's, so two exports of the
 * same field set are the same spreadsheet whatever order the checkboxes were
 * ticked in — which is what makes a re-upload of an older file predictable.
 */
function resolveSelectedFields(keys) {
  const asked = Array.isArray(keys) ? keys.map((k) => String(k ?? "").trim()) : [];
  const unknown = asked.filter((k) => !byKey.has(k));
  if (unknown.length > 0) {
    return { ok: false, unknown };
  }
  const chosen = new Set(asked);
  return { ok: true, fields: UPDATE_FIELDS.filter((f) => chosen.has(f.key)) };
}

/* ====================================================== master labelling == */

/**
 * WHAT A LOCATION / DEPARTMENT / DESIGNATION LOOKS LIKE IN THE SPREADSHEET.
 *
 * `Name [ID]` — `Muthialpet [3]`, `Accounts [7]`, `Cashier [12]`.
 *
 * ================================ WHY THE ID AND NOT THE MASTER'S OWN CODE ==
 *
 * All three masters DO carry a UNIQUE code column - `outlets.outlet_code`,
 * `department.department_code`, `designation.designation_code`, all added by
 * `20251117080329-employee-import` - so an earlier version of this file used
 * the code as the disambiguator. That was wrong, for a reason the schema
 * alone does not show:
 *
 *   `outlet_code` is NOT NULL and seeded (DNHO, DN1..DN5), and plenty of
 *   production code reads it. The other two are `NULL DEFAULT NULL` and were
 *   only ever written by the DIGISME SYNC, which upserted on them. That sync
 *   has been removed (docs/digisme-employee-sync-removal.md), and the normal
 *   CRUD paths - `repository/department.js` and `repository/designation.js` -
 *   do not write a code at all. So every department and designation created
 *   from here on has a NULL code, and MySQL permits any number of NULLs in a
 *   UNIQUE column.
 *
 * The consequence was not theoretical. Two departments sharing a name, both
 * with a NULL code, exported as the SAME bare label; re-uploading that
 * untouched file then failed with "matches more than one record", so a
 * round-trip of an unedited export was refused. Safe, but broken.
 *
 * `id` has none of that: it is the PRIMARY KEY of all three masters, so it
 * always exists, is always unique, and is never NULL, whoever created the
 * row and whichever screen they used. It depends on nothing that a removed
 * integration used to populate.
 *
 * ============================================= THE ID IS NOT TRUSTED ALONE ==
 *
 * The bracketed id is a POINTER, and the name beside it is what proves the
 * pointer still means what the spreadsheet's author thought. `resolve` looks
 * the id up and then checks the name against the current master; if the
 * master has been renamed, or somebody edited the label by hand and left the
 * id, that is a `NAME_MISMATCH` refusal rather than a silent assignment to
 * whatever that id happens to be today. An id in a file written weeks ago is
 * exactly the kind of thing that quietly stops meaning what it meant.
 *
 * A BARE NAME IS STILL ACCEPTED, but only where it is unambiguous - somebody
 * typing `Cashier` into a blank cell has said something exact if there is
 * only one Cashier. Two rows sharing a name is an `AMBIGUOUS` refusal, never
 * a guess: picking one would move an employee to a branch nobody chose.
 *
 * `options` is the whole master, INCLUDING INACTIVE ROWS: an employee already
 * sitting on a since-deactivated branch must still export with a readable
 * label rather than a blank cell that a round-trip would then read as "leave
 * unchanged". Whether a row may be assigned TO is a separate question,
 * answered from `active` by the usecase.
 */
function buildMasterIndex(options = []) {
  const rows = (options || []).map((o) => ({
    id: Number(o.id),
    name: String(o.name ?? "").trim(),
    active: o.active === true || Number(o.active) === 1,
  }));

  /** `Name [ID]`, the one spelling this feature ever writes. */
  const labelFor = (row) => (row ? `${row.name} [${row.id}]` : "");

  const byId = new Map(rows.map((r) => [r.id, r]));

  /** Bare name -> the rows answering to it, for the unambiguous-name case. */
  const byName = new Map();
  for (const row of rows) {
    const k = row.name.toLowerCase();
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(row);
  }

  const sameName = (a, b) =>
    String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();

  return {
    rows,
    labelForId: (id) => labelFor(byId.get(Number(id))),
    getById: (id) => byId.get(Number(id)) || null,
    /** The labels a dropdown offers: ACTIVE rows only, sorted for reading. */
    activeLabels: () =>
      rows
        .filter((r) => r.active)
        .map(labelFor)
        .sort((a, b) => a.localeCompare(b)),
    /**
     * A typed cell -> exactly one row, or a refusal that says which.
     *
     * `BLANK`, `OK`, and three distinct refusals - `UNKNOWN`, `AMBIGUOUS` and
     * `NAME_MISMATCH` - because they need three different sentences from the
     * person fixing the file.
     */
    resolve: (text) => {
      const raw = String(text ?? "").trim();
      if (raw === "") return { status: "BLANK" };

      // The `Name [ID]` form this feature exports. The id is read from the
      // brackets; everything before them is the name it must still match.
      const bracketed = /^(.*)\[\s*(\d+)\s*\]$/.exec(raw);
      if (bracketed) {
        const claimedName = bracketed[1].trim();
        const row = byId.get(Number(bracketed[2]));
        if (!row) return { status: "UNKNOWN" };
        if (claimedName !== "" && !sameName(claimedName, row.name)) {
          return { status: "NAME_MISMATCH", row, claimed: claimedName };
        }
        return { status: "OK", row };
      }

      const hits = byName.get(raw.toLowerCase());
      if (!hits || hits.length === 0) return { status: "UNKNOWN" };
      if (hits.length > 1) return { status: "AMBIGUOUS", rows: hits };
      return { status: "OK", row: hits[0] };
    },
  };
}

/* ============================================================ date cells == */

const DATE_DISPLAY_FORMAT = "dd/mm/yyyy";

const pad2 = (n) => String(n).padStart(2, "0");

/** A real calendar date, or null. Rejects 31/02 rather than rolling it over. */
function composeDate(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900 || year > 2999) return null;
  const iso = `${year}-${pad2(month)}-${pad2(day)}`;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) return null;
  return iso;
}

/**
 * An Excel serial date number -> ISO.
 *
 * Excel's epoch is 1899-12-30 for the 1900 system once its deliberate
 * non-existent 1900-02-29 is accounted for, which is why the base is the 30th
 * and not the 31st. Serials at or below 60 fall inside that fiction and are
 * refused rather than shifted by a day nobody can see.
 */
function fromExcelSerial(serial) {
  if (!Number.isFinite(serial) || serial <= 60 || serial > 400000) return null;
  const whole = Math.floor(serial);
  const ms = Date.UTC(1899, 11, 30) + whole * 86400000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * ONE DATE CELL -> `YYYY-MM-DD`, which is the only shape
 * `correctJoiningDate` accepts.
 *
 * WHAT IS ACCEPTED, AND NOTHING ELSE:
 *
 *   a genuine Excel date       a true date cell (a JS `Date` from the parser)
 *                              or the raw serial number behind one
 *   `dd/mm/yyyy`               the documented, displayed format, with `/`,
 *                              `-` or `.` as the separator and a 1- or
 *                              2-digit day and month
 *   `yyyy-mm-dd`               what the API itself emits, so a cell that was
 *                              never edited round-trips
 *
 * `mm/dd/yyyy` IS NOT A FORMAT THIS ACCEPTS, and that is the important
 * omission. `03/04/2024` is a valid date under both readings and they are
 * three weeks apart, so there is no safe way to detect which was meant. The
 * export writes real date cells and documents `dd/mm/yyyy`; a locale that
 * hands back `04/03/2024` meaning March 4th is read as the 4th of March, and
 * the preview shows the resulting date before anything is written — which is
 * the point of having a preview.
 */
function parseDateCell(value) {
  if (value === null || value === undefined) return { status: "BLANK" };

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return { status: "INVALID" };
    // A true date cell carries no timezone intent; take the UTC face of it,
    // which is what every parser in this repo stores for such a cell.
    return { status: "OK", date: value.toISOString().slice(0, 10) };
  }

  if (typeof value === "number") {
    const iso = fromExcelSerial(value);
    return iso ? { status: "OK", date: iso } : { status: "INVALID" };
  }

  const text = String(value).trim();
  if (text === "") return { status: "BLANK" };

  // A bare number arriving as text is still an Excel serial.
  if (/^\d{5}(\.\d+)?$/.test(text)) {
    const iso = fromExcelSerial(Number(text));
    return iso ? { status: "OK", date: iso } : { status: "INVALID" };
  }

  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (m) {
    const iso = composeDate(Number(m[1]), Number(m[2]), Number(m[3]));
    return iso ? { status: "OK", date: iso } : { status: "INVALID" };
  }

  m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/.exec(text);
  if (m) {
    const iso = composeDate(Number(m[3]), Number(m[2]), Number(m[1]));
    return iso ? { status: "OK", date: iso } : { status: "INVALID" };
  }

  // An ISO timestamp, which is what the employee API returns for some reads.
  m = /^(\d{4})-(\d{2})-(\d{2})T/.exec(text);
  if (m) {
    const iso = composeDate(Number(m[1]), Number(m[2]), Number(m[3]));
    return iso ? { status: "OK", date: iso } : { status: "INVALID" };
  }

  return { status: "INVALID" };
}

/** `YYYY-MM-DD` -> `dd/mm/yyyy`, for everything a human reads. */
function displayDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ""));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}

/** Whatever the master returned for `date_of_joining`, as `YYYY-MM-DD` or null. */
function toIsoDate(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value).trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** Blank in every way a spreadsheet cell can be blank. */
const isBlankCell = (value) =>
  value === null || value === undefined || String(value).trim() === "";

module.exports = {
  IDENTITY_FIELDS,
  UPDATE_FIELDS,
  UPDATE_FIELD_KEYS,
  DATE_DISPLAY_FORMAT,
  getUpdateField,
  fieldForLabel,
  resolveSelectedFields,
  buildMasterIndex,
  parseDateCell,
  displayDate,
  toIsoDate,
  isBlankCell,
  fromExcelSerial,
};
