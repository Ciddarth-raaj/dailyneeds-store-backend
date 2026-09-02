DROP TABLE IF EXISTS grn_issue_ignores;

DELETE FROM `all_permissions`
WHERE `permission_key` = 'ignore_grn_issues';
