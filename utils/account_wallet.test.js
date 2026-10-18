/**
 * Account Sheet - Wallet Transactions.
 *
 *   node --test utils/account_wallet.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  walletAmountOrNull,
  walletValues,
  getNetWalletMovement,
} = require("./account_wallet");
const { getAccountDifference } = require("./account_difference");

// The repository logs through winston; a stub keeps this test dependency-free.
const loggerPath = require.resolve("./logger");
require.cache[loggerPath] = {
  id: loggerPath,
  filename: loggerPath,
  loaded: true,
  exports: { Log() {}, LEVEL: { ERROR: "error" } },
};
const makeAccountsRepository = require("../repository/accounts");

const fakeDb = () => {
  const calls = [];
  return {
    calls,
    query(sql, params, cb) {
      calls.push({ sql, params });
      cb(null, { insertId: 7 });
    },
  };
};

const sheet = (extra = {}) => ({
  accounts_id: 7,
  date: "2026-11-10 10:00:00",
  no_of_bills: 618,
  total_sales: 316801.98,
  card_sales: 196057.1,
  loyalty: 701,
  sales_return: 388.75,
  cash_handover_500: 226,
  cashier_id: 3,
  user_id: 1,
  store_id: 1,
  ...extra,
});

const paramFor = (call, column) => {
  // Map each `?` in the statement to its column, in order.
  const cols = [];
  const re = /(\w+)\s*=\s*(?:COALESCE\()?\?|\?/g;
  if (/^\s*INSERT/i.test(call.sql)) {
    const list = call.sql.match(/\(([^)]*)\)\s*VALUES/s)[1].split(",").map((c) => c.trim());
    return call.params[list.indexOf(column)];
  }
  let m;
  while ((m = re.exec(call.sql))) cols.push(m[1]);
  return call.params[cols.indexOf(column)];
};

test("no wallet entries: blank and omitted both mean nothing to record", () => {
  assert.deepEqual(walletValues({}), { wallet_receipt: null, wallet_payment: null });
  assert.deepEqual(walletValues({ wallet_receipt: "", wallet_payment: "" }), {
    wallet_receipt: 0,
    wallet_payment: 0,
  });
  assert.equal(getNetWalletMovement({}), 0);
  assert.equal(getNetWalletMovement({ wallet_receipt: "0.00", wallet_payment: "0.00" }), 0);
});

test("receipt only, payment only, both, and payment above receipt", () => {
  assert.equal(getNetWalletMovement({ wallet_receipt: "1500.50" }), 1500.5);
  assert.equal(getNetWalletMovement({ wallet_payment: "250.25" }), -250.25);
  assert.equal(getNetWalletMovement({ wallet_receipt: "1000.10", wallet_payment: "400.20" }), 599.9);
  assert.equal(getNetWalletMovement({ wallet_receipt: "100.00", wallet_payment: "350.75" }), -250.75);
  assert.equal(getNetWalletMovement({ wallet_receipt: "0.30", wallet_payment: "0.10" }), 0.2);
});

test("only non-negative amounts with at most two decimals are accepted", () => {
  assert.equal(walletAmountOrNull("1234.5", "wallet_receipt"), 1234.5);
  assert.equal(walletAmountOrNull(0.1, "wallet_receipt"), 0.1);
  assert.equal(walletAmountOrNull("9999999999.99", "wallet_receipt"), 9999999999.99);
  for (const bad of ["-1", -0.01, "12.345", "abc", "10000000000", true]) {
    assert.throws(
      () => walletAmountOrNull(bad, "wallet_payment"),
      (err) => err.name === "ValidationError" && /wallet_payment/.test(err.message),
      String(bad)
    );
  }
});

test("wallet amounts never touch the Total Difference", () => {
  const base = {
    total_sales: "316801.98",
    card_sales: "196057.10",
    loyalty: "701.00",
    sales_return: "388.75",
    cash_handover_500: 226,
    cash_handover_200: 1,
    cash_handover_100: 2,
    cash_handover_50: 1,
    cash_handover_20: 1,
    cash_handover_10: 1,
    cash_handover_5: 1,
    sales: [
      { payment_type: 1, amount: "1764.00" },
      { payment_type: 1, amount: "4666.00" },
    ],
  };
  const withWallet = { ...base, wallet_receipt: "5000.00", wallet_payment: "12000.00" };
  assert.equal(getAccountDifference(base), -259.87);
  assert.equal(getAccountDifference(withWallet), -259.87);
  assert.equal(withWallet.sales.length, 2, "no Receipt/Payment row is added");
});

test("create stores the amounts, and 0 when they are omitted", async () => {
  const db = fakeDb();
  const repo = makeAccountsRepository(db);

  await repo.create(sheet({ wallet_receipt: 1500.5, wallet_payment: 200 }));
  assert.match(db.calls[0].sql, /IFNULL\(\?, 0\), IFNULL\(\?, 0\)/);
  assert.equal(paramFor(db.calls[0], "wallet_receipt"), 1500.5);
  assert.equal(paramFor(db.calls[0], "wallet_payment"), 200);
  assert.equal(paramFor(db.calls[0], "sales_return"), 388.75);
  assert.equal(paramFor(db.calls[0], "store_id"), 1);

  await repo.create(sheet());
  assert.equal(paramFor(db.calls[1], "wallet_receipt"), null, "IFNULL turns it into 0");

  const placeholders = (db.calls[0].sql.match(/\?/g) || []).length;
  assert.equal(placeholders, db.calls[0].params.length);
});

test("update writes edited amounts and keeps them when a request omits them", async () => {
  const db = fakeDb();
  const repo = makeAccountsRepository(db);

  await repo.update(sheet({ wallet_receipt: 99.99, wallet_payment: 0 }));
  const call = db.calls[0];
  assert.match(call.sql, /wallet_receipt = COALESCE\(\?, wallet_receipt\)/);
  assert.match(call.sql, /wallet_payment = COALESCE\(\?, wallet_payment\)/);
  assert.equal(paramFor(call, "wallet_receipt"), 99.99);
  assert.equal(paramFor(call, "wallet_payment"), 0, "an explicit 0 is written");
  assert.equal(paramFor(call, "accounts_id"), 7);
  assert.equal((call.sql.match(/\?/g) || []).length, call.params.length);

  // An update without the fields passes null, which COALESCE keeps as is.
  await repo.update(sheet());
  assert.equal(paramFor(db.calls[1], "wallet_receipt"), null);
  assert.equal(paramFor(db.calls[1], "wallet_payment"), null);
});

test("the routes validate the fields and the listing returns them", () => {
  const routes = fs.readFileSync(path.join(__dirname, "../routes/accounts.js"), "utf8");
  assert.equal(routes.match(/wallet_receipt: Joi\.number\(\)\.allow\("", null\)\.optional\(\)/g).length, 2);
  assert.match(routes, /Object.assign\(req.body, walletValues\(req.body\)\)/);
  assert.match(routes, /Object.assign\(account, walletValues\(account\)\)/);

  const repo = fs.readFileSync(path.join(__dirname, "../repository/accounts.js"), "utf8");
  assert.match(repo, /'wallet_receipt', IFNULL\(a\.wallet_receipt, 0\)/);
  assert.match(repo, /'wallet_payment', IFNULL\(a\.wallet_payment, 0\)/);
});

test("the migration is additive with a zero default", () => {
  const dir = path.join(__dirname, "../migrations/mysql/migrations/sqls");
  const up = fs.readFileSync(path.join(dir, "20261130120000-account-sheet-wallet-up.sql"), "utf8");
  const down = fs.readFileSync(path.join(dir, "20261130120000-account-sheet-wallet-down.sql"), "utf8");
  const statements = up.replace(/--.*$/gm, "");
  assert.match(statements, /ADD COLUMN wallet_receipt DECIMAL\(12,2\) NOT NULL DEFAULT 0\.00/);
  assert.match(statements, /ADD COLUMN wallet_payment DECIMAL\(12,2\) NOT NULL DEFAULT 0\.00/);
  assert.ok(!/\b(DROP|UPDATE|DELETE|MODIFY)\b/i.test(statements), "up only adds columns");
  assert.match(down, /DROP COLUMN wallet_payment/);
  assert.match(down, /DROP COLUMN wallet_receipt/);
});
