-- =====================================================================
-- READ-ONLY validation: the two bulk reads the Pending HR dashboard added
--
--   repository/employee_salary.js#getCurrentSalaryStatusMany
--   repository/employee_master.js#getPayrollConfigMany
--
-- Nothing here writes, locks or deletes. Every statement is a SELECT or an
-- EXPLAIN. Safe on production; safer still on a staging restore.
--
-- WHY THIS EXISTS. Both queries are unit-tested against FAKE repositories -
-- the repository layer in this codebase has no test that touches MySQL - so
-- their SQL has been reviewed but never executed. These checks prove the
-- three things review cannot: that the bulk query returns exactly ONE row per
-- employee, that it returns the SAME row the single-employee query would, and
-- that the derived booleans match the column they are derived from.
--
-- HOW TO RUN. Substitute a real id list for :IDS - the application passes the
-- whole active population, so use a few hundred real employee_ids, e.g. the
-- output of section 0. Run top to bottom and keep the output.
--
-- PASS CRITERIA are stated with each section. Any FAIL row is a blocker.
-- =====================================================================

-- ------------------------------------------------------------ 0. the input
-- The population the endpoint actually passes: every employee the directory
-- returns, which is `repository/employee_scope.js#buildEmployeeScope` with no
-- store or designation filter. The predicate below is that clause verbatim.
--
-- NO GROUP_CONCAT HERE, DELIBERATELY. Building the id list inside MySQL means
-- `group_concat_max_len` (1024 bytes by default) can truncate it silently -
-- no error, no warning in a batch client - and the whole validation would
-- then run against a prefix of the population while reporting a clean pass.
-- A validation that can quietly check half the company is worse than none.
-- So section 0 emits ONE ROW PER EMPLOYEE and a SEPARATE count, and the run
-- instructions join them into a list in the shell, where a truncation would
-- show up as a count mismatch before anything else runs.

-- 0a. THE INDEPENDENT COUNT. Derived on its own, not from the list below, so
--     the two can be compared against each other. Record this number.
SELECT COUNT(*) AS directory_population
  FROM `new_employee` ne
 WHERE ne.employee_name NOT IN (SELECT employee_name FROM `resignation`);

-- 0b. THE IDS, one per row. Export with `-N -B`, count the lines, and confirm
--     the count equals 0a BEFORE substituting them for :IDS.
--     STOP THE VALIDATION IF THEY DIFFER - sections 1-6 would then be
--     checking part of the population and passing.
SELECT ne.employee_id
  FROM `new_employee` ne
 WHERE ne.employee_name NOT IN (SELECT employee_name FROM `resignation`)
 ORDER BY ne.employee_id;

-- 0c. ONE WAY 0a AND 0b CAN BOTH BE ZERO, and it is not an empty company.
--     `x NOT IN (subquery)` returns NO ROWS AT ALL if the subquery yields a
--     single NULL - a standard SQL three-valued-logic trap. If `resignation`
--     holds a NULL or empty name, the predicate above excludes everybody.
--
--     THIS IS NOT A BUG IN THE SCRIPT. The application builds the same
--     exclusion from the same unfiltered `SELECT employee_name FROM
--     resignation`, so the same trap would empty the real dashboard. It is
--     reported here so a zero population is recognised for what it is.
--     Informational; a non-zero count is a finding to raise, not a failure of
--     this validation.
SELECT SUM(employee_name IS NULL)                       AS null_names,
       SUM(employee_name IS NOT NULL AND TRIM(employee_name) = '') AS empty_names,
       COUNT(*)                                         AS resignation_rows
  FROM `resignation`;

-- =============== 1. getCurrentSalaryStatusMany: one row per employee ====
-- THE FAN-OUT CHECK, and the one that matters most: a JOIN that duplicated a
-- row would silently double-count an employee in every payroll number on the
-- dashboard.
--
-- PASS: zero rows.
SELECT s.`employee_id`, COUNT(*) AS rows_returned
  FROM `employee_salary` s
 WHERE s.`employee_id` IN (:IDS)
   AND s.`status` = 'APPROVED'
   AND s.`effective_from` <= CURDATE()
   AND s.`salary_id` = (
     SELECT s2.`salary_id`
       FROM `employee_salary` s2
      WHERE s2.`employee_id` = s.`employee_id`
        AND s2.`status` = 'APPROVED'
        AND s2.`effective_from` <= CURDATE()
      ORDER BY s2.`effective_from` DESC, s2.`salary_id` DESC
      LIMIT 1
   )
 GROUP BY s.`employee_id`
HAVING COUNT(*) > 1;

-- ---- 2. …and it is the SAME row the single-employee query would return ---
-- `getCurrentSalary` is `ORDER BY effective_from DESC, salary_id DESC LIMIT 1`
-- per employee. This recomputes that answer independently, with a window
-- function, and compares. If the two ever disagree, the dashboard and the
-- employee's own profile would disagree about whether they are on payroll.
--
-- Requires MySQL 8. On 5.7, skip to section 2b.
--
-- PASS: zero rows.
WITH ranked AS (
  SELECT s.`employee_id`, s.`salary_id`, s.`ctc_status`,
         ROW_NUMBER() OVER (
           PARTITION BY s.`employee_id`
           ORDER BY s.`effective_from` DESC, s.`salary_id` DESC
         ) AS rn
    FROM `employee_salary` s
   WHERE s.`employee_id` IN (:IDS)
     AND s.`status` = 'APPROVED'
     AND s.`effective_from` <= CURDATE()
),
bulk AS (
  SELECT s.`employee_id`, s.`salary_id`, s.`ctc_status`
    FROM `employee_salary` s
   WHERE s.`employee_id` IN (:IDS)
     AND s.`status` = 'APPROVED'
     AND s.`effective_from` <= CURDATE()
     AND s.`salary_id` = (
       SELECT s2.`salary_id` FROM `employee_salary` s2
        WHERE s2.`employee_id` = s.`employee_id`
          AND s2.`status` = 'APPROVED'
          AND s2.`effective_from` <= CURDATE()
        ORDER BY s2.`effective_from` DESC, s2.`salary_id` DESC
        LIMIT 1
     )
)
SELECT COALESCE(r.employee_id, b.employee_id) AS employee_id,
       r.salary_id AS expected_salary_id, b.salary_id AS bulk_salary_id,
       r.ctc_status AS expected_ctc, b.ctc_status AS bulk_ctc
  FROM (SELECT * FROM ranked WHERE rn = 1) r
  LEFT JOIN bulk b ON b.employee_id = r.employee_id
 WHERE b.salary_id IS NULL OR b.salary_id <> r.salary_id
 UNION ALL
SELECT b.employee_id, NULL, b.salary_id, NULL, b.ctc_status
  FROM bulk b
 WHERE NOT EXISTS (SELECT 1 FROM ranked r WHERE r.rn = 1 AND r.employee_id = b.employee_id);

-- 2b. MySQL 5.7 FALLBACK for section 2 - no window functions, no CTE.
--
--     WHAT IT CHECKS. For each employee, the production rule is `ORDER BY
--     effective_from DESC, salary_id DESC LIMIT 1` over their APPROVED rows
--     effective on or before today. This derives the same answer a second
--     way - the highest `salary_id` on the employee's LATEST ELIGIBLE
--     `effective_from` - and compares the two.
--
--     ONLY THE LATEST ELIGIBLE DATE IS EXAMINED, and that is the correction
--     this section needed. An earlier version grouped every duplicated
--     `effective_from` and compared each group's MAX against the one row the
--     production rule picks. An employee with two approved rows on an OLD
--     date and a newer approved row would then be reported as a mismatch -
--     production correctly returns the newer row, which is not the maximum of
--     the older group. That is a false failure on entirely correct data, and
--     on real payroll history it would be the common case rather than an edge
--     one. Historical duplicate dates are irrelevant to the answer and are
--     now ignored.
--
--     EVERY EMPLOYEE IS CHECKED, not only those with a tie: where the latest
--     eligible date holds one row, the expected id is that row, so the
--     comparison still validates the whole per-employee pick and makes this a
--     real substitute for section 2. `rows_at_latest_date` says which ones
--     were actual ties - the case the tie-break exists for.
--
--     PASS: zero rows.
SELECT t.*
  FROM (
    SELECT s.`employee_id`,
           s.`effective_from`      AS latest_eligible_date,
           COUNT(*)                AS rows_at_latest_date,
           MAX(s.`salary_id`)      AS expected_salary_id,
           (SELECT s2.`salary_id`
              FROM `employee_salary` s2
             WHERE s2.`employee_id` = s.`employee_id`
               AND s2.`status` = 'APPROVED'
               AND s2.`effective_from` <= CURDATE()
             ORDER BY s2.`effective_from` DESC, s2.`salary_id` DESC
             LIMIT 1) AS chosen_salary_id
      FROM `employee_salary` s
      JOIN (
        -- each employee's latest eligible effective date, and nothing else
        SELECT `employee_id`, MAX(`effective_from`) AS max_effective_from
          FROM `employee_salary`
         WHERE `status` = 'APPROVED'
           AND `effective_from` <= CURDATE()
         GROUP BY `employee_id`
      ) latest
        ON latest.`employee_id` = s.`employee_id`
       AND latest.max_effective_from = s.`effective_from`
     WHERE s.`status` = 'APPROVED'
       AND s.`effective_from` <= CURDATE()
     GROUP BY s.`employee_id`, s.`effective_from`
  ) t
 -- NULL-safe: a chosen_salary_id that came back NULL must not slip past a
 -- plain <>, which would yield NULL and filter the row out.
 WHERE NOT (t.chosen_salary_id <=> t.expected_salary_id)
 ORDER BY t.`employee_id`;

-- 2c. DID THE TIE-BREAK GET EXERCISED AT ALL? Informational. If this is zero,
--     2b passed without any employee actually having two approved rows on
--     their latest eligible date - the check is sound but proved nothing
--     about ties on this dataset. Say so in the results rather than claiming
--     the tie-break is verified.
SELECT COUNT(*) AS employees_with_a_tie_on_their_latest_eligible_date
  FROM (
    SELECT s.`employee_id`
      FROM `employee_salary` s
      JOIN (
        SELECT `employee_id`, MAX(`effective_from`) AS max_effective_from
          FROM `employee_salary`
         WHERE `status` = 'APPROVED' AND `effective_from` <= CURDATE()
         GROUP BY `employee_id`
      ) latest
        ON latest.`employee_id` = s.`employee_id`
       AND latest.max_effective_from = s.`effective_from`
     WHERE s.`status` = 'APPROVED' AND s.`effective_from` <= CURDATE()
     GROUP BY s.`employee_id`, s.`effective_from`
    HAVING COUNT(*) > 1
  ) ties;

-- --------------- 3. the three exclusions the rule depends on -------------
-- PENDING is never current, REJECTED is never current, and a future-dated
-- approval is not current yet. These count the employees each rule actually
-- changes the answer for - they are the rows a mistake would show up in.
SELECT 'pending_only'  AS population,
       COUNT(DISTINCT employee_id) AS employees
  FROM `employee_salary` s
 WHERE s.`status` = 'PENDING'
   AND NOT EXISTS (SELECT 1 FROM `employee_salary` x
                    WHERE x.employee_id = s.employee_id AND x.status = 'APPROVED'
                      AND x.effective_from <= CURDATE())
UNION ALL
SELECT 'rejected_only', COUNT(DISTINCT employee_id)
  FROM `employee_salary` s
 WHERE s.`status` = 'REJECTED'
   AND NOT EXISTS (SELECT 1 FROM `employee_salary` x
                    WHERE x.employee_id = s.employee_id AND x.status = 'APPROVED'
                      AND x.effective_from <= CURDATE())
UNION ALL
SELECT 'future_approved_only', COUNT(DISTINCT employee_id)
  FROM `employee_salary` s
 WHERE s.`status` = 'APPROVED' AND s.`effective_from` > CURDATE()
   AND NOT EXISTS (SELECT 1 FROM `employee_salary` x
                    WHERE x.employee_id = s.employee_id AND x.status = 'APPROVED'
                      AND x.effective_from <= CURDATE())
UNION ALL
SELECT 'live_but_uncosted', COUNT(DISTINCT employee_id)
  FROM `employee_salary` s
 WHERE s.`status` = 'APPROVED' AND s.`effective_from` <= CURDATE()
   AND s.`ctc_status` <> 'APPLIED';

-- Each of those must read Payroll Pending on the dashboard. Section 6 is
-- where that is checked end to end.

-- ================= 4. getPayrollConfigMany: the derived pair ============
-- The query returns only `payment_type_recorded` and `pays_in_cash`; the
-- column itself never leaves the database. These checks prove the two
-- booleans ARE the column, by reproducing the repository's query verbatim in
-- a derived table and comparing its output against the same rule written a
-- second, different way. Comparing an expression to itself would pass no
-- matter what the query did.
--
-- A derived table rather than a CTE, so this section runs on MySQL 5.7 as
-- well as 8 (sections 2 and 6 need 8).
--
-- ONE NULL SUBTLETY, AND IT IS EXPECTED BEHAVIOUR RATHER THAN A DEFECT.
-- `payment_type = 2` is NULL - not 0 - when `payment_type` is NULL, so
-- `pays_in_cash` comes back NULL for an employee whose route was never
-- recorded. The repository coerces it with `Boolean(Number(row.pays_in_cash))`
-- and `Number(null)` is 0, so it reads false, which is correct. The checks
-- below therefore treat NULL as 0 for the comparison AND report it separately,
-- so the reviewer sees it rather than having it silently normalised away.
-- `payment_type IS NOT NULL` is never NULL, so `payment_type_recorded` is
-- always a clean 0 or 1.

-- 4a. The totals, and the two mismatch counts.
--     PASS: `mismatch_recorded` = 0 AND `mismatch_cash` = 0.
SELECT
  COUNT(*)                                                      AS employees_checked,
  SUM(bulk.payment_type_recorded)                               AS derived_recorded,
  SUM(COALESCE(bulk.pays_in_cash, 0))                           AS derived_cash,
  SUM(CASE WHEN ne.payment_type IS NULL THEN 0 ELSE 1 END)      AS expected_recorded,
  SUM(CASE WHEN ne.payment_type = 2    THEN 1 ELSE 0 END)       AS expected_cash,
  -- NOT (a <=> b) is the NULL-SAFE inequality: a plain <> yields NULL when
  -- either side is NULL, and a NULL is not counted by SUM - which is exactly
  -- how a mismatch would hide.
  SUM(NOT (bulk.payment_type_recorded
           <=> CASE WHEN ne.payment_type IS NULL THEN 0 ELSE 1 END))  AS mismatch_recorded,
  SUM(NOT (COALESCE(bulk.pays_in_cash, 0)
           <=> CASE WHEN ne.payment_type = 2 THEN 1 ELSE 0 END))      AS mismatch_cash
FROM (
  -- repository/employee_master.js#getPayrollConfigMany, verbatim.
  SELECT employee_id,
         (payment_type IS NOT NULL) AS payment_type_recorded,
         (payment_type = 2)         AS pays_in_cash
    FROM `new_employee` WHERE employee_id IN (:IDS)
) bulk
JOIN `new_employee` ne ON ne.employee_id = bulk.employee_id;

-- 4b. EVERY MISMATCHING EMPLOYEE, with what the query returned beside what it
--     should have returned. This is the row-level form of 4a - run it
--     whenever 4a is non-zero, and keep its output.
--     PASS: zero rows.
SELECT
  bulk.employee_id,
  bulk.payment_type_recorded                                   AS actual_payment_type_recorded,
  CASE WHEN ne.payment_type IS NULL THEN 0 ELSE 1 END          AS expected_payment_type_recorded,
  bulk.pays_in_cash                                            AS actual_pays_in_cash,
  CASE WHEN ne.payment_type = 2 THEN 1 ELSE 0 END              AS expected_pays_in_cash,
  CASE
    WHEN NOT (bulk.payment_type_recorded
              <=> CASE WHEN ne.payment_type IS NULL THEN 0 ELSE 1 END)
     AND NOT (COALESCE(bulk.pays_in_cash, 0)
              <=> CASE WHEN ne.payment_type = 2 THEN 1 ELSE 0 END)
      THEN 'both'
    WHEN NOT (bulk.payment_type_recorded
              <=> CASE WHEN ne.payment_type IS NULL THEN 0 ELSE 1 END)
      THEN 'payment_type_recorded'
    ELSE 'pays_in_cash'
  END                                                          AS mismatched_column
FROM (
  SELECT employee_id,
         (payment_type IS NOT NULL) AS payment_type_recorded,
         (payment_type = 2)         AS pays_in_cash
    FROM `new_employee` WHERE employee_id IN (:IDS)
) bulk
JOIN `new_employee` ne ON ne.employee_id = bulk.employee_id
WHERE NOT (bulk.payment_type_recorded
           <=> CASE WHEN ne.payment_type IS NULL THEN 0 ELSE 1 END)
   OR NOT (COALESCE(bulk.pays_in_cash, 0)
           <=> CASE WHEN ne.payment_type = 2 THEN 1 ELSE 0 END)
ORDER BY bulk.employee_id;

-- 4c. THE QUERY MUST ANSWER FOR EVERY EMPLOYEE IT WAS ASKED ABOUT. A row
--     missing from the bulk result is read as `{recorded: false, cash: false}`
--     by the usecase, which would put a bank employee on the payroll-pending
--     list for a reason that is not true of them. That happens only if an id
--     in the list has no `new_employee` row.
--
--     THIS ONE CANNOT BE CHECKED IN SQL ALONE - the id list is substituted in
--     as a literal, so a query over `new_employee` can only ever compare the
--     table with itself. Compare BY HAND: `rows_out` below must equal the
--     number of ids you substituted for :IDS.
--     PASS: rows_out = the count of ids passed (section 0's list length).
SELECT COUNT(*) AS rows_out
  FROM `new_employee` WHERE employee_id IN (:IDS);

-- 4d. WHERE `pays_in_cash` COMES BACK NULL. Informational, and expected to be
--     exactly the employees with no recorded route - see the NULL note above.
--     PASS: `null_but_route_recorded` = 0. `null_and_not_recorded` is a count
--     to note, not a failure; it should match `not_recorded` in 4e.
SELECT
  SUM(CASE WHEN bulk.pays_in_cash IS NULL AND ne.payment_type IS NULL
           THEN 1 ELSE 0 END) AS null_and_not_recorded,
  SUM(CASE WHEN bulk.pays_in_cash IS NULL AND ne.payment_type IS NOT NULL
           THEN 1 ELSE 0 END) AS null_but_route_recorded
FROM (
  SELECT employee_id, (payment_type = 2) AS pays_in_cash
    FROM `new_employee` WHERE employee_id IN (:IDS)
) bulk
JOIN `new_employee` ne ON ne.employee_id = bulk.employee_id;

-- 4e. The distribution, for the record - and the number the Cash -> Bank card
--     should show. Informational.
SELECT SUM(payment_type IS NULL)        AS not_recorded,
       SUM(payment_type = 1)            AS bank,
       SUM(payment_type = 2)            AS cash,
       SUM(payment_type NOT IN (1, 2))  AS unexpected_value
  FROM `new_employee` WHERE employee_id IN (:IDS);

-- 4f. THE VALUE THAT WOULD BREAK THE RULE. `pays_in_cash` is `payment_type =
--     2`; anything that is neither 1 nor 2 would be treated as "bank" and
--     asked for an account. Legacy free-text or a third code would show here.
--     PASS: zero rows.
SELECT payment_type, COUNT(*) AS employees
  FROM `new_employee`
 WHERE payment_type IS NOT NULL AND payment_type NOT IN (1, 2)
 GROUP BY payment_type;

-- ------------------------------------- 5. cost, at the real headcount ---
-- The endpoint runs each of these ONCE for the whole population. Confirm the
-- plan is not a per-row scan of employee_salary.
--
-- PASS: the outer query uses an index on employee_salary(employee_id); the
-- dependent subquery is expected, but `rows` must not approach the table size
-- per employee. Record the timings alongside.
EXPLAIN SELECT s.`employee_id`, s.`ctc_status`
  FROM `employee_salary` s
 WHERE s.`employee_id` IN (:IDS)
   AND s.`status` = 'APPROVED'
   AND s.`effective_from` <= CURDATE()
   AND s.`salary_id` = (
     SELECT s2.`salary_id` FROM `employee_salary` s2
      WHERE s2.`employee_id` = s.`employee_id`
        AND s2.`status` = 'APPROVED'
        AND s2.`effective_from` <= CURDATE()
      ORDER BY s2.`effective_from` DESC, s2.`salary_id` DESC
      LIMIT 1
   );

EXPLAIN SELECT employee_id,
               (payment_type IS NOT NULL) AS payment_type_recorded,
               (payment_type = 2)         AS pays_in_cash
          FROM `new_employee` WHERE employee_id IN (:IDS);

-- Indexes present on employee_salary today, for the record.
SELECT INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME, NON_UNIQUE
  FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_salary'
 ORDER BY INDEX_NAME, SEQ_IN_INDEX;

-- =========== 6. the whole dashboard, recomputed independently ===========
-- The seven counts, derived here in SQL from the columns rather than by the
-- application. Compare against the screen: they must agree exactly.
--
-- `bank_payroll_ready` cannot be recomputed in SQL - it depends on an
-- application-computed `account_fingerprint` - so bank readiness is
-- approximated as a stored VERIFIED row. That makes the Bank and HR numbers
-- here a LOWER bound on pending; Active, Statutory, Cash and the payroll
-- terms are exact.
SELECT
  COUNT(*) AS active_employees,
  SUM(a.employee_id IS NULL) AS aadhaar_pending,
  SUM(ne.payment_type = 1 AND (v.status IS NULL OR v.status <> 'VERIFIED')) AS bank_pending_approx,
  SUM(ne.pf_applicable IS NULL OR ne.esi_applicable IS NULL) AS statutory_pending,
  SUM(ne.payment_type = 2) AS cash_to_bank_pending,
  SUM(
    live.salary_id IS NULL
    OR live.ctc_status <> 'APPLIED'
    OR ne.payment_type IS NULL
    OR (ne.payment_type = 1 AND (v.status IS NULL OR v.status <> 'VERIFIED'))
  ) AS payroll_pending_approx
  FROM `new_employee` ne
  LEFT JOIN `employee_aadhaar_identity` a ON a.employee_id = ne.employee_id
  LEFT JOIN `employee_bank_verification` v ON v.employee_id = ne.employee_id
  LEFT JOIN LATERAL (
    SELECT s.`salary_id`, s.`ctc_status` FROM `employee_salary` s
     WHERE s.`employee_id` = ne.`employee_id`
       AND s.`status` = 'APPROVED' AND s.`effective_from` <= CURDATE()
     ORDER BY s.`effective_from` DESC, s.`salary_id` DESC LIMIT 1
  ) live ON TRUE
 WHERE ne.status = 1
   AND ne.employee_name NOT IN (SELECT employee_name FROM `resignation`);

-- 6b. HR pending, the union of the four, same approximation.
SELECT COUNT(*) AS hr_pending_approx
  FROM `new_employee` ne
  LEFT JOIN `employee_aadhaar_identity` a ON a.employee_id = ne.employee_id
  LEFT JOIN `employee_bank_verification` v ON v.employee_id = ne.employee_id
  LEFT JOIN LATERAL (
    SELECT s.`salary_id`, s.`ctc_status` FROM `employee_salary` s
     WHERE s.`employee_id` = ne.`employee_id`
       AND s.`status` = 'APPROVED' AND s.`effective_from` <= CURDATE()
     ORDER BY s.`effective_from` DESC, s.`salary_id` DESC LIMIT 1
  ) live ON TRUE
 WHERE ne.status = 1
   AND ne.employee_name NOT IN (SELECT employee_name FROM `resignation`)
   AND (
     a.employee_id IS NULL
     OR (ne.payment_type = 1 AND (v.status IS NULL OR v.status <> 'VERIFIED'))
     OR ne.pf_applicable IS NULL OR ne.esi_applicable IS NULL
     OR live.salary_id IS NULL OR live.ctc_status <> 'APPLIED' OR ne.payment_type IS NULL
   );

-- CASH IS NOT IN THAT UNION, which is the rule worth re-reading on the
-- output: an employee with payment_type = 2 and everything else finished must
-- appear in 6's cash column and NOT in 6b.
--
-- PASS: run this and confirm it returns rows that are absent from 6b.
SELECT ne.employee_id, ne.employee_name
  FROM `new_employee` ne
  JOIN `employee_aadhaar_identity` a ON a.employee_id = ne.employee_id
  LEFT JOIN LATERAL (
    SELECT s.`ctc_status` FROM `employee_salary` s
     WHERE s.`employee_id` = ne.`employee_id`
       AND s.`status` = 'APPROVED' AND s.`effective_from` <= CURDATE()
     ORDER BY s.`effective_from` DESC, s.`salary_id` DESC LIMIT 1
  ) live ON TRUE
 WHERE ne.status = 1 AND ne.payment_type = 2
   AND ne.pf_applicable IS NOT NULL AND ne.esi_applicable IS NOT NULL
   AND live.ctc_status = 'APPLIED'
 ORDER BY ne.employee_id;
