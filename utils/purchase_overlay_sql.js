/** Purchase columns overlaid from gst_tally_purchase when pushed to Tally (via purchase_tally_response). */

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

function coalescePurchaseCol(col, pAlias = "p") {
  return `COALESCE(g.${col}, ${pAlias}.${col}) AS ${col}`;
}

function coalesceInternalCol(col) {
  return `COALESCE(gi.${col}, pi.${col}) AS ${col}`;
}

function purchaseOverlaySelectList(pAlias = "p") {
  return [
    `${pAlias}.purchase_id`,
    `${pAlias}.mmh_mrc_refno`,
    `${pAlias}.created_at`,
    `${pAlias}.is_approved`,
    `(${pAlias}.has_updated = 1 OR g.gst_tally_purchase_id IS NOT NULL) AS has_updated`,
    `COALESCE(g.updated_at, ${pAlias}.updated_at) AS updated_at`,
    ...PURCHASE_OVERLAY_COLUMNS.map((col) => coalescePurchaseCol(col, pAlias)),
    ...INTERNAL_OVERLAY_COLUMNS.map(coalesceInternalCol),
  ].join(",\n          ");
}

function purchaseOverlayJoins(pAlias = "p") {
  const idExpr = `${pAlias}.purchase_id`;
  return `LEFT JOIN purchase_internal pi ON pi.purchase_id = ${idExpr}
        LEFT JOIN purchase_tally_response tr ON tr.purchase_id = ${idExpr}
        LEFT JOIN gst_tally_purchase g ON g.master_id = tr.MasterID
        LEFT JOIN gst_tally_purchase_internal gi ON gi.gst_tally_purchase_id = g.gst_tally_purchase_id`;
}

function mergedCol(col, pAlias = "p") {
  if (INTERNAL_OVERLAY_COLUMNS.includes(col)) {
    return `COALESCE(gi.${col}, pi.${col})`;
  }
  return `COALESCE(g.${col}, ${pAlias}.${col})`;
}

function mergedDateExpr(col, pAlias = "p") {
  return `DATE(COALESCE(g.${col}, ${pAlias}.${col}))`;
}

module.exports = {
  PURCHASE_OVERLAY_COLUMNS,
  INTERNAL_OVERLAY_COLUMNS,
  purchaseOverlaySelectList,
  purchaseOverlayJoins,
  mergedCol,
  mergedDateExpr,
};
