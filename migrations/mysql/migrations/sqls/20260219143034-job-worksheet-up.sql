INSERT INTO `all_permissions` (`permission_key`) VALUES ('view_job_worksheet');
INSERT INTO `all_permissions` (`permission_key`) VALUES ('view_sticker_types');
INSERT INTO `all_permissions` (`permission_key`) VALUES ('add_sticker_types');
INSERT INTO `all_permissions` (`permission_key`) VALUES ('add_job_worksheet');

-- Sticker Types Table
CREATE TABLE sticker_types (
    sticker_id INT AUTO_INCREMENT PRIMARY KEY,
    label VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE INDEX idx_sticker_types_label ON sticker_types(label);

-- Job Worksheet Table
CREATE TABLE job_worksheet (
    job_worksheet_id INT AUTO_INCREMENT PRIMARY KEY,
    grn_no VARCHAR(255) NOT NULL,
    date DATE NOT NULL,
    supplier_id VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Job Worksheet Items Table
CREATE TABLE job_worksheet_item (
    job_worksheet_item_id INT AUTO_INCREMENT PRIMARY KEY,
    job_worksheet_id INT NOT NULL,
    product_id INT NOT NULL,
    qty INT NOT NULL DEFAULT 0,
    mrp DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    material_type VARCHAR(255) NULL,
    sticker_type_1 INT NULL,
    sticker_type_2 INT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'open',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (job_worksheet_id) REFERENCES job_worksheet(job_worksheet_id) ON DELETE CASCADE,
    FOREIGN KEY (product_id) REFERENCES product_table(product_id) ON DELETE RESTRICT,
    FOREIGN KEY (sticker_type_1) REFERENCES sticker_types(sticker_id) ON DELETE SET NULL,
    FOREIGN KEY (sticker_type_2) REFERENCES sticker_types(sticker_id) ON DELETE SET NULL
);

-- Indexes
CREATE INDEX idx_job_worksheet_grn_no ON job_worksheet(grn_no);
CREATE INDEX idx_job_worksheet_date ON job_worksheet(date);
CREATE INDEX idx_job_worksheet_supplier_id ON job_worksheet(supplier_id);
CREATE INDEX idx_job_worksheet_item_job_worksheet_id ON job_worksheet_item(job_worksheet_id);
CREATE INDEX idx_job_worksheet_item_product_id ON job_worksheet_item(product_id);
CREATE INDEX idx_job_worksheet_item_status ON job_worksheet_item(job_worksheet_id, status);
