-- `allow_outside_access` was the first release's two-state switch. The
-- three-way `ip_policy` replaced it (20260902170000) and nothing has read or
-- written this column since; it was kept for one release only so the
-- deploy's migrate-then-reload gap could not break logins on the old code.
ALTER TABLE `user` DROP COLUMN `allow_outside_access`;
