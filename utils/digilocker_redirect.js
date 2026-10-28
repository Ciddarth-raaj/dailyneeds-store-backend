const kycConfig = require("../config/sandbox_kyc");

/**
 * Where DigiLocker sends the employee once they have allowed (or declined)
 * sharing their Aadhaar.
 *
 * `SANDBOX_DIGILOCKER_REDIRECT_URL` when it is set. Otherwise this server's
 * own static "you can close this tab" page, `views/digilocker/done.html`,
 * on the host the request arrived at - which in production is the public API
 * host the frontend talks to. DigiLocker only needs somewhere harmless to
 * land; the result itself is read server to server, never from this page.
 *
 * Always HTTPS: DigiLocker refuses anything else, and a local or plain-HTTP
 * host would only fail later at the provider with a less useful message.
 */
function digilockerRedirectUrl(req) {
  if (kycConfig.aadhaar.redirectUrl) return kycConfig.aadhaar.redirectUrl;
  const forwarded = req && req.get ? req.get("x-forwarded-host") : null;
  const host = String((forwarded || (req && req.get ? req.get("host") : "") || "").split(",")[0]).trim();
  // A loopback, bare IP or dotless host means a proxy did not pass the public
  // name through; DigiLocker could never reach it, so say so instead.
  const name = host.replace(/:\d+$/, "");
  if (!name.includes(".") || /^[\d.]+$/.test(name) || /^localhost$/i.test(name)) return null;
  return `https://${host}/digilocker/done.html`;
}

module.exports = { digilockerRedirectUrl };
