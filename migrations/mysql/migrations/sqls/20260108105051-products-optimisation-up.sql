CREATE INDEX idx_product_online_id 
ON product_table (gf_applies_online, product_id DESC);

CREATE INDEX idx_product_images_product 
ON product_images (product_id);