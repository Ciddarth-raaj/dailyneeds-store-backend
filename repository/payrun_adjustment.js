const logger = require("../utils/logger");
const {
  getConnectionAsync,
  beginTransactionAsync,
  commitAsync,
  rollbackAsync,
} = require("../utils/batchInsert");
const { AUDIT_ACTION, CHANGE_SOURCE } = require("../constants/payrun_adjustments");

/**
 * Payrun Adjustments V1 - the reads the stage needs, and the writes it makes.
 *
 * IT OWNS THREE TABLES AND WRITES NOTHING ELSE:
 *
 *   payrun_employee_adjustment         the component amounts
 *   payrun_employee_adjustment_state   remarks and the explicit no-adjustment
 *   payrun_employee_adjustment_audit   append-only, every material change
 *
 * IT READS `payrun_employee` AND NEVER WRITES IT. The initialized population
 * belongs to the initialization stage; this stage asks it who is in the month
 * and has no statement that could change the answer. There is no UPDATE of
 * `payrun_employee`, none of `new_employee`, none of `employee_salary` and
 * none of any attendance table anywhere in this file, and a test asserts it.
 *
 * EVERY READ IS BATCHED ACROSS THE MONTH, for the reason `repository/payrun.js`
 * states about itself: a screen covering six hundred employees cannot afford a
 * query per employee, and the adjustments screen shows the whole month.
 *
 * THE POPULATION IS READ FRESH ON EVERY CALL. There is no cached count and no
 * stored "who was initialized when the template was exported": that is what
 * makes three employees initialized this afternoon show up as pending this
 * afternoon.
 */

/** The same fail-CLOSED location predicate `repository/payrun.js` documents. */
function locationPredicate(column, store_ids) {
  if (store_ids === null || store_ids === undefined) return { clause: null, params: [] };
  if (!Array.isArray(store_ids) || store_ids.length === 0) {
    return { clause: "1 = 0", params: [] };
  }
  return { clause: `${column} IN (?)`, params: [store_ids] };
}

class PayrunAdjustmentRepository {
  constructor(db) {
    this.db = db;
  }

  _log(code, err, ref = {}) {
    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "REPOSITORY.PAYRUN_ADJUSTMENT",
      code: `REPOSITORY.PAYRUN_ADJUSTMENT.${code}`,
      description: err.toString(),
      category: "",
      ref,
    });
  }

  _read(code, sql, params, conn = null) {
    return new Promise((resolve, reject) => {
      (conn || this.db).query(sql, params, (err, rows) => {
        if (err) {
          this._log(code, err);
          reject(err);
          return;
        }
        resolve(rows || []);
      });
    });
  }

  /* ------------------------------------------------------------- the reads */

  /**
   * THE MONTH'S INITIALIZED POPULATION - and this read IS the definition of
   * who takes part in the adjustments stage.
   *
   * IT SELECTS FROM `payrun_employee`, NOT FROM `new_employee`. An employee
   * who is employed, present and owed money but whose month has not been
   * initialized is deliberately absent: there is no snapshot to attach an
   * adjustment to, and creating one from this stage would be initializing
   * somebody through a side door that skips every eligibility rule.
   *
   * THE LOCATION IS THE SNAPSHOT'S, not the employee master's current branch.
   * A payroll month explains itself from the row it stored - see the
   * initialization migration - and joining to `new_employee` for a branch here
   * would mean an employee transferred in October changes which branch their
   * already-initialized September appears under.
   *
   * THE BRANCH SCOPE IS APPLIED IN SQL and fails closed, so an out-of-scope
   * employee is not read rather than being read and filtered.
   */
  async listInitialized({ year, month, store_ids = null, employee_ids = null }) {
    const where = ["pe.period_year = ?", "pe.period_month = ?"];
    const params = [year, month];

    const location = locationPredicate("pe.store_id", store_ids);
    if (location.clause) {
      where.push(location.clause);
      params.push(...location.params);
    }
    if (Array.isArray(employee_ids)) {
      if (employee_ids.length === 0) return [];
      where.push("pe.employee_id IN (?)");
      params.push(employee_ids);
    }

    return this._read(
      "LIST-INITIALIZED",
      `SELECT pe.payrun_employee_id,
              pe.employee_id,
              pe.employee_name,
              pe.store_id,
              pe.store_name,
              pe.designation_name,
              pe.pay_type,
              DATE_FORMAT(pe.initialized_at, '%Y-%m-%d %H:%i:%s') AS initialized_at
         FROM payrun_employee pe
        WHERE ${where.join(" AND ")}
        ORDER BY pe.employee_id`,
      params
    );
  }

  /** Every stored component amount for the month, for the whole population. */
  async listAmounts({ year, month, employee_ids = null }) {
    const params = [year, month];
    let clause = "period_year = ? AND period_month = ?";
    if (Array.isArray(employee_ids)) {
      if (employee_ids.length === 0) return [];
      clause += " AND employee_id IN (?)";
      params.push(employee_ids);
    }
    return this._read(
      "LIST-AMOUNTS",
      `SELECT payrun_adjustment_id, employee_id, component, amount,
              DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at, updated_by
         FROM payrun_employee_adjustment
        WHERE ${clause}
        ORDER BY employee_id`,
      params
    );
  }

  /** The remarks and the explicit no-adjustment confirmation, per employee. */
  async listStates({ year, month, employee_ids = null }) {
    const params = [year, month];
    let clause = "period_year = ? AND period_month = ?";
    if (Array.isArray(employee_ids)) {
      if (employee_ids.length === 0) return [];
      clause += " AND employee_id IN (?)";
      params.push(employee_ids);
    }
    return this._read(
      "LIST-STATES",
      `SELECT payrun_adjustment_state_id, employee_id, remarks,
              confirmed_no_adjustment, confirmed_by,
              DATE_FORMAT(confirmed_at, '%Y-%m-%d %H:%i:%s') AS confirmed_at
         FROM payrun_employee_adjustment_state
        WHERE ${clause}`,
      params
    );
  }

  /** One employee's change history for the month, newest first. */
  async listAudit({ year, month, employee_id }) {
    return this._read(
      "LIST-AUDIT",
      `SELECT payrun_adjustment_audit_id, action, component,
              old_amount, new_amount, source, source_filename, changed_by,
              DATE_FORMAT(changed_at, '%Y-%m-%d %H:%i:%s') AS changed_at
         FROM payrun_employee_adjustment_audit
        WHERE period_year = ? AND period_month = ? AND employee_id = ?
        ORDER BY payrun_adjustment_audit_id DESC
        LIMIT 200`,
      [year, month, employee_id]
    );
  }

  /* ------------------------------------------------------------ the writes */

  /**
   * SAVE ADJUSTMENTS FOR MANY EMPLOYEES, ALL OF THEM OR NONE OF THEM.
   *
   * ONE TRANSACTION FOR THE WHOLE SAVE. An import of two hundred rows that
   * failed on the hundred and ninetieth must leave the month exactly as it
   * was: a half-applied payroll file is worse than a refused one, because
   * nobody can tell by looking which half landed.
   *
   * WHAT ONE `entry` SAYS, AND WHAT EACH PART MEANS:
   *
   *   amounts   a map of component -> number. A component PRESENT with a
   *             number is set; a component present as `null` is CLEARED; a
   *             component ABSENT is left exactly as it is. The three are
   *             genuinely different and the caller means different things by
   *             them - an import that only carries an Incentive column must
   *             not wipe the Bonus somebody entered by hand last week.
   *   remarks   `undefined` leaves them, `null` clears them, a string sets them.
   *
   * A CONFIRMATION IS REVOKED BY THE ARRIVAL OF AN ADJUSTMENT, IN THE SAME
   * TRANSACTION. This is the transition the specification asks to be defined:
   * once any amount is stored for an employee, `confirmed_no_adjustment` is
   * set back to 0 and its actor and timestamp are cleared, and the revocation
   * is logged. Leaving the flag set and relying on the read-side ordering
   * would work today and would be a lie in the table.
   *
   * EVERY CHANGE IS AUDITED WITH BOTH AMOUNTS. The old value is read inside
   * the transaction, so the log says what it actually replaced rather than
   * what the caller believed it was replacing.
   *
   * NOTHING IS WRITTEN FOR AN EMPLOYEE WITH NO `payrun_employee_id`. The
   * caller resolves that from the month's initialized population; an entry
   * without one never reaches here, and the foreign key is the floor under
   * that.
   */
  async saveAdjustments({ year, month, entries, actor_id = null, source = CHANGE_SOURCE.MANUAL, filename = null }) {
    if (!Array.isArray(entries) || entries.length === 0) {
      return { employees_written: 0, amounts_set: 0, amounts_cleared: 0, confirmations_revoked: 0 };
    }

    const conn = await getConnectionAsync(this.db);
    const counts = { employees_written: 0, amounts_set: 0, amounts_cleared: 0, confirmations_revoked: 0 };
    try {
      await beginTransactionAsync(conn);

      for (const entry of entries) {
        const { employee_id: employeeId, payrun_employee_id: payrunEmployeeId } = entry;

        /*
         * THE CURRENT AMOUNTS, LOCKED. Two people saving the same employee's
         * month at once must produce two audit rows in a defensible order,
         * each naming the value it really replaced - which a read outside the
         * transaction cannot promise.
         */
        /* eslint-disable no-await-in-loop */
        const current = await this._read(
          "LOCK-AMOUNTS",
          `SELECT payrun_adjustment_id, component, amount
             FROM payrun_employee_adjustment
            WHERE period_year = ? AND period_month = ? AND employee_id = ?
            FOR UPDATE`,
          [year, month, employeeId],
          conn
        );
        const currentOf = new Map(current.map((r) => [r.component, Number(r.amount)]));

        const audits = [];
        let wrote = false;
        let anyAmountRemains = current.length > 0;

        const amounts = entry.amounts || {};
        for (const component of Object.keys(amounts)) {
          const next = amounts[component];
          const had = currentOf.has(component);
          const old = had ? currentOf.get(component) : null;

          if (next === null) {
            if (!had) continue;
            await this._read(
              "DELETE-AMOUNT",
              `DELETE FROM payrun_employee_adjustment
                WHERE period_year = ? AND period_month = ? AND employee_id = ? AND component = ?`,
              [year, month, employeeId, component],
              conn
            );
            currentOf.delete(component);
            counts.amounts_cleared += 1;
            wrote = true;
            audits.push([AUDIT_ACTION.CLEAR_AMOUNT, component, old, null]);
            continue;
          }

          if (had && Number(old) === Number(next)) continue; // nothing changed, nothing logged

          await this._read(
            "UPSERT-AMOUNT",
            `INSERT INTO payrun_employee_adjustment
                    (payrun_employee_id, period_year, period_month, employee_id,
                     component, amount, created_by, updated_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE amount = VALUES(amount), updated_by = VALUES(updated_by)`,
            [payrunEmployeeId, year, month, employeeId, component, next, actor_id, actor_id],
            conn
          );
          currentOf.set(component, Number(next));
          counts.amounts_set += 1;
          wrote = true;
          audits.push([AUDIT_ACTION.SET_AMOUNT, component, old, next]);
        }

        anyAmountRemains = currentOf.size > 0;

        /*
         * THE STATE ROW. It is written when there are remarks to store, or
         * when a confirmation has to be revoked - and NOT merely because an
         * amount was saved: a row per employee whose only content is a
         * timestamp is a table that grows with the payroll and says nothing.
         */
        const stateRow = await this._read(
          "LOCK-STATE",
          `SELECT payrun_adjustment_state_id, remarks, confirmed_no_adjustment
             FROM payrun_employee_adjustment_state
            WHERE period_year = ? AND period_month = ? AND employee_id = ?
            FOR UPDATE`,
          [year, month, employeeId],
          conn
        );
        const state = stateRow[0] || null;

        const remarksGiven = Object.prototype.hasOwnProperty.call(entry, "remarks");
        const nextRemarks = remarksGiven ? entry.remarks : undefined;
        const remarksChanged =
          remarksGiven && String(state ? state.remarks || "" : "") !== String(nextRemarks || "");

        // AN ADJUSTMENT REVOKES A CONFIRMATION. See the note above.
        const mustRevoke = Boolean(state && state.confirmed_no_adjustment) && anyAmountRemains;

        if (remarksChanged || mustRevoke) {
          await this._read(
            "UPSERT-STATE",
            `INSERT INTO payrun_employee_adjustment_state
                    (payrun_employee_id, period_year, period_month, employee_id,
                     remarks, confirmed_no_adjustment, confirmed_by, confirmed_at)
             VALUES (?, ?, ?, ?, ?, 0, NULL, NULL)
             ON DUPLICATE KEY UPDATE
                    remarks = ${remarksGiven ? "VALUES(remarks)" : "remarks"},
                    confirmed_no_adjustment =
                      IF(${anyAmountRemains ? 1 : 0}, 0, confirmed_no_adjustment),
                    confirmed_by =
                      IF(${anyAmountRemains ? 1 : 0}, NULL, confirmed_by),
                    confirmed_at =
                      IF(${anyAmountRemains ? 1 : 0}, NULL, confirmed_at)`,
            [payrunEmployeeId, year, month, employeeId, nextRemarks === undefined ? null : nextRemarks],
            conn
          );
          wrote = true;
          if (remarksChanged) audits.push([AUDIT_ACTION.SET_REMARKS, null, null, null]);
          if (mustRevoke) {
            counts.confirmations_revoked += 1;
            audits.push([AUDIT_ACTION.REVOKE_NO_ADJUSTMENT, null, null, null]);
          }
        }

        if (audits.length > 0) {
          await this._read(
            "INSERT-AUDIT",
            `INSERT INTO payrun_employee_adjustment_audit
                    (payrun_employee_id, period_year, period_month, employee_id,
                     action, component, old_amount, new_amount, source, source_filename, changed_by)
             VALUES ?`,
            [
              audits.map(([action, component, oldAmount, newAmount]) => [
                payrunEmployeeId, year, month, employeeId,
                action, component, oldAmount, newAmount, source, filename, actor_id,
              ]),
            ],
            conn
          );
        }
        /* eslint-enable no-await-in-loop */

        if (wrote) counts.employees_written += 1;
      }

      await commitAsync(conn);
      return counts;
    } catch (err) {
      await rollbackAsync(conn);
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * CONFIRM "NO ADJUSTMENT" FOR ONE OR MANY EMPLOYEES.
   *
   * INDIVIDUAL AND BULK ARE THE SAME STATEMENT. Confirming one employee is a
   * list of one, exactly as initialization made "Initialize" a bulk of one:
   * two code paths for one decision is how one of them ends up missing the
   * check below.
   *
   * AN EMPLOYEE WHO HAS AN ADJUSTMENT CANNOT BE CONFIRMED AS HAVING NONE, and
   * this is checked HERE, inside the transaction, against the amounts as they
   * are at this instant - not against what the screen was showing. The screen's
   * copy is minutes old, and "confirmed no adjustment" on somebody with a
   * 5,000 Incentive is a contradiction the month would carry to the payslip.
   * Such an employee is reported back as SKIPPED rather than failing the batch:
   * one person edited in another tab must not stop the other seventy being
   * confirmed.
   *
   * WHO AND WHEN ARE WRITTEN IN THE SAME STATEMENT AS THE FLAG, so a
   * confirmation with nobody's name on it cannot exist.
   *
   * RE-CONFIRMING CHANGES NOTHING AND LOGS NOTHING. An already-confirmed
   * employee comes back as ALREADY_CONFIRMED; overwriting the original
   * confirmer with whoever clicked last would destroy the audit that is the
   * entire point of the row.
   */
  async confirmNoAdjustment({ year, month, employees, actor_id = null }) {
    if (!Array.isArray(employees) || employees.length === 0) return [];

    const conn = await getConnectionAsync(this.db);
    try {
      await beginTransactionAsync(conn);
      const results = [];

      for (const employee of employees) {
        const employeeId = employee.employee_id;
        /* eslint-disable no-await-in-loop */
        const amounts = await this._read(
          "CHECK-AMOUNTS-BEFORE-CONFIRM",
          `SELECT component FROM payrun_employee_adjustment
            WHERE period_year = ? AND period_month = ? AND employee_id = ?
            FOR UPDATE`,
          [year, month, employeeId],
          conn
        );
        if (amounts.length > 0) {
          results.push({ employee_id: employeeId, result: "HAS_ADJUSTMENT" });
          continue;
        }

        const existing = await this._read(
          "LOCK-STATE-BEFORE-CONFIRM",
          `SELECT confirmed_no_adjustment FROM payrun_employee_adjustment_state
            WHERE period_year = ? AND period_month = ? AND employee_id = ?
            FOR UPDATE`,
          [year, month, employeeId],
          conn
        );
        if (existing[0] && Number(existing[0].confirmed_no_adjustment) === 1) {
          results.push({ employee_id: employeeId, result: "ALREADY_CONFIRMED" });
          continue;
        }

        await this._read(
          "CONFIRM-NO-ADJUSTMENT",
          `INSERT INTO payrun_employee_adjustment_state
                  (payrun_employee_id, period_year, period_month, employee_id,
                   confirmed_no_adjustment, confirmed_by, confirmed_at)
           VALUES (?, ?, ?, ?, 1, ?, CURRENT_TIMESTAMP)
           ON DUPLICATE KEY UPDATE
                  confirmed_no_adjustment = 1,
                  confirmed_by = VALUES(confirmed_by),
                  confirmed_at = CURRENT_TIMESTAMP`,
          [employee.payrun_employee_id, year, month, employeeId, actor_id],
          conn
        );

        await this._read(
          "AUDIT-CONFIRM",
          `INSERT INTO payrun_employee_adjustment_audit
                  (payrun_employee_id, period_year, period_month, employee_id,
                   action, source, changed_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            employee.payrun_employee_id, year, month, employeeId,
            AUDIT_ACTION.CONFIRM_NO_ADJUSTMENT, CHANGE_SOURCE.MANUAL, actor_id,
          ],
          conn
        );
        /* eslint-enable no-await-in-loop */

        results.push({ employee_id: employeeId, result: "CONFIRMED" });
      }

      await commitAsync(conn);
      return results;
    } catch (err) {
      await rollbackAsync(conn);
      throw err;
    } finally {
      conn.release();
    }
  }
}

module.exports = (db) => new PayrunAdjustmentRepository(db);
module.exports.PayrunAdjustmentRepository = PayrunAdjustmentRepository;
module.exports.locationPredicate = locationPredicate;
