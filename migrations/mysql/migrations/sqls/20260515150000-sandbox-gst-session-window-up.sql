ALTER TABLE sandbox_gst_taxpayer_session
  ADD COLUMN last_otp_verified_at_ms BIGINT UNSIGNED NULL COMMENT 'Epoch ms of last successful OTP verify' AFTER token_expires_at_ms,
  ADD COLUMN session_expires_at_ms BIGINT UNSIGNED NULL COMMENT 'Epoch ms when 30-day GST portal session ends' AFTER last_otp_verified_at_ms;
