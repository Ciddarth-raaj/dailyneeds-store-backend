-- STO listing (/sto) - READ-ONLY evidence for the proposed indexes.
--
-- Nothing here writes. Run the GOFRUGAL section against the GoFrugal sync
-- database (config db.mysql_gofrugal) and the APP section against the main
-- application database (config db.mysql). Paste the output back before any
-- index is added.
--
--   mysql -h <gofrugal-host> -u <user> -p <gofrugal-db> < sto-listing-plan.sql   (GOFRUGAL part)
--
-- Change the dates below to a recent, busy day / month.

-- ============================================================ GOFRUGAL ====

-- 1. Are the two "Vw_" objects real tables (index them directly) or views
--    (index the SOURCE table named in the view definition instead)?
SHOW FULL TABLES LIKE 'medishopdb_Vw_StockTransferOut%';
-- If Table_type = VIEW:
--   SHOW CREATE VIEW medishopdb_Vw_StockTransferOut_hdr\G
--   SHOW CREATE VIEW medishopdb_Vw_StockTransferOut_dtl\G

-- 2. Column types (DN_date must be DATE/DATETIME for the range to be sargable)
--    and existing indexes.
SHOW CREATE TABLE medishopdb_Vw_StockTransferOut_hdr\G
SHOW CREATE TABLE medishopdb_Vw_StockTransferOut_dtl\G
SHOW INDEX FROM medishopdb_Vw_StockTransferOut_hdr;
SHOW INDEX FROM medishopdb_Vw_StockTransferOut_dtl;

-- 3. Volumes.
SELECT COUNT(*) AS hdr_rows, MIN(DN_date) AS first_sto, MAX(DN_date) AS last_sto
FROM medishopdb_Vw_StockTransferOut_hdr;
SELECT COUNT(*) AS dtl_rows FROM medishopdb_Vw_StockTransferOut_dtl;

-- 4. OLD day query (DATE() wrapper - cannot use an index on DN_date).
EXPLAIN SELECT * FROM medishopdb_Vw_StockTransferOut_hdr
WHERE DATE(`Dn_Date`) >= DATE('2026-09-15') AND DATE(`Dn_Date`) <= DATE('2026-09-15')
ORDER BY Dn_no DESC;

-- 5. NEW day query and NEW calendar query (bare column, half-open range).
EXPLAIN SELECT * FROM medishopdb_Vw_StockTransferOut_hdr
WHERE `Dn_Date` >= '2026-09-15' AND `Dn_Date` < '2026-09-16'
ORDER BY Dn_no DESC;
EXPLAIN SELECT DATE_FORMAT(`Dn_Date`, '%Y-%m-%d') AS date, Dn_Ref_no
FROM medishopdb_Vw_StockTransferOut_hdr
WHERE `Dn_Date` >= '2026-09-01' AND `Dn_Date` < '2026-10-01';

-- 6. Detail lines for a batch of Dn_no (needs an index whose first column is Dn_no).
EXPLAIN SELECT * FROM medishopdb_Vw_StockTransferOut_dtl
WHERE Dn_no IN (SELECT * FROM (SELECT Dn_no FROM medishopdb_Vw_StockTransferOut_hdr ORDER BY Dn_no DESC LIMIT 30) t)
ORDER BY Dn_no, Dn_sl_no;

-- 7. Lookups by Dn_no / Dn_Ref_no (View / Edit).
EXPLAIN SELECT * FROM medishopdb_Vw_StockTransferOut_hdr WHERE Dn_no = 1;
EXPLAIN SELECT * FROM medishopdb_Vw_StockTransferOut_hdr WHERE Dn_Ref_no = 1 ORDER BY Dn_no DESC;

-- ================================================================= APP ====
-- (run against the application database)
--
-- SHOW INDEX FROM sto_check;      -- expect PRIMARY (dn_ref_no, product_id)
-- EXPLAIN SELECT DISTINCT dn_ref_no FROM sto_check WHERE dn_ref_no IN (1, 2, 3);
-- SELECT COUNT(*) FROM outlets;   -- small master: gofrugal_id needs no index
-- EXPLAIN SELECT * FROM outlets WHERE gofrugal_id IN ('1', '2') ORDER BY outlet_id;
