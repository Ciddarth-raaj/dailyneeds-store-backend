CREATE TABLE material_request (
    material_request_id INT AUTO_INCREMENT PRIMARY KEY,
    created_by INT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE material_request_list (
    material_request_list_id INT AUTO_INCREMENT PRIMARY KEY,
    material_request_id INT NOT NULL,
    material_id INT NOT NULL,
    quantity INT NOT NULL,
    remark VARCHAR(255),
    FOREIGN KEY (material_request_id) REFERENCES material_request(material_request_id)
);