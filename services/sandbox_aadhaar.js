const kycConfig = require("../config/sandbox_kyc");
const { SandboxError, FAILURE } = require("./sandbox_client");

/**
 * Stage 0C / C2 — Sandbox Aadhaar, through DigiLocker.
 *
 * WHY DIGILOCKER. This used to be Aadhaar OKYC: send an OTP to the mobile
 * registered against the Aadhaar, exchange it for demographics. UIDAI has
 * discontinued OKYC, and Sandbox's OKYC pages now say "this endpoint no
 * longer works" and point to DigiLocker - the OTP still arrived, but the
 * verify call answered "The verification provider is unavailable".
 *
 * The DigiLocker flow is consent-based and has three calls:
 *
 *   startSession({ redirectUrl })   POST /kyc/digilocker/sessions/init
 *                                   -> a DigiLocker link the EMPLOYEE opens,
 *                                      logs in to with their own Aadhaar OTP,
 *                                      and allows Aadhaar to be shared
 *   fetchAadhaar(sessionId)         GET  /kyc/digilocker/sessions/{id}/status
 *                                   GET  /kyc/digilocker/sessions/{id}/documents/aadhaar
 *                                   -> then downloads the signed Aadhaar XML
 *
 * No business logic lives here - no sessions of our own, no duplicate
 * detection, no storage. This is the provider boundary and only that.
 *
 * NOTHING IN THIS FILE LOGS. The XML it reads carries a person's name,
 * address and photograph; the safest way to guarantee none of that is ever
 * written down is for this module to have no logger at all. Failures are
 * raised as typed SandboxErrors and logged one level up by the shared client,
 * which never sees a payload.
 */

/** Demographic keys we are willing to carry out of the Aadhaar XML. */
const DEMOGRAPHIC_KEYS = ["name", "date_of_birth", "gender", "address"];

/** The address parts of `<Poa>`, in the order a postal address is written. */
const ADDRESS_PARTS = ["house", "street", "lm", "loc", "vtc", "po", "subdist", "dist", "state", "pc", "country"];

const fill = (template, values) =>
  template.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(String(values[k] === undefined ? "" : values[k])));

const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decodeXml = (s) =>
  String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k[0] === "#") {
      const code = k[1] === "x" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return XML_ENTITIES[k] || m;
  });

/**
 * The attributes of the FIRST `<tag ...>` element in `xml`, or null.
 *
 * Deliberately not a general XML parser: the Aadhaar XML is a fixed,
 * documented shape and we read three attribute-only elements from it
 * (`UidData`, `Poi`, `Poa`). A dependency to do that would be more code to
 * trust than this.
 */
const attributesOf = (xml, tag) => {
  const m = String(xml).match(new RegExp(`<${tag}\\b([^>]*)>`));
  if (!m) return null;
  const out = {};
  const re = /([A-Za-z_][\w.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let a;
  while ((a = re.exec(m[1])) !== null) {
    out[a[1]] = decodeXml(a[3] !== undefined ? a[3] : a[4]).trim();
  }
  return out;
};

class SandboxAadhaarService {
  constructor(client) {
    this.client = client;
  }

  isEnabled() {
    return Boolean(this.client && this.client.isEnabled());
  }

  /**
   * Opens a DigiLocker session asking for the Aadhaar only.
   *
   * Returns `{ reference_id, transaction_id, authorization_url }`.
   * `reference_id` is Sandbox's session id and is what `fetchAadhaar` needs;
   * it is stored rather than returned to the browser. `authorization_url` is
   * the DigiLocker page the employee opens.
   */
  async startSession({ redirectUrl } = {}) {
    if (!/^https:\/\//i.test(String(redirectUrl || ""))) {
      throw new SandboxError(
        FAILURE.NOT_CONFIGURED,
        "DigiLocker needs a public HTTPS return address; set SANDBOX_DIGILOCKER_REDIRECT_URL on the server",
        503
      );
    }
    const res = await this.client.request({
      method: "POST",
      path: kycConfig.aadhaar.sessionInitPath,
      body: {
        "@entity": kycConfig.aadhaar.sessionInitEntity,
        flow: kycConfig.aadhaar.flow,
        redirect_url: String(redirectUrl),
        doc_types: ["aadhaar"],
        // DigiLocker accepts letters, digits, spaces and underscores only.
        purpose: String(kycConfig.aadhaar.purpose).replace(/[^A-Za-z0-9_ ]/g, " ").trim() || "Know Your Customer",
        options: {
          verification_method: ["aadhaar"],
          pinless: true,
        },
      },
      logRef: { product: "digilocker_session_init" },
    });

    const data = res.data || {};
    const sessionId = data.session_id || data.id;
    const url = data.authorization_url;
    if (!sessionId || !/^https:\/\//i.test(String(url || ""))) {
      throw new SandboxError(FAILURE.UNEXPECTED, "The verification provider did not return a DigiLocker link");
    }
    return {
      reference_id: String(sessionId),
      transaction_id: res.transaction_id,
      authorization_url: String(url),
    };
  }

  /**
   * Where the employee has got to, and - once they have allowed it - their
   * Aadhaar.
   *
   *   { state: "pending" }                  not finished on DigiLocker yet
   *   { state: "failed" | "expired" }       the session can never succeed;
   *                                         start a new one
   *   { state: "verified", aadhaar_last4,   the Aadhaar XML, read
   *     demographics, transaction_id }
   *
   * Only a session Sandbox itself reports `succeeded` is ever read, and only
   * an XML that actually carries a name and an Aadhaar is accepted: a
   * provider failure can never end up marking an Aadhaar verified.
   */
  async fetchAadhaar(sessionId) {
    const id = String(sessionId);
    const logRef = { product: "digilocker_aadhaar", session_id: id };

    const status = await this.client.request({
      method: "GET",
      path: fill(kycConfig.aadhaar.sessionStatusPathTemplate, { session_id: id }),
      logRef,
    });
    const state = String((status.data && status.data.status) || "").trim().toLowerCase();
    if (state === "created" || state === "") return { state: "pending" };
    if (state === "failed" || state === "expired") return { state };
    if (state !== "succeeded") {
      throw new SandboxError(FAILURE.UNEXPECTED, "The verification provider returned an unexpected response");
    }

    const consented = status.data.documents_consented;
    if (Array.isArray(consented) && !consented.map((d) => String(d).toLowerCase()).includes("aadhaar")) {
      throw new SandboxError(
        FAILURE.INVALID_REQUEST,
        "Aadhaar was not shared on the DigiLocker consent screen. Start again and allow Aadhaar.",
        422
      );
    }

    let doc;
    try {
      doc = await this.client.request({
        method: "GET",
        path: fill(kycConfig.aadhaar.documentPathTemplate, { session_id: id, doc_type: "aadhaar" }),
        logRef,
      });
    } catch (err) {
      // The two answers worth a human-readable message of their own.
      if (err instanceof SandboxError && err.category === FAILURE.NOT_FOUND) {
        throw new SandboxError(
          FAILURE.NOT_FOUND,
          "DigiLocker could not provide an Aadhaar for this account",
          422
        );
      }
      if (err instanceof SandboxError && err.category === FAILURE.INVALID_REQUEST) {
        throw new SandboxError(
          FAILURE.INVALID_REQUEST,
          "Aadhaar was not shared on the DigiLocker consent screen. Start again and allow Aadhaar.",
          422
        );
      }
      throw err;
    }

    const files = (doc.data && doc.data.files) || [];
    const file =
      files.find((f) => f && /xml/i.test(String((f.metadata && f.metadata.ContentType) || ""))) || files[0];
    if (!file || !file.url) {
      throw new SandboxError(FAILURE.UNEXPECTED, "The verification provider did not return the Aadhaar document");
    }

    const xml = await this.client.download(file.url, { logRef });
    const parsed = SandboxAadhaarService.parseAadhaarXml(xml);
    if (!parsed.aadhaar_last4 || !parsed.demographics.name) {
      throw new SandboxError(FAILURE.UNEXPECTED, "The Aadhaar document from DigiLocker could not be read");
    }
    return {
      state: "verified",
      transaction_id: doc.transaction_id || status.transaction_id || null,
      reference_id: id,
      aadhaar_last4: parsed.aadhaar_last4,
      demographics: parsed.demographics,
    };
  }

  /**
   * Reads the DigiLocker Aadhaar XML: the last four digits of the (masked)
   * Aadhaar, and the demographics we map - and NOTHING else.
   *
   * `<Pht>`, the photograph, is deliberately never read: no screen or column
   * uses it, and storing a biometric-adjacent image nobody has asked for is
   * not a decision to make by accident. `<LData>` (the local-language copy)
   * is not read either.
   *
   * The XML's own signature is not checked here: it is fetched over HTTPS
   * from Sandbox, which we authenticate to, through a link only Sandbox can
   * sign.
   */
  static parseAadhaarXml(xml) {
    const uid = attributesOf(xml, "UidData") || {};
    const poi = attributesOf(xml, "Poi") || {};
    const poa = attributesOf(xml, "Poa") || {};

    const digits = String(uid.uid || "").replace(/\D/g, "");
    const aadhaar_last4 = digits.length >= 4 ? digits.slice(-4) : null;

    const demographics = {};
    if (poi.name) demographics.name = poi.name;
    if (poi.dob) demographics.date_of_birth = poi.dob;
    if (poi.gender) demographics.gender = poi.gender;
    // The same place often appears twice (a locality that is also the post
    // office); it is written once.
    const seen = new Set();
    const address = ADDRESS_PARTS.map((k) => poa[k] || "").filter((p) => {
      const key = p.toLowerCase();
      if (p === "" || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (address.length) demographics.address = address.join(", ");

    return { aadhaar_last4, demographics };
  }
}

module.exports = (client) => new SandboxAadhaarService(client);
module.exports.SandboxAadhaarService = SandboxAadhaarService;
module.exports.DEMOGRAPHIC_KEYS = DEMOGRAPHIC_KEYS;
