const logger = require("../utils/logger");

/** Sandbox GSTIN search: wait after HTTP 429 before retrying (B2B vendor resolution). */
const SANDBOX_GSTIN_SEARCH_429_WAIT_MS = 60 * 1000;
/** Max number of waits (each followed by a retry); avoids unbounded stalls if rate limit persists. */
const SANDBOX_GSTIN_SEARCH_429_MAX_WAITS = 10;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function vendorNameFromSandboxBody(body) {
  const inner = body && body.data && body.data.data;
  if (!inner) return "";
  const tn = String(inner.tradeNam || inner.lgnm || "").trim();
  return tn || "";
}

function shouldPersistSandboxSearch(body) {
  if (!body || body.code !== 200 || !body.data) return false;
  if (body.data.error) return false;
  if (String(body.data.status_cd) !== "1") return false;
  return Boolean(body.data.data);
}

function isSupplierGstinPlaceholderName(vendorName, gstinUpper) {
  if (vendorName == null || gstinUpper == null) return false;
  const n = String(vendorName).trim();
  const g = String(gstinUpper).trim().toUpperCase();
  return new RegExp(`^supplier\\s+${g}$`, "i").test(n);
}

/** True when we have a real display name (not empty, not legacy `Supplier <GSTIN>`). */
function hasResolvedVendorName(row, normalizedGstin) {
  if (!row || row.vendor_name == null) return false;
  const n = String(row.vendor_name).trim();
  if (!n) return false;
  return !isSupplierGstinPlaceholderName(n, normalizedGstin);
}

async function sandboxSearchVendorNameAndCache(sandboxService, normalized) {
  let vendorName = null;
  let cache = null;
  if (!sandboxService || !sandboxService.isEnabled()) {
    return { vendorName, cache };
  }
  try {
    const acceptCache = process.env.SANDBOX_GST_ACCEPT_CACHE === "true";
    let axiosRes;
    for (let rateWait = 0; ; rateWait++) {
      axiosRes = await sandboxService.searchGstin(normalized, {
        acceptCache,
      });
      if (axiosRes.status !== 429) {
        break;
      }
      if (rateWait >= SANDBOX_GSTIN_SEARCH_429_MAX_WAITS) {
        logger.Log({
          level: logger.LEVEL.WARN,
          component: "USECASE.GST",
          code: "USECASE.GST.SANDBOX_GSTIN_SEARCH_429_EXHAUSTED",
          description: `Sandbox GSTIN search returned 429 after ${SANDBOX_GSTIN_SEARCH_429_MAX_WAITS} wait(s); giving up for ${normalized}`,
          category: "",
          ref: { gstin: normalized, waits: rateWait },
        });
        return { vendorName, cache };
      }
      logger.Log({
        level: logger.LEVEL.WARN,
        component: "USECASE.GST",
        code: "USECASE.GST.SANDBOX_GSTIN_SEARCH_429",
        description: `Sandbox GSTIN search 429 Too Many Requests for ${normalized}; waiting ${SANDBOX_GSTIN_SEARCH_429_WAIT_MS}ms before retry`,
        category: "",
        ref: { gstin: normalized, wait_index: rateWait + 1 },
      });
      await delay(SANDBOX_GSTIN_SEARCH_429_WAIT_MS);
    }

    const body = axiosRes.data;
    if (axiosRes.status === 200 && body && body.code === 200) {
      const name = vendorNameFromSandboxBody(body);
      if (name) {
        vendorName = name.slice(0, 512);
      }
      if (shouldPersistSandboxSearch(body)) {
        cache = body;
      } else if (body.data && body.data.data) {
        cache = body;
      }
    }
  } catch (_) {
    /* leave nulls */
  }
  return { vendorName, cache };
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
  constructor(
    sandboxService,
    gstVendorRepo,
    gstFetchLogRepo,
    gstB2bSyncService,
    gstB2bRepo,
    gstB2bInvoiceRepo,
    gstB2bInvoiceItemRepo
  ) {
    this.sandboxService = sandboxService;
    this.gstVendorRepo = gstVendorRepo;
    this.gstFetchLogRepo = gstFetchLogRepo;
    this.gstB2bSyncService = gstB2bSyncService || null;
    this.gstB2bRepo = gstB2bRepo || null;
    this.gstB2bInvoiceRepo = gstB2bInvoiceRepo || null;
    this.gstB2bInvoiceItemRepo = gstB2bInvoiceItemRepo || null;
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

  /**
   * Ensures a `gst_vendors` row exists for this CTIN.
   * Names come from Sandbox `searchGstin` only; if none, `vendor_name` stays `NULL`.
   * Existing rows with missing or legacy placeholder names are refreshed from Sandbox.
   */
  async ensureVendorForB2bSync(ctin) {
    const normalized = String(ctin).trim().toUpperCase();
    const row = await this.gstVendorRepo.getByGstin(normalized);

    if (row && hasResolvedVendorName(row, normalized)) {
      return row.gst_vendor_id;
    }

    const { vendorName, cache } = await sandboxSearchVendorNameAndCache(
      this.sandboxService,
      normalized
    );

    if (!row) {
      try {
        return await this.gstVendorRepo.create({
          gstin: normalized,
          vendor_name: vendorName,
          sandbox_search_response: cache,
          is_active: true,
        });
      } catch (err) {
        const again = await this.gstVendorRepo.getByGstin(normalized);
        if (again) {
          if (
            !hasResolvedVendorName(again, normalized) &&
            (vendorName != null || cache != null)
          ) {
            const patch = { vendor_name: vendorName };
            if (cache != null) patch.sandbox_search_response = cache;
            await this.gstVendorRepo.updateVendorByGstin(normalized, patch);
          }
          return again.gst_vendor_id;
        }
        throw err;
      }
    }

    if (vendorName != null || cache != null) {
      const patch = { vendor_name: vendorName };
      if (cache != null) patch.sandbox_search_response = cache;
      await this.gstVendorRepo.updateVendorByGstin(normalized, patch);
    }
    return row.gst_vendor_id;
  }

  async getAllVendors() {
    const rows = await this.gstVendorRepo.getAllWithLatestFilingDate();
    return { code: 200, data: rows };
  }

  async getAllVendorFilingDates() {
    if (!this.gstB2bSyncService || !this.gstB2bSyncService.vendorFilingDateRepo) {
      return { code: 503, msg: "GST B2B storage is not configured" };
    }
    const rows = await this.gstB2bSyncService.vendorFilingDateRepo.getAll();
    return { code: 200, data: rows };
  }

  async getLatestFetchLog() {
    if (!this.gstFetchLogRepo) {
      return { code: 503, msg: "GST fetch log is not configured" };
    }
    const row = await this.gstFetchLogRepo.getLatest();
    return { code: 200, data: row };
  }

  /**
   * Stored GSTR-2A B2B invoices + line items for a return period (from MySQL after sync).
   * @param {number|string} year
   * @param {number|string} month 1–12
   */
  async getStoredB2bInvoicesForReturnPeriod(year, month) {
    if (
      !this.gstB2bRepo ||
      !this.gstB2bInvoiceRepo ||
      !this.gstB2bInvoiceItemRepo
    ) {
      return { code: 503, msg: "GST B2B storage is not configured" };
    }
    const y = Number(year);
    const m = Number(month);
    if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) {
      return { code: 400, msg: "year and month must be valid (month 1–12)" };
    }
    try {
      const b2bRows = await this.gstB2bRepo.getByReturnPeriod(y, m);
      if (!b2bRows.length) {
        return {
          code: 200,
          data: [],
          meta: {
            year: y,
            month: m,
            b2b_block_count: 0,
            invoice_count: 0,
            item_count: 0,
          },
        };
      }
      const gstB2bIds = b2bRows.map((r) => r.gst_b2b_id);
      const invoices = await this.gstB2bInvoiceRepo.listByGstB2bIds(gstB2bIds);
      const invIds = invoices.map((i) => i.gst_b2b_invoice_id);
      const allItems = await this.gstB2bInvoiceItemRepo.listByInvoiceIds(invIds);
      const vendorIds = [
        ...new Set(
          b2bRows
            .map((b) => b.gst_vendor_id)
            .filter((id) => id != null && Number.isFinite(Number(id)))
            .map((id) => Number(id))
        ),
      ];
      const vendorById = new Map();
      if (vendorIds.length && this.gstVendorRepo) {
        const vrows = await this.gstVendorRepo.getByIds(vendorIds);
        for (const v of vrows) {
          vendorById.set(v.gst_vendor_id, v);
        }
      }
      const itemsByInvoiceId = new Map();
      for (const it of allItems) {
        const k = it.gst_b2b_invoice_id;
        if (!itemsByInvoiceId.has(k)) {
          itemsByInvoiceId.set(k, []);
        }
        itemsByInvoiceId.get(k).push(it);
      }
      const b2bById = new Map(b2bRows.map((b) => [b.gst_b2b_id, b]));
      const data = invoices.map((inv) => {
        const hdr = b2bById.get(inv.gst_b2b_id) || {};
        const vid =
          hdr.gst_vendor_id != null && Number.isFinite(Number(hdr.gst_vendor_id))
            ? Number(hdr.gst_vendor_id)
            : null;
        const vend = vid != null ? vendorById.get(vid) : null;
        return {
          gst_b2b_id: inv.gst_b2b_id,
          gst_b2b_invoice_id: inv.gst_b2b_invoice_id,
          year: hdr.year,
          month: hdr.month,
          b2b_index: hdr.b2b_index,
          gst_vendor_id: vid,
          vendor_name: vend ? vend.vendor_name : null,
          ctin: hdr.ctin,
          cfs: hdr.cfs,
          b2b_created_at: hdr.created_at,
          inv_index: inv.inv_index,
          inum: inv.inum,
          idt: inv.idt,
          oinum: inv.oinum,
          oidt: inv.oidt,
          val: inv.val,
          pos: inv.pos,
          rchrg: inv.rchrg,
          inv_typ: inv.inv_typ,
          etin: inv.etin,
          fldtr1: inv.fldtr1,
          diff_percent: inv.diff_percent,
          invoice_created_at: inv.created_at,
          items: itemsByInvoiceId.get(inv.gst_b2b_invoice_id) || [],
        };
      });
      return {
        code: 200,
        data,
        meta: {
          year: y,
          month: m,
          b2b_block_count: b2bRows.length,
          invoice_count: invoices.length,
          item_count: allItems.length,
        },
      };
    } catch (err) {
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "USECASE.GST",
        code: "USECASE.GST.STORED_B2B_INVOICES",
        description: err.toString(),
        category: "",
        ref: { year: y, month: m },
      });
      return { code: 500, msg: err.message || String(err) };
    }
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
    const yearNum = parseInt(y, 10);
    const monthNum = parseInt(m, 10);

    const ctinSet = new Set();
    for (const blk of b2bAll) {
      const c =
        blk && blk.ctin != null ? String(blk.ctin).trim().toUpperCase() : "";
      if (c) {
        ctinSet.add(c);
      }
    }

    const ctinToVendorId = new Map();
    for (const ctin of ctinSet) {
      const vid = await this.ensureVendorForB2bSync(ctin);
      ctinToVendorId.set(ctin, vid);
    }

    if (this.gstB2bSyncService) {
      try {
        await this.gstB2bSyncService.syncFromB2bArray(
          b2bAll,
          yearNum,
          monthNum,
          ctinToVendorId
        );
      } catch (syncErr) {
        logger.Log({
          level: logger.LEVEL.ERROR,
          component: "USECASE.GST",
          code: "USECASE.GST.GSTR2A_B2B_SYNC",
          description: syncErr.toString(),
          category: "",
          ref: { year: y, month: m },
        });
        return {
          code: 500,
          msg: syncErr.message || "Failed to persist GSTR-2A B2B data",
        };
      }
    }

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

    const vendors = (await this.gstVendorRepo.getAll()).filter(
      (v) => v.is_active
    );
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
        createdById != null && createdById !== "" ? Number(createdById) : null;
      const createdBy = uid != null && Number.isFinite(uid) ? uid : null;
      try {
        await this.gstFetchLogRepo.create({
          type: "gstr-2a-b2b",
          year: yearNum,
          month: monthNum,
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
    if (
      local &&
      local.sandbox_search_response != null &&
      hasResolvedVendorName(local, normalized)
    ) {
      return {
        ...this._cloneJson(local.sandbox_search_response),
        search_source: "database",
      };
    }

    const acceptCache = process.env.SANDBOX_GST_ACCEPT_CACHE === "true";

    if (!this.sandboxService.isEnabled()) {
      return {
        code: 503,
        msg: "Sandbox API is not configured and no cached search exists for this GSTIN (set SANDBOX_API_KEY and SANDBOX_API_SECRET)",
        search_source: null,
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
          search_source: null,
        };
      }

      if (axiosRes.status !== 200) {
        return {
          code: 502,
          msg: `Sandbox GSTIN search failed (HTTP ${axiosRes.status})`,
          detail: axiosRes.data,
          search_source: null,
        };
      }

      const body = axiosRes.data;
      if (shouldPersistSandboxSearch(body)) {
        const vendorName = vendorNameFromSandboxBody(body) || null;
        await this.gstVendorRepo.upsertSearchCache(
          normalized,
          vendorName,
          body
        );
      }

      return { ...body, search_source: "sandbox" };
    } catch (err) {
      return {
        code: 500,
        msg: err.message || String(err),
        search_source: null,
      };
    }
  }
}

module.exports = (
  sandboxService,
  gstVendorRepo,
  gstFetchLogRepo,
  gstB2bSyncService,
  gstB2bRepo,
  gstB2bInvoiceRepo,
  gstB2bInvoiceItemRepo
) => {
  return new GstUsecase(
    sandboxService,
    gstVendorRepo,
    gstFetchLogRepo,
    gstB2bSyncService,
    gstB2bRepo,
    gstB2bInvoiceRepo,
    gstB2bInvoiceItemRepo
  );
};
