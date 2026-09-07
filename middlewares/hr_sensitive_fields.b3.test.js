/**
 * Stage 0B / B3 — sensitive employee fields are filtered on the way out and
 * guarded on the way in.
 *
 * B1 required a session, B2 required a permission per route. Neither helps
 * with a row that carries a name, a store, a salary, a bank account and an
 * Aadhaar number at once: `view_employees` opened all of it. B3 splits the
 * row, and these tests are about the split holding on the real wiring - real
 * Express, the real auth middleware, the real permissions middleware, the
 * real employee and document routers over stub usecases that return rows
 * shaped like the ones the SELECT * queries actually produce.
 *
 * The assertion that matters is "absent, not null": a null would tell the
 * reader the field exists and is empty, and a frontend cannot tell a hidden
 * salary from an unrecorded one.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dnds-b3-"));
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});
fs.writeFileSync(path.join(dir, "priv.key"), privateKey);
fs.writeFileSync(path.join(dir, "pub.key"), publicKey);
process.env.JWT_PRIVATE_KEY_PATH = path.join(dir, "priv.key");
process.env.JWT_PUBLIC_KEYS = JSON.stringify({ legacy: path.join(dir, "pub.key") });
process.env.JWT_ACTIVE_KID = "legacy";
process.env.JWT_LEGACY_KID = "legacy";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const bodyParser = require("body-parser");
const auth = require("./auth");
const buildPermissions = require("./permissions");
const buildSensitive = require("./sensitive");
const jwtService = require("../services/jwt");
const P = require("../constants/hr_permissions");
const {
  SENSITIVE_EMPLOYEE_FIELDS,
} = require("../constants/sensitive_fields");

const USER_ID = 7;
const EMPLOYEE_ID = 1003;

/** Designations used by the tests, and what each one holds. */
const HR_DESIGNATION = 11; // every HR key, B3 keys included
const DIRECTORY_DESIGNATION = 4; // view_employees / view_documents only
const NO_KEYS_DESIGNATION = 9; // nothing at all

const ALL_HR_KEYS = Object.values(P);

const GRANTS = [
  ...ALL_HR_KEYS.map((permission_key) => ({
    designation_id: HR_DESIGNATION,
    permission_key,
    is_active: 1,
  })),
  // The interesting caller: allowed to run the directory and see documents,
  // but not to see or touch anything sensitive.
  { designation_id: DIRECTORY_DESIGNATION, permission_key: P.VIEW_EMPLOYEES, is_active: 1 },
  { designation_id: DIRECTORY_DESIGNATION, permission_key: P.ADD_EMPLOYEES, is_active: 1 },
  { designation_id: DIRECTORY_DESIGNATION, permission_key: P.VIEW_DOCUMENTS, is_active: 1 },
  { designation_id: DIRECTORY_DESIGNATION, permission_key: P.VIEW_BANKS, is_active: 1 },
];

const designationUsecase = {
  async getPermissionById(designationId, userType) {
    if (Number(userType) === 2) return ALL_HR_KEYS.map((permission_key) => ({ permission_key }));
    return GRANTS.filter(
      (g) => Number(g.designation_id) === Number(designationId) && Number(g.is_active) === 1
    ).map((g) => ({ permission_key: g.permission_key }));
  },
};

/**
 * One employee row as `SELECT *` returns it: ordinary columns and sensitive
 * ones side by side, with `uan` in the lower-case spelling the list queries
 * use and `UAN` in the spelling `SELECT *` uses.
 */
const EMPLOYEE_ROW = {
  employee_id: EMPLOYEE_ID,
  employee_name: "Test Person",
  designation_id: DIRECTORY_DESIGNATION,
  store_id: 2,
  primary_contact_number: "9000000000",
  date_of_joining: "2020-01-01",
  salary: 45000,
  payment_type: 2,
  bank_name: "Test Bank",
  ifsc: "TEST0001234",
  account_no: "1234567890",
  pan_no: "ABCDE1234F",
  aadhaar_card_no: "111122223333",
  aadhaar_card_name: "Test Person",
  aadhaar_card_image: "https://s3.example/aadhaar/secret-scan.jpg",
  uan: "100200300400",
  pf: "1",
  pf_number: "PF-9",
  esi: "1",
  esi_number: "ESI-9",
};

/** An Aadhaar document row and an ordinary one, as the document repo returns. */
const AADHAAR_DOC = {
  document_id: 1,
  employee_id: EMPLOYEE_ID,
  card_type: 1,
  card_no: "111122223333",
  card_name: "Aadhaar",
  file: "https://s3.example/docs/aadhaar-scan.pdf",
};
const PAN_DOC = {
  document_id: 2,
  employee_id: EMPLOYEE_ID,
  card_type: 4,
  card_no: "ABCDE1234F",
  file: "https://s3.example/docs/pan-scan.pdf",
};
const ORDINARY_DOC = {
  document_id: 3,
  employee_id: EMPLOYEE_ID,
  card_type: 3,
  card_no: "VOTER-1",
  file: "https://s3.example/docs/voter.pdf",
};

let permissions, sensitive, server, port, lastWrite;

/** Usecases that answer with the rows above, and record what a write saw. */
const employeeUsecase = new Proxy(
  {},
  {
    get: (_t, name) => async (arg) => {
      if (String(name).startsWith("update") || name === "create") {
        lastWrite = arg;
        return 200;
      }
      return [EMPLOYEE_ROW];
    },
  }
);

const documentUsecase = new Proxy(
  {},
  {
    get: (_t, name) => async (arg) => {
      if (String(name).startsWith("update") || name === "create") {
        lastWrite = arg;
        return 200;
      }
      if (name === "getDocumentsWithoutAdhaar") {
        // JSON_ARRAYAGG comes back as a string, not an array.
        return [
          {
            employee_id: EMPLOYEE_ID,
            employee_name: "Test Person",
            files: JSON.stringify([
              { card_type: 1, card_no: "111122223333" },
              { card_type: 3, card_no: "VOTER-1" },
            ]),
          },
        ];
      }
      return [AADHAAR_DOC, PAN_DOC, ORDINARY_DOC];
    },
  }
);

const sessionState = {
  user_id: USER_ID,
  employee_id: EMPLOYEE_ID,
  status: 1,
  token_valid_from: null,
  must_change_password: 0,
  is_system_account: 0,
  employee_status: 1,
};

before(async () => {
  permissions = buildPermissions(designationUsecase);
  sensitive = buildSensitive(permissions);

  const app = express();
  app.use(bodyParser.json());
  app.use(auth.create({ userUsecase: { getSessionState: async () => sessionState } }));

  const mount = (prefix, mod, usecase) => {
    delete require.cache[require.resolve(`../routes/${mod}`)];
    const r = require(`../routes/${mod}`)(usecase, permissions, sensitive);
    app.use(prefix, r.getRouter());
  };
  mount("/employee", "employee", employeeUsecase);
  mount("/document", "document", documentUsecase);

  server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  port = server.address().port;
});

after(() => server && server.close());

const tokenFor = ({ userType = 1, designationId = DIRECTORY_DESIGNATION } = {}) =>
  jwtService.sign(
    {
      auth_ver: 2,
      sub: String(USER_ID),
      id: USER_ID,
      employee_id: EMPLOYEE_ID,
      user_type: userType,
      designation_id: designationId,
      store_id: 2,
    },
    "1d"
  );

const call = async (method, p, token, body) => {
  lastWrite = undefined;
  // `jwtService.sign` is asynchronous, so the token helpers below hand back a
  // promise; awaiting it here keeps every call site free of the ceremony.
  token = await token;
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-access-token": token } : {}),
    },
    ...(method === "POST" ? { body: JSON.stringify(body || {}) } : {}),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    parsed = undefined;
  }
  return { status: res.status, body: parsed, text };
};

/** The B2/B3 permission refusal: HTTP 403, that message, and no error field. */
const isPermissionRefusal = (r) =>
  r.status === 403 &&
  r.body &&
  r.body.code === 403 &&
  r.body.msg === "You do not have permission to perform this action" &&
  !("error" in r.body);

const HR = () => tokenFor({ designationId: HR_DESIGNATION });
const DIRECTORY = () => tokenFor({ designationId: DIRECTORY_DESIGNATION });
const ADMIN = () => tokenFor({ userType: 2, designationId: NO_KEYS_DESIGNATION });

describe("B3 reads: who sees sensitive employee fields", () => {
  it("admin (user_type 2) sees every sensitive field", async () => {
    const r = await call("GET", "/employee/employees", ADMIN());
    assert.equal(r.status, 200);
    const row = r.body[0];
    for (const field of SENSITIVE_EMPLOYEE_FIELDS) {
      const key = Object.keys(EMPLOYEE_ROW).find((k) => k.toLowerCase() === field);
      if (key) assert.ok(key in row, `admin should still see ${key}`);
    }
    assert.equal(row.salary, EMPLOYEE_ROW.salary);
    assert.equal(row.account_no, EMPLOYEE_ROW.account_no);
  });

  it("HR Executive with view_employee_sensitive sees every sensitive field", async () => {
    const r = await call("GET", "/employee/employees", HR());
    assert.equal(r.status, 200);
    assert.equal(r.body[0].salary, EMPLOYEE_ROW.salary);
    assert.equal(r.body[0].aadhaar_card_no, EMPLOYEE_ROW.aadhaar_card_no);
    assert.equal(r.body[0].ifsc, EMPLOYEE_ROW.ifsc);
  });

  it("a user without the key receives the row with the sensitive keys ABSENT, not null", async () => {
    const r = await call("GET", "/employee/employees", DIRECTORY());
    assert.equal(r.status, 200);
    const row = r.body[0];
    for (const key of Object.keys(EMPLOYEE_ROW)) {
      if (SENSITIVE_EMPLOYEE_FIELDS.includes(key.toLowerCase())) {
        assert.ok(!(key in row), `${key} must be absent`);
        assert.equal(row[key], undefined);
      }
    }
    // and specifically not present-with-null, which is what a naive
    // implementation produces
    assert.ok(!Object.keys(row).includes("salary"));
    assert.ok(!/salary|account_no|aadhaar|ifsc|pan_no/i.test(r.text));
  });

  it("ordinary employee fields keep working for that same user", async () => {
    const r = await call("GET", "/employee/employees", DIRECTORY());
    const row = r.body[0];
    assert.equal(row.employee_id, EMPLOYEE_ID);
    assert.equal(row.employee_name, "Test Person");
    assert.equal(row.store_id, 2);
    assert.equal(row.date_of_joining, "2020-01-01");
    assert.equal(row.primary_contact_number, "9000000000");
  });

  it("every employee read route is filtered, not just the list", async () => {
    for (const p of [
      "/employee/employees",
      "/employee/employee_id?employee_id=1003",
      "/employee/filter?filter=Test",
      "/employee/bank",
    ]) {
      const r = await call("GET", p, DIRECTORY());
      assert.equal(r.status, 200, p);
      assert.ok(!/account_no|aadhaar_card_image|"salary"/i.test(r.text), p);
    }
  });

  it("the UAN column is filtered in either spelling", async () => {
    const cleaned = buildSensitive.sanitize([{ UAN: "1", uan: "2", employee_name: "x" }]);
    assert.deepEqual(cleaned, [{ employee_name: "x" }]);
  });
});

describe("B3 reads: sensitive documents", () => {
  it("Aadhaar and PAN document rows never reach a caller without the key", async () => {
    const r = await call("GET", "/document/employee_id?employee_id=1003", DIRECTORY());
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 1);
    assert.equal(r.body[0].document_id, ORDINARY_DOC.document_id);
    assert.ok(!r.text.includes("aadhaar-scan.pdf"));
    assert.ok(!r.text.includes("pan-scan.pdf"));
    assert.ok(!r.text.includes("111122223333"));
  });

  it("the same rows are returned in full to HR and to admin", async () => {
    for (const token of [HR(), ADMIN()]) {
      const r = await call("GET", "/document/all", token);
      assert.equal(r.body.length, 3);
      assert.ok(r.text.includes("aadhaar-scan.pdf"));
    }
  });

  it("a sensitive document inside a JSON_ARRAYAGG string is filtered too", async () => {
    const r = await call("GET", "/document/withoutadhaar", DIRECTORY());
    assert.equal(r.status, 200);
    const files = JSON.parse(r.body[0].files);
    assert.equal(files.length, 1);
    assert.equal(files[0].card_type, 3);
    assert.ok(!r.text.includes("111122223333"));
  });

  it("/document/adhaar stays a view_employee_sensitive route (B2 unchanged)", async () => {
    assert.ok(isPermissionRefusal(await call("GET", "/document/adhaar", DIRECTORY())));
    assert.equal((await call("GET", "/document/adhaar", HR())).status, 200);
  });
});

describe("B3 writes: changing sensitive data", () => {
  const sensitiveBody = {
    employee_id: EMPLOYEE_ID,
    employee_details: { employee_name: "Test Person", salary: 99999 },
  };
  const ordinaryBody = {
    employee_id: EMPLOYEE_ID,
    employee_details: { employee_name: "Renamed Person" },
  };

  it("a caller with add_employees but not edit_employee_sensitive is refused with 403", async () => {
    const r = await call("POST", "/employee/updatedata", DIRECTORY(), sensitiveBody);
    assert.ok(isPermissionRefusal(r), r.text);
  });

  it("the refusal is a refusal, not a silent drop", async () => {
    await call("POST", "/employee/updatedata", DIRECTORY(), sensitiveBody);
    assert.equal(lastWrite, undefined, "the usecase must never have been called");
  });

  it("HR Executive with edit_employee_sensitive succeeds", async () => {
    const r = await call("POST", "/employee/updatedata", HR(), sensitiveBody);
    assert.equal(r.status, 200);
    assert.equal(lastWrite.employee_details.salary, 99999);
  });

  it("admin succeeds through the same bypass", async () => {
    const r = await call("POST", "/employee/updatedata", ADMIN(), sensitiveBody);
    assert.equal(r.status, 200);
    assert.equal(lastWrite.employee_details.salary, 99999);
  });

  it("an ordinary update still follows the existing B2 permission alone", async () => {
    const r = await call("POST", "/employee/updatedata", DIRECTORY(), ordinaryBody);
    assert.equal(r.status, 200);
    assert.equal(lastWrite.employee_details.employee_name, "Renamed Person");
  });

  it("every sensitive field triggers the guard on its own", async () => {
    for (const field of SENSITIVE_EMPLOYEE_FIELDS) {
      const r = await call("POST", "/employee/updatedata", DIRECTORY(), {
        employee_id: EMPLOYEE_ID,
        employee_details: { [field]: "x" },
      });
      assert.ok(isPermissionRefusal(r), `${field} should have been guarded`);
    }
  });

  it("clearing a sensitive field counts as changing it", async () => {
    for (const value of [null, "", 0]) {
      const r = await call("POST", "/employee/updatedata", DIRECTORY(), {
        employee_id: EMPLOYEE_ID,
        employee_details: { account_no: value },
      });
      assert.ok(isPermissionRefusal(r), `account_no = ${JSON.stringify(value)}`);
    }
  });

  it("attaching an Aadhaar or PAN document is a sensitive write", async () => {
    for (const cardType of [1, 4]) {
      const r = await call("POST", "/employee/updatedata", DIRECTORY(), {
        employee_id: EMPLOYEE_ID,
        employee_details: {
          docupdate: [{ card_type: String(cardType), file: "s3://x" }],
        },
      });
      assert.ok(isPermissionRefusal(r), `card_type ${cardType}`);
    }
  });

  it("attaching an ordinary document is not", async () => {
    const r = await call("POST", "/employee/updatedata", DIRECTORY(), {
      employee_id: EMPLOYEE_ID,
      employee_details: { docupdate: [{ card_type: "3", file: "s3://x" }] },
    });
    assert.equal(r.status, 200);
  });

  it("employee create carrying salary and bank details needs the key", async () => {
    assert.ok(
      isPermissionRefusal(
        await call("POST", "/employee", DIRECTORY(), { employee_name: "x", salary: 1 })
      )
    );
  });
});

describe("B3 preserves B1, B2 and the bootstrap", () => {
  it("anonymous is still refused by B1, unchanged", async () => {
    const r = await call("GET", "/employee/employees", null);
    assert.equal(r.status, 200);
    assert.equal(r.body.code, 403);
    assert.equal(r.body.msg, "Access Denied");
  });

  it("B2 still refuses a caller without the route's key", async () => {
    const noKeys = tokenFor({ designationId: NO_KEYS_DESIGNATION });
    assert.ok(isPermissionRefusal(await call("GET", "/employee/employees", noKeys)));
    assert.ok(isPermissionRefusal(await call("GET", "/document/all", noKeys)));
  });

  it("/employee/get-details still answers a user with no HR permission at all", async () => {
    const noKeys = tokenFor({ designationId: NO_KEYS_DESIGNATION });
    const r = await call("GET", "/employee/get-details", noKeys);
    assert.equal(r.status, 200);
    assert.equal(r.body[0].employee_id, EMPLOYEE_ID);
    assert.equal(r.body[0].employee_name, "Test Person");
  });

  it("and it is filtered like every other employee read", async () => {
    const noKeys = tokenFor({ designationId: NO_KEYS_DESIGNATION });
    const r = await call("GET", "/employee/get-details", noKeys);
    assert.ok(!("salary" in r.body[0]));
    assert.ok(!("account_no" in r.body[0]));
  });
});

describe("B3 filtering rules in isolation", () => {
  const { sanitize, containsSensitive } = buildSensitive;

  it("removes keys rather than blanking them, at any depth", () => {
    const out = sanitize({ a: 1, nested: { salary: 5, name: "x" }, list: [{ ifsc: "y", id: 2 }] });
    assert.deepEqual(out, { a: 1, nested: { name: "x" }, list: [{ id: 2 }] });
  });

  it("leaves dates, numbers, nulls and ordinary strings alone", () => {
    const when = new Date("2020-01-01T00:00:00Z");
    const out = sanitize({ created_at: when, count: 0, missing: null, note: "salary review" });
    assert.equal(out.created_at.getTime(), when.getTime());
    assert.equal(out.count, 0);
    assert.equal(out.missing, null);
    assert.equal(out.note, "salary review");
  });

  it("does not re-parse strings other than the documents aggregate", () => {
    const out = sanitize({ payload: '{"salary":1}', files: '[{"salary":1,"id":2}]' });
    assert.equal(out.payload, '{"salary":1}');
    assert.deepEqual(JSON.parse(out.files), [{ id: 2 }]);
  });

  it("survives a files value that is not JSON", () => {
    assert.equal(sanitize({ files: "not json" }).files, "not json");
  });

  it("containsSensitive finds a field nested in an array", () => {
    assert.equal(containsSensitive({ a: [{ b: { pan_no: "x" } }] }), true);
    assert.equal(containsSensitive({ a: [{ b: { note: "x" } }] }), false);
    assert.equal(containsSensitive(undefined), false);
    assert.equal(containsSensitive({}), false);
  });
});
