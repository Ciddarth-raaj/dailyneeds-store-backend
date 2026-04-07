const puppeteer = require("puppeteer");
const fs = require("fs");
const logger = require("../utils/logger");
const { IS_PROD } = require("../constants");

const PUPPETEER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--no-zygote",
  "--disable-background-networking",
  "--disable-extensions",
  "--disable-software-rasterizer",
  "--disable-sync",
  "--disable-translate",
  "--disable-default-apps",
  "--disable-features=site-per-process,IsolateOrigins",
  "--js-flags=--lite-mode",
];

/**
 * Production (`IS_PROD`): fixed Chrome path on the server (previous behaviour).
 * Development (`IS_PROD` false): `PUPPETEER_EXECUTABLE_PATH` / `CHROME_PATH` if present, else bundled Chromium.
 */
function buildPuppeteerLaunchOptions() {
  if (IS_PROD) {
    return {
      headless: "new",
      executablePath: "/usr/bin/google-chrome-stable",
      dumpio: true,
      args: PUPPETEER_ARGS,
      timeout: 0,
    };
  }
  const opts = {
    headless: "new",
    dumpio: true,
    args: PUPPETEER_ARGS,
    timeout: 0,
  };
  const fromEnv =
    process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH || "";
  if (fromEnv) {
    try {
      if (fs.existsSync(fromEnv)) {
        opts.executablePath = fromEnv;
      }
    } catch (e) {
      /* use bundled */
    }
  }
  return opts;
}

class PDFService {
  async generatePurchaseOrderPDF(purchaseOrderData) {
    let browser;
    try {
      browser = await puppeteer.launch(buildPuppeteerLaunchOptions());
      const page = await browser.newPage();

      // Generate HTML content for the purchase order
      const htmlContent = this.generatePurchaseOrderHTML(purchaseOrderData);

      await page.setContent(htmlContent, { waitUntil: "networkidle0" });

      // Generate PDF
      const pdfBuffer = await page.pdf({
        format: "A4",
        printBackground: true,
        margin: {
          top: "10mm",
          right: "10mm",
          bottom: "10mm",
          left: "10mm",
        },
        preferCSSPageSize: true,
      });

      await page.close();
      await browser.close();
      return pdfBuffer;
    } catch (error) {
      if (browser) {
        try {
          await browser.close();
        } catch (e) { }
      }
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "SERVICE",
        code: "SERVICE.PDF.GENERATE",
        description: error.toString(),
        category: "",
        ref: { purchase_order_id: purchaseOrderData.purchase_order_id },
      });
      throw error;
    }
  }

  generatePurchaseOrderHTML(purchaseOrderData) {
    const {
      purchase_order_id,
      purchase_order_ref,
      vendor_name,
      date,
      delivery_date,
      items = [],
      subtotal = 0,
      discount = 0,
      tax = 0,
      adjustment = 0,
      total_amount = 0,
    } = purchaseOrderData;

    const formatDate = (dateString) => {
      if (!dateString) return "N/A";
      const date = new Date(dateString);
      return date.toLocaleDateString("en-GB", {
        weekday: "short",
        day: "2-digit",
        month: "short",
        year: "numeric",
      });
    };

    const formatCurrency = (amount) => {
      return parseFloat(amount || 0).toFixed(2);
    };

    const itemsHTML = items
      .map(
        (item, index) => `
      <tr>
        <td style="padding: 8px 12px; border: 1px solid #ddd; font-size: 12px; text-align: left;">${index + 1
          }. [${item.material_id || "N/A"}] ${item.material_name || `Material ${index + 1}`
          }</td>
        <td style="padding: 8px 12px; border: 1px solid #ddd; font-size: 12px; text-align: right;">₹${formatCurrency(
            item.rate
          )}</td>
        <td style="padding: 8px 12px; border: 1px solid #ddd; font-size: 12px; text-align: right;">${item.quantity
          }</td>
      </tr>
    `
      )
      .join("");

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>Purchase Order #${purchase_order_id}</title>
        <style>
          @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
          
          * {
            box-sizing: border-box;
          }
          
          body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            margin: 0;
            padding: 0;
            color: #000;
            background-color: #ffffff;
            line-height: 1.4;
            font-size: 12px;
          }
          
          .page {
            width: 210mm;
            height: 297mm;
            margin: 0 auto;
            background: white;
            position: relative;
            page-break-after: always;
          }
          
          .page:last-child {
            page-break-after: avoid;
          }
          
          .header {
            padding: 15px 20px;
            border-bottom: 1px solid #ddd;
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
          }
          
          .header-left {
            flex: 1;
          }
          
          .logo-section {
            display: flex;
            align-items: center;
            margin-bottom: 10px;
          }
          
          .logo {
            width: 200px;
            height: auto;
            margin-right: 10px;
          }
          
          .header-right {
            text-align: right;
            flex: 1;
          }
          
          .warehouse-info {
            font-size: 10px;
            color: #666;
            margin-bottom: 15px;
          }
          
          .po-details {
            background: #f8f9fa;
            padding: 10px;
            border-radius: 4px;
            font-size: 11px;
          }
          
          .po-detail-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 4px;
          }
          
          .po-detail-row:last-child {
            margin-bottom: 0;
          }
          
          .po-label {
            font-weight: 600;
            color: #333;
          }
          
          .po-value {
            color: #000;
          }
          
          .address-section {
            padding: 20px;
            display: flex;
            justify-content: space-between;
            gap: 20px;
          }
          
          .address-box {
            flex: 0.5;
            border: 1px solid #ddd;
            padding: 15px;
            border-radius: 4px;
          }
          
          .address-title {
            font-size: 14px;
            font-weight: 700;
            color: #000;
            margin-bottom: 10px;
            text-transform: uppercase;
          }
          
          .address-content {
            font-size: 11px;
            line-height: 1.4;
          }
          
          .address-line {
            margin-bottom: 4px;
          }
          
          .order-summary {
            padding: 0 20px 20px;
            display: flex;
            gap: 20px;
          }
          
          .intent-box {
            flex: 2;
            background: #e3f2fd;
            padding: 15px;
            border-radius: 4px;
            font-size: 11px;
            line-height: 1.4;
          }
          
          .cost-summary {
            flex: 1;
            background: #f8f9fa;
            padding: 15px;
            border-radius: 4px;
          }
          
          .cost-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 8px;
            font-size: 12px;
          }
          
          .cost-row:last-child {
            margin-bottom: 0;
            font-weight: 700;
            font-size: 14px;
          }
          
          .items-section {
            padding: 0 20px 20px;
          }
          
          .items-table {
            width: 100%;
            border-collapse: collapse;
            border: 1px solid #ddd;
          }
          
          .items-table th {
            background: #495057;
            color: white;
            padding: 10px 12px;
            text-align: left;
            font-weight: 600;
            font-size: 11px;
            text-transform: uppercase;
          }
          
          .items-table td {
            padding: 8px 12px;
            border: 1px solid #ddd;
            font-size: 11px;
          }
          
          .items-table tr:nth-child(even) {
            background-color: #f8f9fa;
          }
          
          .signature-section {
            padding: 20px;
            display: flex;
            justify-content: space-between;
            gap: 40px;
            margin-top: 20px;
          }
          
          .signature-box {
            flex: 1;
            border: 2px solid #ddd;
            height: 80px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 14px;
            font-weight: 600;
            color: #666;
          }
          
          .signature-label {
            text-align: center;
            margin-top: 10px;
            font-size: 11px;
            color: #333;
          }
          
          .important-section {
            padding: 20px;
            margin-top: 20px;
          }
          
          .important-box {
            background: #e3f2fd;
            padding: 20px;
            border-radius: 4px;
          }
          
          .important-title {
            font-size: 14px;
            font-weight: 700;
            color: #000;
            margin-bottom: 10px;
            text-transform: uppercase;
          }
          
          .important-content {
            font-size: 11px;
            line-height: 1.4;
          }
          
          .footer {
            position: absolute;
            bottom: 15px;
            left: 20px;
            font-size: 10px;
            color: #666;
          }
          
          @media print {
            .page {
              page-break-after: always;
            }
            .page:last-child {
              page-break-after: avoid;
            }
          }
        </style>
      </head>
      <body>
        <!-- Page 1 -->
        <div class="page">
          <div class="header">
            <div class="header-left">
              <div class="logo-section">
                <img src="https://dnds.co.in/assets/dnds-logo.png" alt="DNDS Logo" class="logo">
              </div>
            </div>
            
            <div class="header-right">
              <div class="warehouse-info">#${purchase_order_id} ${purchase_order_ref ? `[${purchase_order_ref}]` : ""
      }, warehouse</div>
              <div class="po-details">
                <div class="po-detail-row">
                  <span class="po-label">Date:</span>
                  <span class="po-value">${formatDate(date)}</span>
                </div>
                <div class="po-detail-row">
                  <span class="po-label">Phone:</span>
                  <span class="po-value">9788599944</span>
                </div>
                <div class="po-detail-row">
                  <span class="po-label">Email:</span>
                  <span class="po-value">Info@dailyneeds.co.in</span>
                </div>
              </div>
            </div>
          </div>
          
          <div class="address-section">
            <div class="address-box">
              <div class="address-title">Bill To</div>
              <div class="address-content">
                <div class="address-line">DailyNeeds Warehouse</div>
                <div class="address-line">188/1,Iyyanar Koil Street, Muthirapalayam</div>
                <div class="address-line">Puducherry, Pondicherry-605009</div>
                <div class="address-code">34AAJFD4987C1ZD</div>
              </div>
            </div>
          </div>
          
          <div class="order-summary">
            <div class="intent-box">
              This purchase order is an intent to procure ${items.length
      } articles listed in the following pages. PS: GST and Landing Cost (Net Cost) consider discounts seen in the last delivery.
            </div>
            
            <div class="cost-summary">
              <div class="cost-row">
                <span>Gross:</span>
                <span>₹ ${formatCurrency(subtotal)}</span>
              </div>
              <div class="cost-row">
                <span>GST:</span>
                <span>₹ ${formatCurrency(tax)}</span>
              </div>
              <div class="cost-row">
                <span>Net:</span>
                <span>₹ ${formatCurrency(total_amount)}</span>
              </div>
            </div>
          </div>
          
          <div class="items-section">
            <table class="items-table">
              <thead>
                <tr>
                  <th>PRODUCT NAME</th>
                  <th>COST</th>
                  <th>QTY</th>
                </tr>
              </thead>
              <tbody>
                ${itemsHTML}
              </tbody>
            </table>
          </div>
          
          <div class="signature-section">
            <div style="flex: 1;">
              <div class="signature-box">SIGN HERE</div>
              <div class="signature-label">Prepared By<br>(Purchase Head)</div>
            </div>
            <div style="flex: 1;">
              <div class="signature-box">SIGN HERE</div>
              <div class="signature-label">Approved By<br>(Business Head)</div>
            </div>
          </div>
          
          <div class="important-section">
            <div class="important-box">
              <div class="important-title">Important - Please Read</div>
              <div class="important-content">
                Make sure to follow the purchase terms and conditions to avoid unwanted misunderstanding at a later point in time. Reach out to us in case of any clarifications or modifications to this purchase order.
              </div>
            </div>
          </div>
          
          <div class="footer">
            Generated using DailyNeeds System - #${purchase_order_id} [${purchase_order_ref || "N/A"
      }], Created: ${formatDate(date)}
          </div>
        </div>
      </body>
      </html>
    `;
  }

  async generateProductSalesOffersBulkPDF(data) {
    let browser;
    try {
      browser = await puppeteer.launch(buildPuppeteerLaunchOptions());
      const page = await browser.newPage();
      const htmlContent = this.generateProductSalesOffersBulkHTML(data);
      await page.setContent(htmlContent, { waitUntil: "networkidle0" });
      const pdfBuffer = await page.pdf({
        format: "A4",
        printBackground: true,
        margin: {
          top: "10mm",
          right: "10mm",
          bottom: "10mm",
          left: "10mm",
        },
        preferCSSPageSize: true,
      });
      await page.close();
      await browser.close();
      return pdfBuffer;
    } catch (error) {
      if (browser) {
        try {
          await browser.close();
        } catch (e) { }
      }
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "SERVICE",
        code: "SERVICE.PDF.GENERATE_PRODUCT_SALES_OFFERS",
        description: error.toString(),
        category: "",
        ref: {},
      });
      throw error;
    }
  }

  generateProductSalesOffersBulkHTML(data) {
    const { generatedAt, belowBufferRows = [], otherRows = [] } = data;

    const escapeHtml = (s) =>
      String(s == null ? "" : s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

    const formatQty = (n) => {
      const x = Number(n);
      if (!Number.isFinite(x)) return "—";
      if (Math.abs(x - Math.round(x)) < 1e-9) return String(Math.round(x));
      return String(x);
    };

    const formatDateTime = (d) => {
      const dt = d instanceof Date ? d : new Date(d);
      if (Number.isNaN(dt.getTime())) return "N/A";
      return dt.toLocaleString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    };

    const sortByRemainingAsc = (rows) =>
      [...(rows || [])].sort((a, b) => {
        const ra = Number(a.remaining);
        const rb = Number(b.remaining);
        const fa = Number.isFinite(ra);
        const fb = Number.isFinite(rb);
        if (!fa && !fb) return 0;
        if (!fa) return 1;
        if (!fb) return -1;
        return ra - rb;
      });

    const buildRows = (rows) => {
      if (!rows.length) {
        return `<tr>
          <td colspan="5" style="padding: 12px; border: 1px solid #ddd; font-size: 11px; color: #666; text-align: center;">
            No products in this category.
          </td>
        </tr>`;
      }
      return rows
        .map((r) => {
          const remNum = Number(r.remaining);
          const remNeg =
            Number.isFinite(remNum) && remNum < 0
              ? "color: #c62828; font-weight: 600;"
              : "";
          return `
        <tr>
          <td style="padding: 8px 12px; border: 1px solid #ddd; font-size: 11px; text-align: left;">${escapeHtml(
            r.item_code != null ? String(r.item_code) : "—"
          )}</td>
          <td style="padding: 8px 12px; border: 1px solid #ddd; font-size: 11px; text-align: left;">${escapeHtml(
            r.product_name || "—"
          )}</td>
          <td style="padding: 8px 12px; border: 1px solid #ddd; font-size: 11px; text-align: right;">${escapeHtml(
            formatQty(
              r.purchased_stock != null ? r.purchased_stock : r.stock_input
            )
          )}</td>
          <td style="padding: 8px 12px; border: 1px solid #ddd; font-size: 11px; text-align: right;">${escapeHtml(
            formatQty(r.stock_output)
          )}</td>
          <td style="padding: 8px 12px; border: 1px solid #ddd; font-size: 11px; text-align: right; ${remNeg}">${escapeHtml(
            formatQty(r.remaining)
          )}</td>
        </tr>`;
        })
        .join("");
    };

    const belowHtml = buildRows(sortByRemainingAsc(belowBufferRows));
    const otherHtml = buildRows(sortByRemainingAsc(otherRows));

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>Product offers — sales bulk summary</title>
        <style>
          @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
          * { box-sizing: border-box; }
          body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            margin: 0;
            padding: 0;
            color: #000;
            background: #ffffff;
            line-height: 1.4;
            font-size: 12px;
          }
          .page {
            width: 210mm;
            margin: 0 auto;
            background: white;
            position: relative;
            padding-bottom: 40px;
          }
          .header {
            padding: 15px 20px;
            border-bottom: 1px solid #ddd;
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
          }
          .header-left {
            flex: 1;
          }
          .logo-section {
            display: flex;
            align-items: center;
            margin-bottom: 10px;
          }
          .logo { width: 200px; height: auto; margin-right: 10px; }
          .header-right { text-align: right; flex: 1; }
          .warehouse-info { font-size: 10px; color: #666; margin-bottom: 8px; }
          .po-details {
            background: #f8f9fa;
            padding: 10px;
            border-radius: 4px;
            font-size: 11px;
          }
          .po-detail-row { display: flex; justify-content: space-between; margin-bottom: 4px; }
          .po-detail-row:last-child { margin-bottom: 0; }
          .po-label { font-weight: 600; color: #333; }
          .po-value { color: #000; }
          .section-title {
            font-size: 14px;
            font-weight: 700;
            color: #000;
            margin: 20px 20px 10px;
            text-transform: uppercase;
          }
          .items-section { padding: 0 20px 16px; }
          .items-table {
            width: 100%;
            border-collapse: collapse;
            border: 1px solid #ddd;
          }
          .items-table th {
            background: #495057;
            color: white;
            padding: 10px 12px;
            text-align: left;
            font-weight: 600;
            font-size: 11px;
            text-transform: uppercase;
          }
          .items-table th.num { text-align: right; }
          .items-table td { padding: 8px 12px; border: 1px solid #ddd; font-size: 11px; }
          .items-table tr:nth-child(even) { background-color: #f8f9fa; }
          .intent-box {
            margin: 0 20px 16px;
            background: #e3f2fd;
            padding: 12px 15px;
            border-radius: 4px;
            font-size: 11px;
            line-height: 1.4;
          }
          .footer {
            position: absolute;
            bottom: 12px;
            left: 20px;
            right: 20px;
            font-size: 10px;
            color: #666;
          }
        </style>
      </head>
      <body>
        <div class="page">
          <div class="header">
            <div class="header-left">
              <div class="logo-section">
                <img src="https://dnds.co.in/assets/dnds-logo.png" alt="DNDS Logo" class="logo">
              </div>
            </div>
            <div class="header-right">
              <div class="warehouse-info">Product offers — bulk sales</div>
              <div class="po-details">
                <div class="po-detail-row">
                  <span class="po-label">Generated:</span>
                  <span class="po-value">${escapeHtml(formatDateTime(generatedAt))}</span>
                </div>
              </div>
            </div>
          </div>

          <div class="intent-box">
            Summary of products affected by this sales bulk upload. Purchased stock is opening stock plus received into the offer (opening_stock + stock_input). Remaining is purchased stock minus sold stock. Table 1 lists products at or below the offer stock buffer; table 2 lists other products updated in the same batch.
          </div>

          <div class="section-title">Below buffer threshold</div>
          <div class="items-section">
            <table class="items-table">
              <thead>
                <tr>
                  <th>Item code</th>
                  <th>Product name</th>
                  <th class="num">Purchased stock</th>
                  <th class="num">Sold stock</th>
                  <th class="num">Remaining stock</th>
                </tr>
              </thead>
              <tbody>${belowHtml}</tbody>
            </table>
          </div>

          <div class="section-title">Other updates (this bulk)</div>
          <div class="items-section">
            <table class="items-table">
              <thead>
                <tr>
                  <th>Item code</th>
                  <th>Product name</th>
                  <th class="num">Purchased stock</th>
                  <th class="num">Sold stock</th>
                  <th class="num">Remaining stock</th>
                </tr>
              </thead>
              <tbody>${otherHtml}</tbody>
            </table>
          </div>

          <div class="footer">
            Generated using DailyNeeds System — Product offers sales bulk summary
          </div>
        </div>
      </body>
      </html>
    `;
  }

  async generateStockCheckerPendingReportPDF(data) {
    let browser;
    try {
      browser = await puppeteer.launch(buildPuppeteerLaunchOptions());
      const page = await browser.newPage();
      const htmlContent = this.generateStockCheckerPendingReportHTML(data);
      await page.setContent(htmlContent, { waitUntil: "networkidle0" });
      const pdfBuffer = await page.pdf({
        format: "A4",
        printBackground: true,
        margin: {
          top: "10mm",
          right: "10mm",
          bottom: "10mm",
          left: "10mm",
        },
        preferCSSPageSize: true,
      });
      await page.close();
      await browser.close();
      return pdfBuffer;
    } catch (error) {
      if (browser) {
        try {
          await browser.close();
        } catch (e) { }
      }
      logger.Log({
        level: logger.LEVEL.ERROR,
        component: "SERVICE",
        code: "SERVICE.PDF.GENERATE_STOCK_CHECKER_PENDING",
        description: error.toString(),
        category: "",
        ref: {},
      });
      throw error;
    }
  }

  generateStockCheckerPendingReportHTML(data) {
    const { generatedAt, sections = [] } = data;

    const escapeHtml = (s) =>
      String(s == null ? "" : s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

    const formatDateTime = (d) => {
      const dt = d instanceof Date ? d : new Date(d);
      if (Number.isNaN(dt.getTime())) return "N/A";
      return dt.toLocaleString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    };

    const sectionBlocks = (sections || [])
      .map((sec) => {
        const rowsHtml = (sec.rows || [])
          .map(
            (r) => `
        <tr>
          <td style="padding: 8px 12px; border: 1px solid #ddd; font-size: 11px; text-align: left;">${escapeHtml(
              r.product_id == null ? "-" : String(r.product_id)
            )}</td>
          <td style="padding: 8px 12px; border: 1px solid #ddd; font-size: 11px; text-align: left;">${escapeHtml(
              r.product_name || "-"
            )}</td>
        </tr>`
          )
          .join("");
        return `
          <div class="sc-block" style="margin-bottom: 24px; page-break-inside: avoid; padding: 0 20px;">
            <div style="margin: 16px 0 10px 0; font-size: 14px; color: #000; text-transform: uppercase;">
              Branch: <span style="font-weight: 700;">${escapeHtml(sec.branch_name || "-")}</span>
            </div>
            <div class="items-section" style="padding: 0 0 8px 0;">
              <table class="items-table" style="width: 100%; border-collapse: collapse; border: 1px solid #ddd;">
                <thead>
                  <tr>
                    <th style="background: #495057; color: white; padding: 10px 12px; text-align: left; font-weight: 600; font-size: 11px; text-transform: uppercase;">Product Id</th>
                    <th style="background: #495057; color: white; padding: 10px 12px; text-align: left; font-weight: 600; font-size: 11px; text-transform: uppercase;">Name</th>
                  </tr>
                </thead>
                <tbody>${rowsHtml}</tbody>
              </table>
            </div>
          </div>`;
      })
      .join("");

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>Pending stock checks</title>
        <style>
          @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
          * { box-sizing: border-box; }
          body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            margin: 0;
            padding: 0;
            color: #000;
            background: #ffffff;
            line-height: 1.4;
            font-size: 12px;
          }
          .page { width: 210mm; margin: 0 auto; background: white; position: relative; padding-bottom: 36px; }
          .header {
            padding: 15px 20px;
            border-bottom: 1px solid #ddd;
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
          }
          .header-left { flex: 1; }
          .logo-section { display: flex; align-items: center; margin-bottom: 10px; }
          .logo { width: 200px; height: auto; margin-right: 10px; }
          .header-right { text-align: right; flex: 1; }
          .warehouse-info { font-size: 10px; color: #666; margin-bottom: 8px; }
          .po-details { background: #f8f9fa; padding: 10px; border-radius: 4px; font-size: 11px; }
          .po-detail-row { display: flex; justify-content: space-between; margin-bottom: 4px; }
          .po-label { font-weight: 600; color: #333; }
          .items-table tr:nth-child(even) { background-color: #f8f9fa; }
          .footer {
            position: absolute;
            bottom: 12px;
            left: 20px;
            right: 20px;
            font-size: 10px;
            color: #666;
          }
        </style>
      </head>
      <body>
        <div class="page">
          <div class="header">
            <div class="header-left">
              <div class="logo-section">
                <img src="https://dnds.co.in/assets/dnds-logo.png" alt="DNDS Logo" class="logo">
              </div>
            </div>
            <div class="header-right">
              <div class="warehouse-info">Pending stock checks - daily report</div>
              <div class="po-details">
                <div class="po-detail-row">
                  <span class="po-label">Generated:</span>
                  <span>${escapeHtml(formatDateTime(generatedAt))}</span>
                </div>
              </div>
            </div>
          </div>
          ${sectionBlocks}
          <div class="footer">
            Generated using DailyNeeds System - Pending stock checks
          </div>
        </div>
      </body>
      </html>
    `;
  }
}

module.exports = new PDFService();
