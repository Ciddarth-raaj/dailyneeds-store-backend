/** Half CGST/SGST rate for legacy 28% local purchase (stored as 14). */
const LEGACY_HALF_GST_PERC = 14;
/** Half CGST/SGST rate for merged 40% local purchase (28% GST + 12% cess). */
const MERGED_HALF_GST_PERC = 20;
const CESS_PERC = 12;

function round2(value) {
  const n = parseFloat(value);
  if (!Number.isFinite(n)) {
    return 0;
  }
  return parseFloat(n.toFixed(2));
}

function taxValue(taxable, perc) {
  return round2((parseFloat(taxable) * parseFloat(perc)) / 100);
}

function sumTaxValues(arr) {
  return round2(
    (arr || []).reduce((sum, item) => sum + (parseFloat(item.VALUE) || 0), 0)
  );
}

function findTaxEntry(arr, perc, taxable = null) {
  return (arr || []).find((entry) => {
    if (Number(entry.PERC) !== perc) {
      return false;
    }
    if (taxable == null || taxable === "") {
      return true;
    }
    return Number(entry.TAXABLE) === Number(taxable);
  });
}

function removeTaxEntry(arr, perc, taxable = null) {
  const index = (arr || []).findIndex((entry) => {
    if (Number(entry.PERC) !== perc) {
      return false;
    }
    if (taxable == null || taxable === "") {
      return true;
    }
    return Number(entry.TAXABLE) === Number(taxable);
  });
  if (index >= 0) {
    arr.splice(index, 1);
  }
}

function upsertHalfRateEntry(arr, taxable, value) {
  const existing = findTaxEntry(arr, MERGED_HALF_GST_PERC, taxable);
  if (existing) {
    existing.TAXABLE = taxable;
    existing.VALUE = value;
    return;
  }
  arr.push({
    PERC: MERGED_HALF_GST_PERC,
    TAXABLE: taxable,
    VALUE: value,
  });
}

function findMatchingCessEntry(cess, taxable) {
  const byTaxable = findTaxEntry(cess, CESS_PERC, taxable);
  if (byTaxable && parseFloat(byTaxable.VALUE)) {
    return byTaxable;
  }

  const withValue = (cess || []).filter(
    (entry) => Number(entry.PERC) === CESS_PERC && parseFloat(entry.VALUE) > 0
  );
  if (withValue.length === 1) {
    return withValue[0];
  }

  return null;
}

/**
 * Merge legacy 14% CGST/SGST (28% local purchase) + 12% cess into 20% CGST/SGST (40% local purchase).
 * Clears merged cess rows and recalculates tax totals.
 */
function normalizePurchaseTaxArrays(purchase) {
  if (!purchase) {
    return purchase;
  }

  const sgst = [...(purchase.sgst || [])];
  const cgst = [...(purchase.cgst || [])];
  const cess = [...(purchase.cess || [])];

  const legacySgstEntries = sgst.filter(
    (entry) =>
      Number(entry.PERC) === LEGACY_HALF_GST_PERC &&
      entry.TAXABLE != null &&
      entry.TAXABLE !== ""
  );

  for (const sgstEntry of legacySgstEntries) {
    const taxable = sgstEntry.TAXABLE;
    const cgstEntry = findTaxEntry(cgst, LEGACY_HALF_GST_PERC, taxable);
    const cessEntry = findMatchingCessEntry(cess, taxable);

    if (!cgstEntry || !cessEntry) {
      continue;
    }

    const mergedValue = taxValue(taxable, MERGED_HALF_GST_PERC);
    upsertHalfRateEntry(sgst, taxable, mergedValue);
    upsertHalfRateEntry(cgst, taxable, mergedValue);

    removeTaxEntry(sgst, LEGACY_HALF_GST_PERC, taxable);
    removeTaxEntry(cgst, LEGACY_HALF_GST_PERC, taxable);
    removeTaxEntry(cess, CESS_PERC, cessEntry.TAXABLE);
  }

  purchase.sgst = sgst;
  purchase.cgst = cgst;
  purchase.igst = purchase.igst || [];
  purchase.cess = cess;
  purchase.tot_sgst_amt = sumTaxValues(sgst);
  purchase.tot_cgst_amt = sumTaxValues(cgst);
  purchase.tot_igst_amt = sumTaxValues(purchase.igst);
  purchase.tot_gst_cess_amt = sumTaxValues(cess);

  return purchase;
}

module.exports = {
  LEGACY_HALF_GST_PERC,
  MERGED_HALF_GST_PERC,
  CESS_PERC,
  normalizePurchaseTaxArrays,
};
