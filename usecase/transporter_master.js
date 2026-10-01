const { nameKey, validateTransporter } = require("../utils/transporter");

/**
 * Transporter Master: create, edit, activate/deactivate. Never delete.
 *
 * Every create and edit writes the audit trail in the same transaction as
 * the change, so the master and its history cannot disagree.
 */

const AUDITED_FIELDS = [
  "transporter_name",
  "contact_no",
  "alternate_contact_no",
  "contact_person",
  "is_active",
  "remarks",
];

const named = (name, message, extra = {}) => {
  const err = new Error(message);
  err.name = name;
  Object.assign(err, extra);
  return err;
};

const validationError = (errors) =>
  named("BusinessRuleError", Object.values(errors)[0], { errors });

const isDuplicateKey = (err) => err && (err.code === "ER_DUP_ENTRY" || err.errno === 1062);

const duplicateName = (existing) =>
  named(
    "ConflictError",
    existing
      ? `A transporter named "${existing.transporter_name}" already exists${
          Number(existing.is_active) ? "" : " (inactive - reactivate it instead)"
        }.`
      : "A transporter with this name already exists."
  );

const asAuditValue = (field, value) =>
  field === "is_active" ? (Number(value) ? "Active" : "Inactive") : value;

class TransporterMasterUsecase {
  constructor(repo) {
    this.repo = repo;
  }

  list(filters) {
    return this.repo.list(filters);
  }

  /** What a dropdown for a NEW entry may offer: active transporters only. */
  options() {
    return this.repo.list({ is_active: true }).then((rows) =>
      rows.map((r) => ({
        transporter_id: r.transporter_id,
        transporter_name: r.transporter_name,
        contact_no: r.contact_no,
        contact_person: r.contact_person,
      }))
    );
  }

  async getById(id) {
    const row = await this.repo.getById(id);
    if (!row) throw named("NotFoundError", "Transporter not found");
    const [audit, usage] = await Promise.all([this.repo.getAudit(id), this.repo.usageCount(id)]);
    return { ...row, audit, usage };
  }

  async create(input, employeeId) {
    const { value, errors } = validateTransporter(input);
    if (Object.keys(errors).length) throw validationError(errors);

    const key = nameKey(value.transporter_name);

    try {
      const id = await this.repo.transaction(async (conn) => {
        const existing = await this.repo.findByNameKey(key, conn);
        if (existing) throw duplicateName(existing);

        const newId = await this.repo.insert(
          { ...value, transporter_name_key: key, is_active: value.is_active !== false, created_by: employeeId },
          conn
        );

        await this.repo.insertAudit(
          AUDITED_FIELDS.filter((f) => f === "is_active" || (value[f] !== undefined && value[f] !== null)).map(
            (field) => ({
              transporter_id: newId,
              action: "CREATE",
              field,
              old_value: null,
              new_value: asAuditValue(field, field === "is_active" ? value.is_active !== false : value[field]),
              changed_by: employeeId,
            })
          ),
          conn
        );
        return newId;
      });
      return this.getById(id);
    } catch (err) {
      // Two people adding the same name at once: the unique key decides.
      if (isDuplicateKey(err)) throw duplicateName(await this.repo.findByNameKey(key));
      throw err;
    }
  }

  async update(id, input, employeeId) {
    const { value, errors } = validateTransporter(input, { partial: true });
    if (Object.keys(errors).length) throw validationError(errors);

    try {
      await this.repo.transaction(async (conn) => {
        const current = await this.repo.getById(id, conn, { forUpdate: true });
        if (!current) throw named("NotFoundError", "Transporter not found");

        const fields = {};
        if (value.transporter_name !== undefined) {
          const key = nameKey(value.transporter_name);
          if (key !== current.transporter_name_key) {
            const clash = await this.repo.findByNameKey(key, conn);
            if (clash && Number(clash.transporter_id) !== Number(id)) throw duplicateName(clash);
          }
          fields.transporter_name_key = key;
        }

        const changed = AUDITED_FIELDS.filter((f) => {
          if (value[f] === undefined) return false;
          const before = f === "is_active" ? Boolean(Number(current[f])) : current[f] ?? null;
          return String(before) !== String(value[f]);
        });
        if (changed.length === 0) return;

        changed.forEach((f) => {
          fields[f] = f === "is_active" ? (value[f] ? 1 : 0) : value[f];
        });
        fields.updated_by = employeeId;

        await this.repo.update(id, fields, conn);
        await this.repo.insertAudit(
          changed.map((field) => ({
            transporter_id: id,
            action: "UPDATE",
            field,
            old_value: asAuditValue(field, current[field]),
            new_value: asAuditValue(field, value[field]),
            changed_by: employeeId,
          })),
          conn
        );
      });
    } catch (err) {
      if (isDuplicateKey(err)) throw duplicateName(null);
      throw err;
    }
    return this.getById(id);
  }

  /**
   * The check every NEW selection goes through. `currentId` is the value the
   * record already holds: keeping an inactive transporter that was chosen
   * while it was active is allowed, choosing one afresh is not.
   */
  async assertSelectable(transporterId, currentId = null, conn = null) {
    if (transporterId === null || transporterId === undefined) return null;
    if (currentId !== null && Number(currentId) === Number(transporterId)) return transporterId;
    const row = await this.repo.getById(transporterId, conn);
    if (!row) throw named("BusinessRuleError", "The selected transporter does not exist.");
    if (!Number(row.is_active)) {
      throw named(
        "BusinessRuleError",
        `${row.transporter_name} is inactive and cannot be selected for a new entry.`
      );
    }
    return transporterId;
  }
}

module.exports = (repo) => new TransporterMasterUsecase(repo);
