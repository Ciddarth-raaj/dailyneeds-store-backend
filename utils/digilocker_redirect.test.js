/**
 *   node --test utils/digilocker_redirect.test.js
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");

const { digilockerRedirectUrl } = require("./digilocker_redirect");

const req = (headers) => ({ get: (h) => headers[h.toLowerCase()] });

test("the public host the request arrived at, over HTTPS", () => {
  assert.equal(
    digilockerRedirectUrl(req({ host: "api.dnds.co.in" })),
    "https://api.dnds.co.in/digilocker/done.html"
  );
  assert.equal(
    digilockerRedirectUrl(req({ host: "127.0.0.1:8080", "x-forwarded-host": "api.dnds.co.in" })),
    "https://api.dnds.co.in/digilocker/done.html"
  );
});

test("no address DigiLocker could never reach", () => {
  for (const host of ["localhost:8080", "127.0.0.1:8080", "backend", ""]) {
    assert.equal(digilockerRedirectUrl(req({ host })), null, host);
  }
});
