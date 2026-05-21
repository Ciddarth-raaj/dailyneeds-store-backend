-- Backfill gst_tally_purchase from purchases already pushed to Tally (purchase_tally_response).
INSERT INTO gst_tally_purchase (
  master_id,
  retail_outlet_id,
  supplier_id,
  supplier_name,
  supplier_gstn,
  mmh_mrc_no,
  mmh_mrc_dt,
  mmh_mrc_amt,
  mmh_dist_bill_dt,
  mmh_dist_bill_no,
  mmh_mrc_refno,
  mmh_manual_disc,
  tot_sgst_amt,
  tot_cgst_amt,
  tot_igst_amt,
  tot_gst_cess_amt,
  mmd_goods_tcs_amt,
  ts,
  sgst,
  cgst,
  igst,
  cess
)
SELECT
  tr.MasterID,
  p.retail_outlet_id,
  p.supplier_id,
  p.supplier_name,
  p.supplier_gstn,
  p.mmh_mrc_no,
  p.mmh_mrc_dt,
  p.mmh_mrc_amt,
  p.mmh_dist_bill_dt,
  p.mmh_dist_bill_no,
  p.mmh_mrc_refno,
  p.mmh_manual_disc,
  p.tot_sgst_amt,
  p.tot_cgst_amt,
  p.tot_igst_amt,
  p.tot_gst_cess_amt,
  p.mmd_goods_tcs_amt,
  p.ts,
  p.sgst,
  p.cgst,
  p.igst,
  p.cess
FROM purchase_tally_response tr
INNER JOIN purchase p ON p.purchase_id = tr.purchase_id
ON DUPLICATE KEY UPDATE
  retail_outlet_id = VALUES(retail_outlet_id),
  supplier_id = VALUES(supplier_id),
  supplier_name = VALUES(supplier_name),
  supplier_gstn = VALUES(supplier_gstn),
  mmh_mrc_no = VALUES(mmh_mrc_no),
  mmh_mrc_dt = VALUES(mmh_mrc_dt),
  mmh_mrc_amt = VALUES(mmh_mrc_amt),
  mmh_dist_bill_dt = VALUES(mmh_dist_bill_dt),
  mmh_dist_bill_no = VALUES(mmh_dist_bill_no),
  mmh_mrc_refno = VALUES(mmh_mrc_refno),
  mmh_manual_disc = VALUES(mmh_manual_disc),
  tot_sgst_amt = VALUES(tot_sgst_amt),
  tot_cgst_amt = VALUES(tot_cgst_amt),
  tot_igst_amt = VALUES(tot_igst_amt),
  tot_gst_cess_amt = VALUES(tot_gst_cess_amt),
  mmd_goods_tcs_amt = VALUES(mmd_goods_tcs_amt),
  ts = VALUES(ts),
  sgst = VALUES(sgst),
  cgst = VALUES(cgst),
  igst = VALUES(igst),
  cess = VALUES(cess),
  updated_at = CURRENT_TIMESTAMP;

INSERT INTO gst_tally_purchase_internal (
  gst_tally_purchase_id,
  cash_discount,
  scheme_difference,
  cost_difference,
  due,
  freight_charges,
  round_off,
  jv_ledger,
  narration,
  supplier_credit_note,
  total_amount,
  invoice_amount
)
SELECT
  g.gst_tally_purchase_id,
  COALESCE(pi.cash_discount, 0),
  COALESCE(pi.scheme_difference, 0),
  COALESCE(pi.cost_difference, 0),
  COALESCE(pi.due, 0),
  COALESCE(pi.freight_charges, 0),
  COALESCE(pi.round_off, 0),
  pi.jv_ledger,
  pi.narration,
  COALESCE(pi.supplier_credit_note, 0),
  COALESCE(pi.total_amount, 0),
  COALESCE(pi.invoice_amount, 0)
FROM purchase_tally_response tr
INNER JOIN purchase p ON p.purchase_id = tr.purchase_id
INNER JOIN gst_tally_purchase g ON g.master_id = tr.MasterID
LEFT JOIN purchase_internal pi ON pi.purchase_id = p.purchase_id
ON DUPLICATE KEY UPDATE
  cash_discount = VALUES(cash_discount),
  scheme_difference = VALUES(scheme_difference),
  cost_difference = VALUES(cost_difference),
  due = VALUES(due),
  freight_charges = VALUES(freight_charges),
  round_off = VALUES(round_off),
  jv_ledger = VALUES(jv_ledger),
  narration = VALUES(narration),
  supplier_credit_note = VALUES(supplier_credit_note),
  total_amount = VALUES(total_amount),
  invoice_amount = VALUES(invoice_amount);

DROP TABLE IF EXISTS updated_purchase_internal;
DROP TABLE IF EXISTS updated_purchase;
