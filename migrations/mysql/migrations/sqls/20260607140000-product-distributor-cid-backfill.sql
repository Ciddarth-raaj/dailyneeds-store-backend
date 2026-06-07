-- Backfill cid from medishop bridge: mdm_dist_code -> medishopdb_MED_DISTRIBUTOR_MAST.cid
UPDATE `dailyneeds-store`.`product_distributor` pd
INNER JOIN `dailyneeds_gofrugal_sync`.`medishopdb_MED_DISTRIBUTOR_MAST` gf
  ON TRIM(CAST(gf.MDM_DIST_CODE AS CHAR)) = TRIM(CAST(pd.mdm_dist_code AS CHAR))
SET pd.cid = TRIM(gf.cid)
WHERE (pd.cid IS NULL OR TRIM(pd.cid) = '')
  AND gf.cid IS NOT NULL
  AND TRIM(gf.cid) <> '';
