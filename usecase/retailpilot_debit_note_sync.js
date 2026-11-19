const logger = require("../utils/logger");
const { financialYearBounds } = require("../utils/financial_year");
const { buildDebitNoteQuery, mapDebitNotes } = require("../utils/retailpilot_debit_note");

const MAX_DAYS = 90;

/** YYYY-MM-DD from a DATE column (a Date object or a string). */
function dateOnlyString(value) {
  if (value instanceof Date) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  return String(value || "").slice(0, 10);
}

/**
 * Pulls debit notes from RetailPilot into the debit_note table, one by one
 * with debitNoteRepo.upsertRetailPilotDebitNote: new ones inserted, approved
 * ones and ones Accounts has saved never touched.
 */
class RetailPilotDebitNoteSync {
  /**
   * @param loadStoreMap async () => { [retailpilot store slug]: outlet_id }
   *   from Branch Master, read on every run.
   */
  constructor(spectra, debitNoteRepo, config, loadStoreMap) {
    this.spectra = spectra;
    this.debitNoteRepo = debitNoteRepo;
    this.config = config;
    this.loadStoreMap = loadStoreMap;
    this.running = false;
  }

  /**
   * The reference (mprh_pr_refno) is the Tally voucher number, and Tally's
   * responses are matched back on it and the outlet. RetailPilot numbers
   * debit notes per store and financial year, so a reference already used
   * at the outlet in the same financial year by another debit note (an old
   * GoFrugal one) is a clash: skipped and reported. The same RetailPilot
   * debit note coming back (same slug in mprh_pr_no) is not a clash.
   */
  async _withoutRefnoClashes(debitNotes, skipped) {
    if (!debitNotes.length) return debitNotes;
    const seriesYear = (d) => (d.FY ? financialYearBounds(`${d.FY}-04-01`) : financialYearBounds(d.MPRH_PR_DT));
    const keyOf = (outletId, refno, fyStart) => `${outletId}|${String(refno).trim()}|${fyStart}`;
    const existing = await this.debitNoteRepo.findByOutletRefnos(
      debitNotes.map((d) => {
        const fy = seriesYear(d);
        return [d.STORE_ID, d.MPRH_PR_REFNO, fy.start, fy.end];
      })
    );
    const byKey = new Map();
    for (const r of existing) {
      const k = keyOf(r.store_id, r.mprh_pr_refno, financialYearBounds(dateOnlyString(r.mprh_pr_dt)).start);
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(r);
    }
    return debitNotes.filter((d) => {
      const rows = byKey.get(keyOf(d.STORE_ID, d.MPRH_PR_REFNO, seriesYear(d).start)) || [];
      const other = rows.find((r) => String(r.mprh_pr_no || "").trim() !== d.MPRH_PR_NO);
      if (!other) return true;
      skipped.push({
        recon_slug: d.MPRH_PR_NO,
        reason: `reference ${d.MPRH_PR_REFNO} already belongs to debit note ${other.debit_note_id} (${other.mprh_pr_no}) at this outlet in the same financial year`,
      });
      return false;
    });
  }

  async run({ days, dryRun = false } = {}) {
    const lookback = days == null ? this.config.debitNoteLookbackDays : Number(days);
    if (!Number.isInteger(lookback) || lookback < 0 || lookback > MAX_DAYS) {
      return { code: 400, message: `days must be an integer from 0 to ${MAX_DAYS}` };
    }
    if (!this.spectra.isConfigured()) {
      return { code: 400, message: "RetailPilot is not configured (RETAILPILOT_SPECTRA_URL / RETAILPILOT_SPECTRA_KEY)" };
    }
    if (this.running) {
      return { code: 409, message: "A RetailPilot debit note sync is already running" };
    }

    this.running = true;
    try {
      const storeMap = this.loadStoreMap ? (await this.loadStoreMap()) || {} : {};
      if (Object.keys(storeMap).length === 0) {
        return { code: 400, message: "No branch has a RetailPilot ID. Set it in Branch Master before syncing." };
      }
      const rows = await this.spectra.queryAll(buildDebitNoteQuery(lookback));
      const mapped = mapDebitNotes(rows, storeMap);
      const skipped = mapped.skipped;
      const readCount = mapped.debitNotes.length + mapped.skipped.length;
      const debitNotes = await this._withoutRefnoClashes(mapped.debitNotes, skipped);

      const warnings = [];
      const unrated = debitNotes.filter((d) => d.UNRATED_LINES > 0);
      if (unrated.length) {
        warnings.push(
          `${unrated.length} debit note(s) have lines with no GST rate in RetailPilot, counted at 0%: ${unrated
            .slice(0, 5)
            .map((d) => `${d.MPRH_PR_NO} (${d.UNRATED_LINES} line(s))`)
            .join("; ")}`
        );
      }

      // A number column would turn every slug into 0 and fold the debit
      // notes into one row: refuse rather than write that.
      if (!dryRun && typeof this.debitNoteRepo.prNoHoldsText === "function" && !(await this.debitNoteRepo.prNoHoldsText())) {
        const schema = await this.debitNoteRepo.describeForRetailPilot().catch(() => "");
        return {
          code: 500,
          message: `debit_note.mprh_pr_no cannot hold RetailPilot's REC-... numbers, so nothing was saved. Run the database migrations. ${schema}`.trim(),
        };
      }

      const counts = { inserted: 0, updated: 0, unchanged: 0, approved: 0, kept: 0 };
      const notes = [];
      for (const d of debitNotes) {
        let r;
        try {
          r = dryRun
            ? await this.debitNoteRepo.previewRetailPilotDebitNote(d)
            : await this.debitNoteRepo.upsertRetailPilotDebitNote(d);
        } catch (err) {
          // Another unique key on debit_note (they differ by environment)
          // refused this one: report it and carry on with the rest.
          if (err && (err.code === "ER_DUP_ENTRY" || /^ER_(TRUNCATED|WARN_DATA|DATA_TOO_LONG|BAD_NULL|NO_DEFAULT)/.test(err.code || ""))) {
            skipped.push({
              recon_slug: d.MPRH_PR_NO,
              reason: `the database refused it${err.code === "ER_DUP_ENTRY" ? " as a duplicate" : ""}: ${err.sqlMessage || err.message}`,
            });
            continue;
          }
          throw err;
        }
        counts[r.action] += 1;
        notes.push({
          recon_slug: d.MPRH_PR_NO,
          refno: d.MPRH_PR_REFNO,
          outlet: d.STORE_ID,
          supplier_name: d.SUPPLIER_NAME,
          date: d.MPRH_PR_DT,
          amount: d.TOT_ITEM_VALUE,
          discrepancy_type: d.DISCREPANCY_TYPE,
          purchase_ref: d.PURCHASE_REF,
          action: r.action,
          debit_note_id: r.debit_note_id ?? null,
        });
      }

      // What was written must be findable again by its slug. When it is not -
      // a column that cannot hold "REC-...", say - the run says so, with the
      // table as this database has it, rather than reporting rows it lost.
      const processed = counts.inserted + counts.updated + counts.unchanged + counts.approved + counts.kept;
      if (!dryRun && processed && typeof this.debitNoteRepo.countRetailPilotSlugs === "function") {
        const found = await this.debitNoteRepo.countRetailPilotSlugs(notes.map((n) => n.recon_slug));
        if (found < processed) {
          const schema = await this.debitNoteRepo.describeForRetailPilot().catch((e) => `(could not read: ${e.message})`);
          warnings.push(`Only ${found} of ${processed} debit notes can be found in debit_note after saving - ${schema}`);
        }
      }

      if (skipped.length) {
        warnings.unshift(
          `${skipped.length} debit note(s) skipped: ${skipped.slice(0, 5).map((s) => `${s.recon_slug} (${s.reason})`).join("; ")}`
        );
      }

      const summary =
        `${dryRun ? "Dry run: " : ""}${readCount} read from RetailPilot - ` +
        `${counts.inserted} new, ${counts.updated} updated, ${counts.unchanged} unchanged, ` +
        `${counts.approved} approved (not touched), ${counts.kept} kept for Accounts, ${skipped.length} skipped` +
        (warnings.length ? `. ${warnings.join(" | ")}` : "");

      return {
        code: 200,
        msg: summary.slice(0, 1000),
        ...(dryRun ? { dry_run: true } : {}),
        days: lookback,
        row_count: processed,
        inserted: counts.inserted,
        updated: counts.updated,
        unchanged: counts.unchanged,
        approved_untouched: counts.approved,
        // Saved by Accounts on the Debit Note screen and changed in
        // RetailPilot since: Accounts' version is kept - check which is right.
        kept_for_accounts: counts.kept,
        debit_notes: notes,
        ...(dryRun ? { payloads: debitNotes } : {}),
        skipped,
        warnings,
      };
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.RETAILPILOT_DEBIT_NOTE_SYNC",
        code: "USECASE.RETAILPILOT_DEBIT_NOTE_SYNC.RUN",
        description: err.toString(),
        category: "",
        ref: { days: lookback },
      });
      throw err;
    } finally {
      this.running = false;
    }
  }
}

module.exports = (spectra, debitNoteRepo, config, loadStoreMap) =>
  new RetailPilotDebitNoteSync(spectra, debitNoteRepo, config, loadStoreMap);
