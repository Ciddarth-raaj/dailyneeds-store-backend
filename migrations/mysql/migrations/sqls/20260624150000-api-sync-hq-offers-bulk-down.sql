DELETE FROM api_sync_cron_config WHERE log_type IN (
  'hq_offers_hdr_bulk',
  'hq_offers_products_bulk',
  'hq_offers_issue_bulk'
);
