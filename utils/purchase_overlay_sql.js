/** Purchase header columns overlaid from updated_purchase when present. */
const PURCHASE_OVERLAY_COLUMNS = [
  "retail_outlet_id",
  "supplier_id",
  "supplier_name",
  "supplier_gstn",
  "mmh_mrc_no",
  "mmh_mrc_dt",
  "mmh_mrc_amt",
  "mmh_dist_bill_dt",
  "mmh_dist_bill_no",
  "mmh_manual_disc",
  "tot_sgst_amt",
  "tot_cgst_amt",
  "tot_igst_amt",
  "tot_gst_cess_amt",
  "mmd_goods_tcs_amt",
  "ts",
  "sgst",
  "cgst",
  "igst",
  "cess",
];

const INTERNAL_OVERLAY_COLUMNS = [
  "cash_discount",
  "scheme_difference",
  "cost_difference",
  "due",
  "freight_charges",
  "round_off",
  "jv_ledger",
  "narration",
  "supplier_credit_note",
  "total_amount",
  "invoice_amount",
];

function coalescePurchaseCol(col) {
  return `COALESCE(up.${col}, p.${col}) AS ${col}`;
}

function coalesceInternalCol(col) {
  return `COALESCE(upi.${col}, pi.${col}) AS ${col}`;
}

function purchaseOverlaySelectList() {
  return [
    "p.purchase_id",
    "p.mmh_mrc_refno",
    "p.created_at",
    "p.is_approved",
    "(p.has_updated = 1 OR up.purchase_id IS NOT NULL) AS has_updated",
    "COALESCE(up.updated_at, p.updated_at) AS updated_at",
    ...PURCHASE_OVERLAY_COLUMNS.map(coalescePurchaseCol),
    ...INTERNAL_OVERLAY_COLUMNS.map(coalesceInternalCol),
  ].join(",\n          ");
}

function purchaseOverlayJoins(pAlias = "p") {
  const idExpr = `${pAlias}.purchase_id`;
  return `LEFT JOIN updated_purchase up ON up.purchase_id = ${idExpr}
        LEFT JOIN purchase_internal pi ON pi.purchase_id = ${idExpr}
        LEFT JOIN updated_purchase_internal upi ON upi.purchase_id = ${idExpr}`;
}

function mergedCol(col, pAlias = "p") {
  return `COALESCE(up.${col}, ${pAlias}.${col})`;
}

function mergedDateExpr(col, pAlias = "p") {
  return `DATE(COALESCE(up.${col}, ${pAlias}.${col}))`;
}

module.exports = {
  PURCHASE_OVERLAY_COLUMNS,
  INTERNAL_OVERLAY_COLUMNS,
  purchaseOverlaySelectList,
  purchaseOverlayJoins,
  mergedCol,
  mergedDateExpr,
};
