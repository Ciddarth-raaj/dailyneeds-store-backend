const key = "mysecretkey12345"; // Change this to a secure key

module.exports = function simpleEncrypt(message) {
  let encrypted = "";
  for (let i = 0; i < message.length; i++) {
    encrypted += String.fromCharCode(
      message.charCodeAt(i) ^ key.charCodeAt(i % key.length)
    );
  }
  return base64Encode(encrypted);
};

function base64Encode(str) {
  return Buffer.from(str, "binary").toString("base64");
}

/** Reverse of simpleEncrypt. */
module.exports.decrypt = function simpleDecrypt(encoded) {
  const bytes = Buffer.from(String(encoded), "base64").toString("binary");
  let decrypted = "";
  for (let i = 0; i < bytes.length; i++) {
    decrypted += String.fromCharCode(
      bytes.charCodeAt(i) ^ key.charCodeAt(i % key.length)
    );
  }
  return decrypted;
};
