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

  _cloneJson(obj) {
    return JSON.parse(JSON.stringify(obj));
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
