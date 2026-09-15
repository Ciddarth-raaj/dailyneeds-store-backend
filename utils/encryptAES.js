/**
 * The DigiSME gateway's PAYLOAD ENCODING. Not a security primitive.
 *
 * WHAT IT IS. Every DigiSME `/api/<Endpoint>` call carries its parameters as
 * a single encoded field:
 *
 *     body: { str: encryptAES({ CompanyId, fromDate, toDate }) }
 *
 * The key and the IV below are fixed by the GATEWAY, not chosen by us - the
 * IV is the gateway vendor's own name in ASCII. They are what the endpoint
 * accepts; a different key or IV gets the request rejected. That is why they
 * are literals and why changing them is a protocol change, not a hardening
 * exercise.
 *
 * WHAT IT IS NOT. It offers NO CONFIDENTIALITY. The key and IV are in this
 * file, so anyone who can read the repository can decrypt anything encoded
 * with it, and a fixed IV means identical payloads produce identical
 * ciphertext. It authenticates nothing and protects nothing.
 *
 * THEREFORE, THE RULE:
 *
 *   Use it ONLY to encode non-secret DigiSME request parameters.
 *   NEVER pass it a credential, a token, a password or personal data.
 *
 * DigiSME credentials travel where the vendor puts them - in request
 * headers, over TLS - and are read from the environment
 * (services/digisme_attendance.js). They never go through here.
 *
 * Its one sanctioned caller is `services/digisme_attendance.js`, the
 * attendance API client. `services/digisme_removal.test.js` fails if
 * anything else requires it, and fails if this function is ever handed
 * something that looks like a credential. `config/aadhaar.js` documents in
 * its own header why it does NOT use this and uses a real cipher instead -
 * follow that example for anything that genuinely needs protecting.
 *
 * NOTE ON PROVENANCE: that these exact values are gateway-mandated is
 * established by the integration working against the live gateway, not by a
 * vendor specification held in this repository. The vendor's manual is not
 * in the tree. Treat the values as protocol constants to be changed only on
 * the vendor's instruction.
 */
const crypto = require("crypto");

function encryptAES(jsonObject) {
  const secretKey = "1234567890123456"; // 16 bytes for 128-bit key
  const iv = "Info-TechGateWay"; // 16 bytes IV
  const algorithm = "aes-128-cbc";

  // Convert the input JSON object to string
  const text = JSON.stringify(jsonObject);

  // Create cipher
  const cipher = crypto.createCipheriv(
    algorithm,
    Buffer.from(secretKey),
    Buffer.from(iv)
  );

  // Encrypt the text
  let encrypted = cipher.update(text, "utf8", "base64");
  encrypted += cipher.final("base64");

  return encrypted;
}

module.exports = encryptAES;
