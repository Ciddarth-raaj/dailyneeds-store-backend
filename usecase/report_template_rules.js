/**
 * Reports — template ownership, and reconciling a saved template at run time.
 *
 * Pure functions. No database, no clock.
 *
 * ================================================== THE GOVERNING IDEA ====
 *
 * A saved template is an INSTRUCTION, not a trusted snapshot. Between saving
 * and running it, the person may have lost a permission, a field may have been
 * disabled, and an outlet may have been deleted. So every run revalidates
 * everything, and the interesting question is what to do when something no
 * longer resolves.
 *
 * The answer is NOT "fail the report" - that makes a template useless the
 * first time an outlet is renamed. It is also NOT "drop it silently", and the
 * reason is the one case that makes this whole file necessary:
 *
 *   A template filtered to ONE outlet. That outlet is deleted. Dropping the
 *   stale value leaves no outlet filter at all - which does not mean "no
 *   results", it means EVERY outlet. Silently, a one-branch report becomes a
 *   whole-company export.
 *
 * So reconciliation classifies each warning by whether it can BROADEN the
 * population. A narrowing or cosmetic change proceeds quietly; a widening one
 * must be acknowledged before an export runs. Preview may show it, because
 * looking is not the same as taking data out of the building.
 */

/* ------------------------------------------------------------ ownership */

const TEMPLATE_KIND = { PERSONAL: "personal", SHARED: "shared", SYSTEM: "system" };

const kindOf = (template) => {
  if (!template) return null;
  if (Number(template.is_system) === 1) return TEMPLATE_KIND.SYSTEM;
  if (Number(template.is_shared) === 1) return TEMPLATE_KIND.SHARED;
  return TEMPLATE_KIND.PERSONAL;
};

const isOwner = (template, actor) =>
  Boolean(
    template &&
      actor &&
      template.owner_user_id !== null &&
      template.owner_user_id !== undefined &&
      Number(template.owner_user_id) === Number(actor.userId)
  );

/**
 * What this actor may do with this template.
 *
 * A system template is editable by nobody - not even an administrator through
 * the usual bypass. That is deliberate: these five rows are what Reports looks
 * like on day one for every user, and "Save a Copy" is the explicit path for
 * anyone who wants them different. An admin who genuinely needs to change the
 * shipped set changes the migration.
 */
function templatePermissions(template, actor) {
  const kind = kindOf(template);
  if (!kind) return { canRun: false, canEdit: false, canDelete: false, canCopy: false };

  if (kind === TEMPLATE_KIND.SYSTEM) {
    return { canRun: true, canEdit: false, canDelete: false, canCopy: true, kind };
  }

  const owner = isOwner(template, actor);
  if (kind === TEMPLATE_KIND.PERSONAL) {
    // Not visible to anyone else at all, so every verb turns on ownership.
    return { canRun: owner, canEdit: owner, canDelete: owner, canCopy: owner, kind };
  }

  // Shared: others may run it and take a copy, but the original is the
  // owner's. Editing somebody else's shared template would change what their
  // colleagues see without their knowing.
  return { canRun: true, canEdit: owner, canDelete: owner, canCopy: true, kind };
}

/** Which templates this actor may see at all. */
const canSeeTemplate = (template, actor) => {
  const kind = kindOf(template);
  if (kind === TEMPLATE_KIND.SYSTEM || kind === TEMPLATE_KIND.SHARED) return true;
  return isOwner(template, actor);
};

/** A copy is always a fresh PERSONAL template owned by whoever copied it. */
function buildCopy(template, actor, name) {
  return {
    template_name: String(name || `${template.template_name} (copy)`).slice(0, 120),
    dataset_key: template.dataset_key,
    field_keys: Array.isArray(template.field_keys) ? [...template.field_keys] : [],
    filters: template.filters ? { ...template.filters } : {},
    owner_user_id: actor.userId,
    is_shared: 0,
    is_system: 0,
  };
}

/* -------------------------------------------------- filter reconciliation */

/**
 * Reconcile one multi-select lookup filter against what currently exists.
 *
 * @param saved     the ids stored in the template
 * @param resolvable Set of ids that still exist (active OR inactive)
 * @param activeIds  Set of ids that are currently active
 *
 * An INACTIVE but still resolvable value is KEPT. A closed branch's staff are
 * exactly who a leavers report is about, and dropping the filter because the
 * branch shut would silently widen the report to every branch. It is flagged
 * so the UI can show it as inactive, not removed.
 */
function reconcileLookupFilter(saved, resolvable, activeIds, { field, label }) {
  const values = Array.isArray(saved) ? saved.map(Number) : [];
  if (values.length === 0) return { values: [], warnings: [] };

  const kept = [];
  const inactive = [];
  const removed = [];

  for (const id of values) {
    if (resolvable.has(id)) {
      kept.push(id);
      if (!activeIds.has(id)) inactive.push(id);
    } else {
      removed.push(id);
    }
  }

  const warnings = [];

  if (inactive.length) {
    warnings.push({
      type: "filter_value_inactive",
      field,
      message: `${label}: ${inactive.length} selected value${inactive.length === 1 ? " is" : "s are"} no longer active, but ${inactive.length === 1 ? "it is" : "they are"} still included.`,
      // Keeping a value cannot broaden anything.
      widens_result_set: false,
      values: inactive,
    });
  }

  if (removed.length) {
    // THE CASE THIS FILE EXISTS FOR. Losing every value means losing the
    // filter, and losing a filter means every value - the opposite of what
    // the template said.
    const filterLost = kept.length === 0;
    warnings.push({
      type: "filter_value_unresolvable",
      field,
      message: filterLost
        ? `The saved ${label} filter no longer contains a valid ${label.toLowerCase()}. ` +
          `That filter was removed, so this report may now include employees from more ${label.toLowerCase()}s than before.`
        : `${label}: ${removed.length} saved value${removed.length === 1 ? "" : "s"} no longer exist${removed.length === 1 ? "s" : ""} and ${removed.length === 1 ? "was" : "were"} removed. The remaining selection still applies.`,
      // Removing SOME values from a multi-select leaves the filter in place
      // and narrows it further; removing them ALL drops the filter entirely
      // and widens the population.
      widens_result_set: filterLost,
      values: removed,
    });
  }

  return { values: kept, warnings };
}

/**
 * Employment status is not a lookup, so it cannot go stale in the same way -
 * but a saved value this build no longer recognises must not silently become
 * "all", which is the widest possible answer.
 */
function reconcileStatus(saved, allowed) {
  const value = String(saved ?? "active").toLowerCase();
  if (allowed.includes(value)) return { value, warnings: [] };
  return {
    // Fall back to the safest option, not the widest.
    value: "active",
    warnings: [
      {
        type: "filter_value_unresolvable",
        field: "status",
        message:
          `The saved employment status is no longer recognised. ` +
          `The report has fallen back to Active.`,
        widens_result_set: false,
      },
    ],
  };
}

/** Does anything in this warning set broaden the population? */
const widensResultSet = (warnings) =>
  (warnings || []).some((w) => w && w.widens_result_set === true);

/**
 * May this export proceed?
 *
 * Preview is always allowed to show a widened result - looking at a wider set
 * on screen is not the risk. Taking it out of the building is, so an export
 * whose filters were widened by reconciliation needs the caller to say
 * explicitly that they meant to.
 */
function exportGate(warnings, acknowledged) {
  if (!widensResultSet(warnings)) return { allowed: true };
  if (acknowledged === true) return { allowed: true, acknowledged: true };
  return {
    allowed: false,
    code: "FILTER_WIDENED",
    httpCode: 409,
    msg:
      "A saved filter could not be applied, so this export would cover more employees than the " +
      "template intended. Review the filters, or export anyway if that is what you want.",
    warnings: (warnings || []).filter((w) => w.widens_result_set),
  };
}

module.exports = {
  TEMPLATE_KIND,
  kindOf,
  isOwner,
  templatePermissions,
  canSeeTemplate,
  buildCopy,
  reconcileLookupFilter,
  reconcileStatus,
  widensResultSet,
  exportGate,
};
