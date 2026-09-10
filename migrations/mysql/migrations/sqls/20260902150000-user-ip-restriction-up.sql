-- Static IP restriction: a user with entries here can only sign in, and keep
-- using an existing session, from those addresses. An empty value means the
-- user is unrestricted, so existing accounts keep working unchanged.
--
-- Entries are comma separated and may be an exact IPv4/IPv6 address, a CIDR
-- block (203.0.113.0/24), a wildcard (203.0.113.*) or a last-octet range
-- (203.0.113.10-20).
ALTER TABLE `user` ADD COLUMN `allowed_ips` VARCHAR(1000) NULL DEFAULT NULL AFTER `user_type`;

INSERT INTO `all_permissions` (`permission_key`) VALUES ('manage_ip_restrictions');
