-- Reverses 20260909180000-c2-ifsc-master.
--
-- Dropping this table loses only cached public reference data: every row can
-- be fetched from the provider again. No employee data lives here, so there
-- is nothing to preserve and nothing to migrate back.
--
-- The cost of a down is therefore money rather than data: the next lookup of
-- each IFSC pays the provider once more.

DROP TABLE IF EXISTS `ifsc_master`;
