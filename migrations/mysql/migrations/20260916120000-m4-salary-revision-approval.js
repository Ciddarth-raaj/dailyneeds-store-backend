'use strict';

var dbm;
var type;
var seed;
var fs = require('fs');
var path = require('path');
var Promise;

exports.setup = function(options, seedLink) {
  dbm = options.dbmigrate;
  type = dbm.dataType;
  seed = seedLink;
  Promise = options.Promise;
};

/** The driver hands back rows in one of two shapes depending on its version. */
function rowsOf(result) {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  if (Array.isArray(result.rows)) return result.rows;
  return [];
}

/**
 * REFUSE TO APPLY THE ONE-PENDING-PROPOSAL GUARD OVER DATA THAT BREAKS IT.
 *
 * `uq_salary_pending_proposal` would fail on its own with a duplicate-key
 * error, and that failure is already the safe outcome - nothing is written and
 * nothing is deleted. This check runs first so the failure is READABLE: it
 * names the employees and how many undecided proposals each of them has, which
 * is what somebody needs in order to go and decide them.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not reject one of the duplicates,
 * does not delete one, and does not merge them. Choosing which of two
 * outstanding pay proposals survives is a decision about somebody's salary
 * that belongs to a person, not to a migration, and a salary history quietly
 * rewritten to fit an index is exactly the kind of data loss this project's
 * migrations refuse to cause.
 *
 * Guarded on the table existing, so it is harmless on a database that has not
 * reached M2 yet, and it reads nothing but two columns of the salary table.
 */
function refuseDuplicatePendingProposals(db) {
  var tableCheck =
    'SELECT COUNT(*) AS `found` FROM `information_schema`.`TABLES` ' +
    "WHERE `TABLE_SCHEMA` = DATABASE() AND `TABLE_NAME` = 'employee_salary'";

  var duplicateCheck =
    'SELECT `employee_id`, COUNT(*) AS `pending_count` FROM `employee_salary` ' +
    "WHERE `status` = 'PENDING' GROUP BY `employee_id` HAVING COUNT(*) > 1 " +
    'ORDER BY `employee_id`';

  return db.runSql(tableCheck).then(function(result) {
    var found = rowsOf(result)[0];
    if (!found || Number(found.found) === 0) return null;

    return db.runSql(duplicateCheck).then(function(dupResult) {
      var duplicates = rowsOf(dupResult);
      if (duplicates.length === 0) return null;

      var detail = duplicates
        .map(function(d) {
          return 'employee ' + d.employee_id + ' has ' + d.pending_count + ' pending proposals';
        })
        .join('; ');

      throw new Error(
        'M4 cannot add `uq_salary_pending_proposal`: more than one PENDING salary ' +
          'proposal already exists for at least one employee (' + detail + '). ' +
          'Nothing has been changed. Approve or reject the extra proposals through ' +
          'the application so the surviving one is a deliberate decision, then run ' +
          'this migration again. This migration will not choose between them.'
      );
    });
  });
}

function runSqlFile(db, file) {
  var filePath = path.join(__dirname, 'sqls', file);
  return new Promise( function( resolve, reject ) {
    fs.readFile(filePath, {encoding: 'utf-8'}, function(err,data){
      if (err) return reject(err);
      console.log('received data: ' + data);

      resolve(data);
    });
  })
  .then(function(data) {
    return db.runSql(data);
  });
}

exports.up = function(db) {
  // The check comes FIRST, before a single DDL statement runs, so a database
  // that cannot take the guard is left exactly as it was found.
  return refuseDuplicatePendingProposals(db).then(function() {
    return runSqlFile(db, '20260916120000-m4-salary-revision-approval-up.sql');
  });
};

exports.down = function(db) {
  return runSqlFile(db, '20260916120000-m4-salary-revision-approval-down.sql');
};

exports._meta = {
  "version": 1
};

// Exported for `migrations/m4_salary_revision_approval.test.js`, which proves
// the refusal against a fake connection. db-migrate reads only `up`, `down`,
// `setup` and `_meta`; anything else here is inert to the runner.
exports._refuseDuplicatePendingProposals = refuseDuplicatePendingProposals;
