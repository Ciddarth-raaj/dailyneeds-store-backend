const jwt = require("jsonwebtoken");
const fs = require("fs");
const path = require("path");

const privateKey = fs.readFileSync(
  path.resolve(__dirname, "../keys/jwt/private.key"),
  "utf8"
);
const publicKey = fs.readFileSync(
  path.resolve(__dirname, "../keys/jwt/public.key"),
  "utf8"
);

const algorithm = "RS256";

module.exports = class JWT {
  static sign(payload, expiresIn) {
    return new Promise((resolve, reject) => {
      jwt.sign(
        payload,
        privateKey,
        { expiresIn: expiresIn, algorithm: algorithm },
        (err, token) => {
          if (err) {
            reject(err);
          } else {
            resolve(token);
          }
        }
      );
    });
  }

  static verify(token) {
    return new Promise((resolve, reject) => {
      jwt.verify(
        token,
        publicKey,
        { algorithm: [algorithm] },
        (err, decoded) => {
          if (err) {
            reject(err);
          } else {
            resolve(decoded);
          }
        }
      );
    });
  }

  static decode(token) {
    return jwt.decode(token, { complete: true });
  }
};
