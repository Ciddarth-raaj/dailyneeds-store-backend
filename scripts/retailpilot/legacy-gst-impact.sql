-- scripts/retailpilot/legacy-gst-impact.sql - run against production by an operator:
--   mysql <db> < scripts/retailpilot/legacy-gst-impact.sql
-- READ-ONLY. GoFrugal purchases (no retailpilot_source; on today's schema
-- every purchase row is GoFrugal) against the new GST rules in
-- utils/purchase_discrepancy.js. Every statement is a SELECT.
--
-- With this release these findings are shown for REVIEW on GoFrugal bills
-- and never block their approval; this measures how many bills would show
-- one, by kind and status. "nz" = a non-zero TAXABLE or VALUE in a tax line.
SELECT supplier_kind, finding, status, COUNT(*) AS purchases,
       MIN(mmh_mrc_dt) AS first_date, MAX(mmh_mrc_dt) AS last_date
FROM (
  SELECT p.purchase_id, p.mmh_mrc_dt,
    CASE WHEN TRIM(IFNULL(p.supplier_gstn,'')) IN ('','0') THEN 'unregistered (blank GSTIN)'
         WHEN UPPER(TRIM(p.supplier_gstn)) NOT REGEXP '^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$' THEN 'malformed GSTIN'
         WHEN TRIM(p.supplier_gstn) LIKE '34%' THEN 'registered, Puducherry'
         ELSE 'registered, other state' END AS supplier_kind,
    CASE
      WHEN TRIM(IFNULL(p.supplier_gstn,'')) IN ('','0')
       AND (IFNULL(p.tot_igst_amt,0) <> 0 OR IFNULL(p.tot_cgst_amt,0) <> 0 OR IFNULL(p.tot_sgst_amt,0) <> 0)
        THEN 'UNREGISTERED_SUPPLIER_TAX'
      WHEN TRIM(IFNULL(p.supplier_gstn,'')) IN ('','0')
       AND CAST(p.igst AS CHAR) REGEXP '"(TAXABLE|VALUE)": "?-?(0*[1-9]|0*\\.0*[1-9])'
        THEN 'TAX_TYPE_MISMATCH (IGST lines, no GSTIN)'
      WHEN TRIM(IFNULL(p.supplier_gstn,'')) NOT IN ('','0') AND TRIM(p.supplier_gstn) NOT LIKE '34%'
       AND (CAST(p.cgst AS CHAR) REGEXP '"(TAXABLE|VALUE)": "?-?(0*[1-9]|0*\\.0*[1-9])'
         OR CAST(p.sgst AS CHAR) REGEXP '"(TAXABLE|VALUE)": "?-?(0*[1-9]|0*\\.0*[1-9])')
        THEN 'TAX_TYPE_MISMATCH (CGST/SGST, other-state GSTIN)'
      WHEN TRIM(p.supplier_gstn) LIKE '34%'
       AND CAST(p.igst AS CHAR) REGEXP '"(TAXABLE|VALUE)": "?-?(0*[1-9]|0*\\.0*[1-9])'
        THEN 'TAX_TYPE_MISMATCH (IGST, Puducherry GSTIN)'
      ELSE 'none' END AS finding,
    CASE WHEN tr.purchase_id IS NOT NULL THEN 'pushed to Tally'
         WHEN p.is_approved = 1 THEN 'approved, not pushed'
         ELSE 'pending approval' END AS status
  FROM purchase p
  LEFT JOIN purchase_tally_response tr ON tr.purchase_id = p.purchase_id
) x
GROUP BY supplier_kind, finding, status
ORDER BY finding = 'none', finding, supplier_kind, status;
