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

class GstUsecase {
  constructor(sandboxService, gstVendorRepo) {
    this.sandboxService = sandboxService;
    this.gstVendorRepo = gstVendorRepo;
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

module.exports = (sandboxService, gstVendorRepo) => {
  return new GstUsecase(sandboxService, gstVendorRepo);
};
