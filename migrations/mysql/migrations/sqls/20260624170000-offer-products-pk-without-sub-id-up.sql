-- Merge duplicate offer_products rows that share the same offer, product, and outlet
-- but differ by mosp_sub_id. Keep the row with the highest tsid.
DELETE op
FROM `offer_products` op
INNER JOIN `offer_products` op2
  ON op.mosp_offer_id = op2.mosp_offer_id
 AND op.mosp_item_code = op2.mosp_item_code
 AND op.retail_outlet_id = op2.retail_outlet_id
 AND (
   COALESCE(op.tsid, -1) < COALESCE(op2.tsid, -1)
   OR (
     COALESCE(op.tsid, -1) = COALESCE(op2.tsid, -1)
     AND op.mosp_sub_id < op2.mosp_sub_id
   )
 );

ALTER TABLE `offer_products`
  DROP PRIMARY KEY,
  ADD PRIMARY KEY (`mosp_offer_id`, `mosp_item_code`, `retail_outlet_id`);
