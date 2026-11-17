-- =====================================================================
-- Invoice pipeline page (/dashboard/invoice-pipeline, GET /warehouse-flow/*):
-- the permission key, and nothing else. DECLARED here and granted to NOBODY:
-- administrators hold it through the user_type 2 bypass, and a designation
-- gets it only when somebody grants it on the Designation screen. It opens
-- the pipeline alone - not the Business Dashboard's sales and margin. Which
-- branches a holder sees is the shared dashboard store scope (Own Store /
-- All Stores), granted alongside it.
-- =====================================================================
INSERT INTO `all_permissions` (`permission_key`)
  SELECT 'view_invoice_pipeline' FROM DUAL
   WHERE NOT EXISTS (SELECT 1 FROM `all_permissions`
                      WHERE `permission_key` = 'view_invoice_pipeline');
