/**
 * Biomax device management - the rules behind the Devices screen.
 *
 *   Add       a new Cloud ID with its first location period (Effective From
 *             chosen by the administrator every time; nothing defaults to a
 *             past date).
 *   Move      close the open period at the move time, open a new one at the
 *             new outlet from that same instant.
 *   Replace   a broken unit is NOT edited: its period is closed and the new
 *             unit is added with its own Cloud ID and period. The old Cloud
 *             ID stays, and its punches keep resolving to it.
 *   Deactivate close the open period with no successor.
 *   Reactivate open a new period from a chosen time.
 *   Correct Cloud ID  only for a genuine typo, with a reason, audited as
 *             `dev_id_corrected`. Refused once the device has any punch,
 *             because those punches would silently re-home (R17).
 *
 * Periods never overlap within a device and are never deleted; a wrong one
 * is closed and a corrected one added, with a note. Every change writes a
 * `biomax_device_event` row in the same transaction.
 *
 * No punch is read or written here except to REFUSE an action (closing a
 * period before the device's latest punch needs an explicit confirmation).
 */

const CLOUD_ID_RE = /^[A-Za-z0-9]{6,32}$/;
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

function validationError(message) {
  const err = new Error(message);
  err.name = "ValidationError";
  return err;
}

function notFound(message) {
  const err = new Error(message);
  err.name = "NotFoundError";
  err.httpCode = 404;
  return err;
}

/** 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM[:SS]' -> 'YYYY-MM-DD HH:MM:SS', else throws. */
function normaliseDateTime(value, name) {
  const m = DATETIME_RE.exec(String(value === undefined || value === null ? "" : value).trim());
  if (!m) throw validationError(`${name} must be YYYY-MM-DD or YYYY-MM-DD HH:MM[:SS]`);
  const [, y, mo, d, h = "00", mi = "00", s = "00"] = m;
  const probe = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
  if (
    probe.getUTCFullYear() !== Number(y) || probe.getUTCMonth() !== Number(mo) - 1 || probe.getUTCDate() !== Number(d) ||
    Number(h) > 23 || Number(mi) > 59 || Number(s) > 59
  ) {
    throw validationError(`${name} is not a real date/time`);
  }
  return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
}

/** String compare works for 'YYYY-MM-DD HH:MM:SS'. */
const before = (a, b) => a < b;

class BiomaxDeviceUsecase {
  constructor(deviceRepo) {
    this.deviceRepo = deviceRepo;
  }

  /* ---------------------------------------------------------------- reads */

  list() {
    return this.deviceRepo.list();
  }

  async details(biomax_device_id) {
    const id = this._id(biomax_device_id);
    const device = await this.deviceRepo.getById(id);
    if (!device) throw notFound("Device not found");
    const [assignments, events] = await Promise.all([
      this.deviceRepo.assignments(id),
      this.deviceRepo.events(id),
    ]);
    const current = assignments.find((a) => a.effective_to === null) || null;
    return {
      ...device,
      status: current ? "ACTIVE" : "INACTIVE",
      current_assignment: current,
      assignments,
      events: events.map((e) => ({
        ...e,
        detail: parseJson(e.detail_json),
      })),
    };
  }

  unregisteredSeen() {
    return this.deviceRepo.unregisteredSeen();
  }

  /* --------------------------------------------------------------- writes */

  /**
   * Add a device with its first period.
   * @param {object} body {dev_id, label, notes?, outlet_id, effective_from, note?}
   */
  async create(body, actor) {
    const dev_id = this._cloudId(body.dev_id);
    const label = this._label(body.label);
    const outlet_id = this._int(body.outlet_id, "outlet_id");
    const effective_from = normaliseDateTime(body.effective_from, "effective_from");
    const notes = optionalText(body.notes, 255);
    const note = optionalText(body.note, 255);

    return this.deviceRepo.transaction("CREATE", async (conn) => {
      if (await this.deviceRepo.getByDevId(dev_id)) {
        throw validationError(`Cloud ID ${dev_id} is already registered. To replace a broken terminal, deactivate the old one and add the new Cloud ID; never reuse an old record.`);
      }
      if (!(await this.deviceRepo.outletExists(outlet_id, conn))) {
        throw validationError(`outlet_id ${outlet_id} does not exist`);
      }
      const biomax_device_id = await this.deviceRepo.insertDevice(conn, {
        dev_id, label, notes, created_by: actorId(actor),
      });
      await this.deviceRepo.insertEvent(conn, {
        biomax_device_id, event_type: "created",
        detail: { dev_id, label, notes }, actor_employee_id: actorId(actor),
      });
      const biomax_device_assignment_id = await this.deviceRepo.insertAssignment(conn, {
        biomax_device_id, outlet_id, effective_from, effective_to: null, note, created_by: actorId(actor),
      });
      await this.deviceRepo.insertEvent(conn, {
        biomax_device_id, event_type: "assignment_opened",
        detail: { biomax_device_assignment_id, outlet_id, effective_from, note }, actor_employee_id: actorId(actor),
      });
      return { code: 200, biomax_device_id, biomax_device_assignment_id };
    });
  }

  /** Label / notes only. The Cloud ID is not editable here (see correctCloudId). */
  async updateDetails(body, actor) {
    const id = this._id(body.biomax_device_id);
    const fields = {};
    if (body.label !== undefined) fields.label = this._label(body.label);
    if (body.notes !== undefined) fields.notes = optionalText(body.notes, 255);
    if (body.dev_id !== undefined) {
      throw validationError("The Cloud ID cannot be changed here. Use the audited correction if it was genuinely mistyped, or add the new terminal as a new device.");
    }
    if (Object.keys(fields).length === 0) throw validationError("Nothing to update - send label and/or notes");

    return this.deviceRepo.transaction("UPDATE-DETAILS", async (conn) => {
      const existing = await this.deviceRepo.getById(id);
      if (!existing) throw notFound("Device not found");
      await this.deviceRepo.updateDeviceFields(conn, id, fields);
      for (const [field, value] of Object.entries(fields)) {
        await this.deviceRepo.insertEvent(conn, {
          biomax_device_id: id,
          event_type: field === "label" ? "label_changed" : "notes_changed",
          detail: { from: existing[field], to: value },
          actor_employee_id: actorId(actor),
        });
      }
      return { code: 200, biomax_device_id: id };
    });
  }

  /**
   * Move (or re-activate): close any open period at `effective_from` and
   * open a new one at `outlet_id` from that instant.
   */
  async assign(body, actor) {
    const id = this._id(body.biomax_device_id);
    const outlet_id = this._int(body.outlet_id, "outlet_id");
    const effective_from = normaliseDateTime(body.effective_from, "effective_from");
    const note = optionalText(body.note, 255);
    const confirm = body.confirm_before_last_punch === true || body.confirm_before_last_punch === 1 || body.confirm_before_last_punch === "1";

    return this.deviceRepo.transaction("ASSIGN", async (conn) => {
      const device = await this.deviceRepo.getById(id);
      if (!device) throw notFound("Device not found");
      if (!(await this.deviceRepo.outletExists(outlet_id, conn))) {
        throw validationError(`outlet_id ${outlet_id} does not exist`);
      }
      const periods = await this.deviceRepo.assignments(id, conn);
      const open = periods.find((p) => p.effective_to === null) || null;

      // Non-overlap: the new period must start after every closed period
      // ends (checked first, so the message names the period it collides
      // with) and after the open period starts.
      for (const p of periods) {
        if (p.effective_to !== null && before(effective_from, p.effective_to)) {
          throw validationError(`effective_from ${effective_from} overlaps the period ${p.effective_from} to ${p.effective_to} at ${p.outlet_name || p.outlet_id}. Periods never overlap; choose a later time or close that period first.`);
        }
      }
      if (open && !before(open.effective_from, effective_from)) {
        throw validationError(`effective_from ${effective_from} must be after the current period's start ${open.effective_from}`);
      }
      if (open && Number(open.outlet_id) === outlet_id) {
        throw validationError(`The device is already assigned to that outlet since ${open.effective_from}`);
      }

      const detail = { outlet_id, effective_from, note };
      if (open) {
        await this._guardLastPunch(conn, device.dev_id, effective_from, confirm);
        await this.deviceRepo.closeAssignment(conn, open.biomax_device_assignment_id, effective_from);
        await this.deviceRepo.insertEvent(conn, {
          biomax_device_id: id, event_type: "assignment_closed",
          detail: { biomax_device_assignment_id: open.biomax_device_assignment_id, outlet_id: open.outlet_id, effective_to: effective_from, reason: "moved" },
          actor_employee_id: actorId(actor),
        });
      }
      const biomax_device_assignment_id = await this.deviceRepo.insertAssignment(conn, {
        biomax_device_id: id, outlet_id, effective_from, effective_to: null, note, created_by: actorId(actor),
      });
      await this.deviceRepo.insertEvent(conn, {
        biomax_device_id: id, event_type: "assignment_opened",
        detail: { biomax_device_assignment_id, ...detail }, actor_employee_id: actorId(actor),
      });
      return { code: 200, biomax_device_id: id, biomax_device_assignment_id };
    });
  }

  /** Deactivate: close the open period at `effective_to`, no successor. */
  async deactivate(body, actor) {
    const id = this._id(body.biomax_device_id);
    const effective_to = normaliseDateTime(body.effective_to, "effective_to");
    const note = optionalText(body.note, 255);
    const confirm = body.confirm_before_last_punch === true || body.confirm_before_last_punch === 1 || body.confirm_before_last_punch === "1";

    return this.deviceRepo.transaction("DEACTIVATE", async (conn) => {
      const device = await this.deviceRepo.getById(id);
      if (!device) throw notFound("Device not found");
      const periods = await this.deviceRepo.assignments(id, conn);
      const open = periods.find((p) => p.effective_to === null);
      if (!open) throw validationError("The device has no open assignment; it is already inactive");
      if (!before(open.effective_from, effective_to)) {
        throw validationError(`effective_to ${effective_to} must be after the period's start ${open.effective_from}`);
      }
      await this._guardLastPunch(conn, device.dev_id, effective_to, confirm);
      await this.deviceRepo.closeAssignment(conn, open.biomax_device_assignment_id, effective_to);
      await this.deviceRepo.insertEvent(conn, {
        biomax_device_id: id, event_type: "assignment_closed",
        detail: { biomax_device_assignment_id: open.biomax_device_assignment_id, outlet_id: open.outlet_id, effective_to, reason: "deactivated", note },
        actor_employee_id: actorId(actor),
      });
      return { code: 200, biomax_device_id: id };
    });
  }

  /**
   * Correct a mistyped Cloud ID. Controlled: requires a reason, is audited,
   * and is refused once the device has punched, because those punches are
   * keyed by the old string and would silently detach (R17).
   */
  async correctCloudId(body, actor) {
    const id = this._id(body.biomax_device_id);
    const dev_id = this._cloudId(body.dev_id);
    const reason = optionalText(body.reason, 255);
    if (!reason) throw validationError("A reason is required to correct a Cloud ID");

    return this.deviceRepo.transaction("CORRECT-CLOUD-ID", async (conn) => {
      const device = await this.deviceRepo.getById(id);
      if (!device) throw notFound("Device not found");
      if (device.dev_id === dev_id) throw validationError("That is already the device's Cloud ID");
      if (await this.deviceRepo.getByDevId(dev_id)) throw validationError(`Cloud ID ${dev_id} belongs to another device`);
      const lastPunch = await this.deviceRepo.lastPunchIoTime(device.dev_id, conn);
      if (lastPunch) {
        throw validationError(`This device has already punched (last at ${lastPunch}); its Cloud ID cannot be changed. Add the correct Cloud ID as a new device and deactivate this one.`);
      }
      await this.deviceRepo.updateDeviceFields(conn, id, { dev_id });
      await this.deviceRepo.insertEvent(conn, {
        biomax_device_id: id, event_type: "dev_id_corrected",
        detail: { from: device.dev_id, to: dev_id, reason }, actor_employee_id: actorId(actor),
      });
      return { code: 200, biomax_device_id: id, dev_id };
    });
  }

  /* -------------------------------------------------------------- helpers */

  /**
   * Closing a period at a time before the device's latest punch would
   * quarantine punches that were valid when they happened. Allowed, but
   * only with an explicit confirmation.
   */
  async _guardLastPunch(conn, dev_id, at, confirmed) {
    const last = await this.deviceRepo.lastPunchIoTime(dev_id, conn);
    if (last && before(at, last) && !confirmed) {
      const err = validationError(`This device has punches up to ${last}; closing its period at ${at} would mark those later punches INACTIVE_DEVICE. Send confirm_before_last_punch=true to do this deliberately.`);
      err.needs_confirmation = true;
      err.last_punch_at = last;
      throw err;
    }
  }

  _id(v) {
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n <= 0) throw validationError("biomax_device_id is required");
    return n;
  }

  _int(v, name) {
    const n = Number(v);
    if (v === undefined || v === null || v === "" || !Number.isSafeInteger(n) || n <= 0) {
      throw validationError(`${name} is required`);
    }
    return n;
  }

  _cloudId(v) {
    const s = String(v === undefined || v === null ? "" : v).trim();
    if (!CLOUD_ID_RE.test(s)) throw validationError("dev_id (Cloud ID) must be 6-32 letters or digits, exactly as shown on the device");
    // VERBATIM: no case folding, no O/0 substitution.
    return s;
  }

  _label(v) {
    const s = String(v === undefined || v === null ? "" : v).trim();
    if (s === "" || s.length > 100) throw validationError("label is required and must be 100 characters or fewer");
    return s;
  }
}

function optionalText(v, max) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s.slice(0, max);
}

function actorId(actor) {
  if (!actor) return null;
  const id = actor.employeeId !== undefined ? actor.employeeId : actor.employee_id;
  return id === undefined || id === null ? null : Number(id);
}

function parseJson(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "object") return v;
  try {
    return JSON.parse(v);
  } catch (e) {
    return null;
  }
}

module.exports = (deviceRepo) => new BiomaxDeviceUsecase(deviceRepo);
module.exports.BiomaxDeviceUsecase = BiomaxDeviceUsecase;
module.exports.normaliseDateTime = normaliseDateTime;
module.exports.CLOUD_ID_RE = CLOUD_ID_RE;
