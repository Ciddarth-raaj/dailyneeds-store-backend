const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const logger = require("../utils/logger");

class PDFService {
  async generatePurchaseOrderPDF(purchaseOrderData) {
    let browser;
    try {
      browser = await puppeteer.launch({
        headless: "new",
        executablePath: "/usr/bin/google-chrome-stable",
        dumpio: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--single-process",
          "--disable-background-timer-throttling",
          "--disable-background-networking",
          "--disable-breakpad",
          "--disable-default-apps",
          "--disable-extensions",
          "--disable-gpu",
          "--disable-sync",
          "--disable-translate",
          "--hide-scrollbars",
          "--metrics-recording-only",
          "--mute-audio",
          "--no-first-run",
          "--no-zygote",
          "--disable-features=site-per-process",
          "--disable-features=IsolateOrigins",
          "--js-flags=--lite-mode",
        ],
        timeout: 0,
      });
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
        } catch (e) {}
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
        <td style="padding: 8px 12px; border: 1px solid #ddd; font-size: 12px; text-align: left;">${
          index + 1
        }. [${item.material_id || "N/A"}] ${
          item.material_name || `Material ${index + 1}`
        }</td>
        <td style="padding: 8px 12px; border: 1px solid #ddd; font-size: 12px; text-align: right;">₹${formatCurrency(
          item.rate
        )}</td>
        <td style="padding: 8px 12px; border: 1px solid #ddd; font-size: 12px; text-align: right;">${
          item.quantity
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
                <img src="https://www.dailyneeds.in/assets/logo.png" alt="DailyNeeds Logo" class="logo">
              </div>
            </div>
            
            <div class="header-right">
              <div class="warehouse-info">#${purchase_order_id} ${
      purchase_order_ref ? `[${purchase_order_ref}]` : ""
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
              This purchase order is an intent to procure ${
                items.length
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
            Generated using DailyNeeds System - #${purchase_order_id} [${
      purchase_order_ref || "N/A"
    }], Created: ${formatDate(date)}
          </div>
        </div>
      </body>
      </html>
    `;
  }
}

module.exports = new PDFService();
