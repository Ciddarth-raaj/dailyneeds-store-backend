const logger = require("../utils/logger");

function vendorNameFromSandboxBody(body) {
  const inner = body && body.data && body.data.data;
  if (!inner) return "";
  const tn = String(inner.tradeNam || inner.lgnm || "").trim();
  return tn || String(inner.gstin || "").trim() || "";
}

function shouldPersistSandboxSearch(body) {
  if (!body || body.code !== 200 || !body.data) return false;
  if (body.data.error) return false;
  if (String(body.data.status_cd) !== "1") return false;
  return Boolean(body.data.data);
}

/**
 * GSTR-2A B2B payload: only the `b2b` array from Sandbox (`data.data.b2b` on success body).
 * @param {object} body parsed JSON from Sandbox
 * @returns {object[]}
 */
function pickGstr2aB2bArrayFromSandboxBody(body) {
  if (!body || typeof body !== "object") return [];
  const d = body.data;
  if (!d || typeof d !== "object") return [];
  const inner = d.data;
  if (!inner || typeof inner !== "object") return [];
  const arr = inner.b2b;
  return Array.isArray(arr) ? arr : [];
}

class GstUsecase {
  constructor(sandboxService, gstVendorRepo, gstFetchLogRepo) {
    this.sandboxService = sandboxService;
    this.gstVendorRepo = gstVendorRepo;
    this.gstFetchLogRepo = gstFetchLogRepo;
  }

  _gstAuth() {
    return this.sandboxService && this.sandboxService.gstAuthentication;
  }

  _sandboxDisabledResponse() {
    return {
      code: 503,
      msg: "Sandbox API is not configured (set SANDBOX_API_KEY and SANDBOX_API_SECRET)",
    };
  }

  _noGstAuthResponse() {
    return {
      code: 503,
      msg: "GST taxpayer authentication is not configured on this server",
    };
  }

  _cloneJson(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  async getTaxpayerSessionStatus() {
    const ga = this._gstAuth();
    if (!ga) {
      return { ...this._noGstAuthResponse(), session: null };
    }
    await ga.loadFromDatabase();
    return {
      code: 200,
      session: ga.getTaxpayerSessionStatusPayload(),
    };
  }

  async requestTaxpayerOtp() {
    if (!this.sandboxService.isEnabled()) {
      return this._sandboxDisabledResponse();
    }
    const ga = this._gstAuth();
    if (!ga) {
      return this._noGstAuthResponse();
    }
    await ga.loadFromDatabase();
    const sessionBefore = ga.getTaxpayerSessionStatusPayload();
    const res = await ga.requestTaxpayerOtp();
    await ga.loadFromDatabase();
    const sessionAfter = ga.getTaxpayerSessionStatusPayload();
    return {
      code: res.data && res.data.code != null ? res.data.code : res.status,
      axios_http_status: res.status,
      sandbox: res.data,
      session_before: sessionBefore,
      session: sessionAfter,
    };
  }

  async verifyTaxpayerOtp(otp) {
    if (!this.sandboxService.isEnabled()) {
      return this._sandboxDisabledResponse();
    }
    const ga = this._gstAuth();
    if (!ga) {
      return this._noGstAuthResponse();
    }
    const res = await ga.verifyTaxpayerOtp(otp);
    await ga.loadFromDatabase();
    const session = ga.getTaxpayerSessionStatusPayload();
    return {
      code: res.data && res.data.code != null ? res.data.code : res.status,
      axios_http_status: res.status,
      sandbox: res.data,
      session,
    };
  }

  async revalidateTaxpayerWithOtp(otp) {
    return this.verifyTaxpayerOtp(otp);
  }

  /**
   * For future GST taxpayer–authenticated Sandbox calls. GSTIN search does not use this.
   * @returns {Promise<null | { code: number, requires_gst_taxpayer_otp: boolean }>}
   */
  async assertTaxpayerSessionForGstApis() {
    if (!this.sandboxService.isEnabled()) {
      return { code: 503, msg: this._sandboxDisabledResponse().msg };
    }
    const ga = this._gstAuth();
    if (!ga) {
      return this._noGstAuthResponse();
    }
    const err = await ga.ensureTaxpayerTokenUsableForGstApis();
    if (err) {
      return err;
    }
    return null;
  }

  async getAllVendors() {
    const rows = await this.gstVendorRepo.getAll();
    return { code: 200, data: rows };
  }

  /**
   * Fetches GSTR-2A B2B for a return period from Sandbox, keeps only `data.data.b2b`,
   * and groups entries by configured vendors (active GSTINs).
   * @param {number | string | null | undefined} createdById from `req.decoded.id`
   * @returns {Promise<{ code: number, data: object[] } | { _block: object } | { code: number, msg: string, sandbox?: object }>}
   */
  async getGstr2aB2bGroupedByVendors(year, month, createdById) {
    const block = await this.assertTaxpayerSessionForGstApis();
    if (block) {
      return { _block: block };
    }

    if (!this.sandboxService.isEnabled()) {
      return { code: 503, msg: this._sandboxDisabledResponse().msg };
    }

    const y = String(year).trim();
    const m = String(month).trim().padStart(2, "0");

    let axiosRes;
    try {
      axiosRes = await this.sandboxService.getGstr2aB2b(y, m);
    } catch (err) {
      if (err && err.gstOtpPayload) {
        return { _block: err.gstOtpPayload };
      }
      return {
        code: 500,
        msg: err.message || String(err),
      };
    }

    const body = axiosRes.data;
    if (axiosRes.status !== 200) {
      return {
        code: axiosRes.status === 422 ? 422 : 502,
        msg: `Sandbox GSTR-2A B2B failed (HTTP ${axiosRes.status})`,
        sandbox: body,
      };
    }

    if (body && body.code != null && Number(body.code) !== 200) {
      return {
        code: 502,
        msg:
          (body && (body.message || body.msg)) ||
          "Sandbox returned an error for GSTR-2A B2B",
        sandbox: body,
      };
    }

    const b2bAll = pickGstr2aB2bArrayFromSandboxBody(body);
    const byCtin = new Map();
    for (const row of b2bAll) {
      const ctin =
        row && row.ctin != null ? String(row.ctin).trim().toUpperCase() : "";
      if (!ctin) continue;
      if (!byCtin.has(ctin)) {
        byCtin.set(ctin, []);
      }
      byCtin.get(ctin).push(row);
    }

    const vendors = (await this.gstVendorRepo.getAll()).filter((v) => v.is_active);
    const data = vendors.map((v) => {
      const gstin = String(v.gstin).trim().toUpperCase();
      return {
        gst_vendor_id: v.gst_vendor_id,
        gstin,
        vendor_name: v.vendor_name,
        b2b: byCtin.get(gstin) || [],
      };
    });

    if (this.gstFetchLogRepo) {
      const uid =
        createdById != null && createdById !== ""
          ? Number(createdById)
          : null;
      const createdBy =
        uid != null && Number.isFinite(uid) ? uid : null;
      try {
        await this.gstFetchLogRepo.create({
          type: "gstr-2a-b2b",
          year: parseInt(y, 10),
          month: parseInt(m, 10),
          created_by: createdBy,
        });
      } catch (err) {
        logger.Log({
          level: logger.LEVEL.ERROR,
          component: "USECASE.GST",
          code: "USECASE.GST.GSTR2A_B2B_FETCH_LOG",
          description: err.toString(),
          category: "",
          ref: { year: y, month: m },
        });
      }
    }

    return { code: 200, data };
  }

  async searchGstin(gstin) {
    const normalized = String(gstin).trim().toUpperCase();

    const local = await this.gstVendorRepo.getByGstin(normalized);
    if (local && local.sandbox_search_response != null) {
      return this._cloneJson(local.sandbox_search_response);
    }

    const acceptCache = process.env.SANDBOX_GST_ACCEPT_CACHE === "true";

    if (!this.sandboxService.isEnabled()) {
      return {
        code: 503,
        msg:
          "Sandbox API is not configured and no cached search exists for this GSTIN (set SANDBOX_API_KEY and SANDBOX_API_SECRET)",
      };
    }

    try {
      const axiosRes = await this.sandboxService.searchGstin(normalized, {
        acceptCache,
      });

      if (axiosRes.status === 422) {
        const d = axiosRes.data || {};
        return {
          code: 422,
          msg: d.message || "Invalid GSTIN pattern",
          timestamp: d.timestamp,
          transaction_id: d.transaction_id,
        };
      }

      if (axiosRes.status !== 200) {
        return {
          code: 502,
          msg: `Sandbox GSTIN search failed (HTTP ${axiosRes.status})`,
          detail: axiosRes.data,
        };
      }

      const body = axiosRes.data;
      if (shouldPersistSandboxSearch(body)) {
        const vendorName =
          vendorNameFromSandboxBody(body) || normalized;
        await this.gstVendorRepo.upsertSearchCache(
          normalized,
          vendorName,
          body
        );
      }

      return body;
    } catch (err) {
      return {
        code: 500,
        msg: err.message || String(err),
      };
    }
  }
}

module.exports = (sandboxService, gstVendorRepo, gstFetchLogRepo) => {
  return new GstUsecase(sandboxService, gstVendorRepo, gstFetchLogRepo);
};
