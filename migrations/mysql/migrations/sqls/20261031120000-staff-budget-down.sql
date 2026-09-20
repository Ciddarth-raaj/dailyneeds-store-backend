-- Reverses 20261031120000-staff-budget-up.sql.
--
-- History first, then the rates, then the budget: `staff_budget_history`
-- holds the FK onto `staff_budget`.
DROP TABLE IF EXISTS `staff_budget_history`;
DROP TABLE IF EXISTS `staff_budget_rate`;
DROP TABLE IF EXISTS `staff_budget`;
