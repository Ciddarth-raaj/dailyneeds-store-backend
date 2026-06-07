"use strict";

var dbm;
var type;
var seed;
var fs = require("fs");
var path = require("path");
var Promise;

function readSql(filename) {
  var filePath = path.join(__dirname, "sqls", filename);
  return new Promise(function (resolve, reject) {
    fs.readFile(filePath, { encoding: "utf-8" }, function (err, data) {
      if (err) return reject(err);
      resolve(data);
    });
  });
}

exports.setup = function (options, seedLink) {
  dbm = options.dbmigrate;
  type = dbm.dataType;
  seed = seedLink;
  Promise = options.Promise;
};

exports.up = function (db) {
  return readSql("20260607140000-product-distributor-cid-up.sql")
    .then(function (data) {
      return db.runSql(data);
    })
    .then(function () {
      return readSql("20260607140000-product-distributor-cid-backfill.sql");
    })
    .then(function (data) {
      return db.runSql(data);
    });
};

exports.down = function (db) {
  return readSql("20260607140000-product-distributor-cid-down.sql").then(
    function (data) {
      return db.runSql(data);
    }
  );
};

exports._meta = {
  version: 1,
};
