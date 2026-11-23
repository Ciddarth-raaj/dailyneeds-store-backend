'use strict';

var dbm;
var type;
var seed;
var fs = require('fs');
var path = require('path');
var Promise;

/**
  * We receive the dbmigrate dependency from dbmigrate initially.
  * This enables us to not have to rely on NODE_PATH.
  */
exports.setup = function(options, seedLink) {
  dbm = options.dbmigrate;
  type = dbm.dataType;
  seed = seedLink;
  Promise = options.Promise;
};

// The SQL file adds debit_note_tally_response.debit_note_id and links the
// responses with a plain MasterID. This links the ones whose MasterID the
// export encrypted (older debit notes), decoded the way purchase responses
// are (utils/tally_master_id.js purchaseIdFromMasterId), when that debit
// note has the response's voucher number and outlet.
var { purchaseIdFromMasterId } = require('../../../utils/tally_master_id');

function query(db, sql, params) {
  return new Promise(function(resolve, reject) {
    db.all(sql, params, function(err, rows) {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

exports.up = function(db) {
  var filePath = path.join(__dirname, 'sqls', '20270103120000-debit-note-tally-response-debit-note-id-up.sql');
  return new Promise( function( resolve, reject ) {
    fs.readFile(filePath, {encoding: 'utf-8'}, function(err,data){
      if (err) return reject(err);
      console.log('received data: ' + data);

      resolve(data);
    });
  })
  .then(function(data) {
    return db.runSql(data);
  })
  .then(function() {
    return query(db,
      "SELECT MasterID, VoucherNo, CostCentre FROM debit_note_tally_response WHERE debit_note_id IS NULL",
      []);
  })
  .then(function(rows) {
    var linked = 0;
    return rows.reduce(function(chain, r) {
      var id = purchaseIdFromMasterId(r.MasterID);
      if (!id) return chain;
      return chain.then(function() {
        return query(db,
          "UPDATE debit_note_tally_response tr " +
          "INNER JOIN debit_note dn ON dn.debit_note_id = ? AND TRIM(dn.mprh_pr_refno) = TRIM(tr.VoucherNo) " +
          "INNER JOIN outlets o ON o.outlet_id = dn.store_id AND TRIM(o.outlet_name) = TRIM(tr.CostCentre) " +
          "SET tr.debit_note_id = dn.debit_note_id " +
          "WHERE tr.MasterID = ? AND tr.debit_note_id IS NULL",
          [id, r.MasterID]).then(function(res) { linked += (res && res.affectedRows) || 0; });
      });
    }, Promise.resolve()).then(function() {
      console.log('debit_note_tally_response: linked ' + linked + ' response(s) with an encrypted MasterID');
    });
  });
};

exports.down = function(db) {
  var filePath = path.join(__dirname, 'sqls', '20270103120000-debit-note-tally-response-debit-note-id-down.sql');
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
};

exports._meta = {
  "version": 1
};
