-- Create the tickets table
CREATE TABLE tickets (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    status ENUM('open', 'in_progress', 'closed') DEFAULT 'open',
    priority ENUM('low', 'medium', 'high', 'urgent') DEFAULT 'medium',
    created_by INT(11) NOT NULL,
    assigned_to INT(11),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Add indexes for better performance
CREATE INDEX idx_status ON tickets(status);
CREATE INDEX idx_assigned_to ON tickets(assigned_to);
CREATE INDEX idx_created_by ON tickets(created_by);

CREATE TABLE ticket_images (
    image_id BIGINT PRIMARY KEY AUTO_INCREMENT,
    ticket_id BIGINT NOT NULL,
    s3_url VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
);

ALTER TABLE outlets
ADD COLUMN telegram_chat_id BIGINT NULL;

ALTER TABLE tickets
ADD COLUMN outlet_id INT NULL AFTER priority;

CREATE TABLE telegram_departments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    department VARCHAR(100) NOT NULL UNIQUE,
    telegram_chat_id BIGINT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE tickets 
ADD COLUMN department_id INT NULL 
AFTER assigned_to,
ADD FOREIGN KEY (department_id) 
REFERENCES telegram_departments(id);