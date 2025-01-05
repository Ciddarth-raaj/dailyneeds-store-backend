CREATE TABLE accounts (
    accounts_id INT AUTO_INCREMENT PRIMARY KEY,
    date DATETIME NOT NULL,
    total_sales DECIMAL(10, 2) NOT NULL,
    cash_handover_1 INT DEFAULT 0,
    cash_handover_2 INT DEFAULT 0,
    cash_handover_5 INT DEFAULT 0,
    cash_handover_10 INT DEFAULT 0,
    cash_handover_20 INT DEFAULT 0,
    cash_handover_50 INT DEFAULT 0,
    cash_handover_100 INT DEFAULT 0,
    cash_handover_200 INT DEFAULT 0,
    cash_handover_500 INT DEFAULT 0,
    card_sales DECIMAL(10, 2) NOT NULL,
    loyalty DECIMAL(10, 2) NOT NULL,
    sales_return DECIMAL(10, 2) NOT NULL,
    cashier_id INT NOT NULL,
    user_id INT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE accounts_sales (
    sales_id INT AUTO_INCREMENT PRIMARY KEY,
    accounts_id INT,
    person_type INT NOT NULL,
    payment_type INT NOT NULL,
    person_id INT NOT NULL,
    description VARCHAR(255) NOT NULL,
    amount DECIMAL(10, 2) NOT NULL,
    receipt_path VARCHAR(255) NOT NULL,
    FOREIGN KEY (accounts_id) REFERENCES accounts(accounts_id) ON DELETE CASCADE
);