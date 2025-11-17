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
