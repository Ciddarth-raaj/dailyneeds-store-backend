ALTER TABLE `offer_products`
  DROP PRIMARY KEY,
  ADD PRIMARY KEY (`mosp_offer_id`, `mosp_sub_id`, `mosp_item_code`, `retail_outlet_id`);
