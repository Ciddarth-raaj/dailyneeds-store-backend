-- Telegram-based password reset.
--
-- A user who has forgotten their password cannot prove who they are with a
-- token, so the proof moves to Telegram: they link their Telegram account
-- while signed in, and the reset code is delivered to that chat.

-- The chat the bot can reach one user on. Written by the update poller when
-- a user opens their personal deep link, never typed in by hand — a username
-- is not proof of anything, a chat_id the bot itself observed is.
--
-- chat_id is unique: one Telegram account receives reset codes for at most
-- one login, so a single compromised phone cannot open several accounts.
-- Someone who genuinely needs a second login unlinks the first.
CREATE TABLE IF NOT EXISTS telegram_links (
  user_id INT NOT NULL,
  chat_id BIGINT NOT NULL,
  telegram_username VARCHAR(64) NULL DEFAULT NULL,
  linked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  UNIQUE KEY uq_telegram_links_chat_id (chat_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One-shot tokens that back the `t.me/<bot>?start=<token>` deep link. Only
-- the hash is stored: the row is useless to anyone who reads the table.
CREATE TABLE IF NOT EXISTS telegram_link_tokens (
  token_hash CHAR(64) NOT NULL,
  user_id INT NOT NULL,
  expires_at DATETIME NOT NULL,
  consumed_at DATETIME NULL DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (token_hash),
  KEY idx_telegram_link_tokens_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Reset codes, hashed for the same reason. `attempts` caps guessing at a
-- six-digit code, and `consumed_at` makes a code single-use.
CREATE TABLE IF NOT EXISTS password_reset_codes (
  id INT NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  code_hash CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  consumed_at DATETIME NULL DEFAULT NULL,
  attempts INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_password_reset_codes_user (user_id, consumed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
