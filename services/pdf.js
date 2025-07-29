const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const logger = require("../utils/logger");

class PDFService {
  constructor() {
    this.browser = null;
  }

  async initializeBrowser() {
    if (!this.browser) {
      this.browser = await puppeteer.launch({
        headless: "new",
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
    }
    return this.browser;
  }

  async generatePurchaseOrderPDF(purchaseOrderData) {
    try {
      const browser = await this.initializeBrowser();
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
      return pdfBuffer;
    } catch (error) {
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
      return date.toLocaleDateString("en-GB");
    };

    const formatCurrency = (amount) => {
      return parseFloat(amount || 0).toFixed(2);
    };

    const itemsHTML = items
      .map(
        (item) => `
      <tr>
        <td style="padding: 16px 12px; border-bottom: 1px solid #e0e0e0; font-size: 14px;">${
          item.material_name || `Material ${item.material_id}`
        }</td>
        <td style="padding: 16px 12px; border-bottom: 1px solid #e0e0e0; text-align: center; font-size: 14px;">${
          item.quantity
        }</td>
        <td style="padding: 16px 12px; border-bottom: 1px solid #e0e0e0; text-align: center; font-size: 14px;">${
          item.stock || ""
        }</td>
        <td style="padding: 16px 12px; border-bottom: 1px solid #e0e0e0; text-align: right; font-size: 14px;">₹${formatCurrency(
          item.rate
        )}</td>
        <td style="padding: 16px 12px; border-bottom: 1px solid #e0e0e0; text-align: right; font-size: 14px;">₹${formatCurrency(
          item.quantity * item.rate
        )}</td>
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
            padding: 40px;
            color: #2d3748;
            background-color: #ffffff;
            line-height: 1.6;
          }
          
          .container {
            max-width: 800px;
            margin: 0 auto;
            background: white;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05);
            border-radius: 12px;
            overflow: hidden;
            word-wrap: break-word;
            overflow-wrap: break-word;
          }
          
          .header {
            background: #667eea;
            color: white;
            padding: 40px;
            text-align: center;
            position: relative;
          }
          
          .logo {
            width: 120px;
            height: auto;
            margin-bottom: 20px;
            filter: brightness(0) invert(1);
          }
          
          .header h1 {
            margin: 0;
            font-size: 32px;
            font-weight: 700;
            letter-spacing: 1px;
            text-transform: uppercase;
          }
          
          .header-subtitle {
            margin-top: 8px;
            font-size: 16px;
            font-weight: 300;
            opacity: 0.9;
          }
          
          .content {
            padding: 40px;
            word-wrap: break-word;
            overflow-wrap: break-word;
          }
          
          .order-info {
            display: flex;
            justify-content: space-between;
            gap: 40px;
            margin-bottom: 40px;
            background: #f8fafc;
            padding: 30px;
            border-radius: 8px;
            border-left: 4px solid #667eea;
          }
          
          .order-details {
            flex: 1;
            min-width: 0;
            word-wrap: break-word;
            overflow-wrap: break-word;
          }
          
          .order-details h3 {
            margin: 0 0 20px 0;
            color: #667eea;
            font-size: 18px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
          }
          
          .detail-row {
            display: flex;
            margin-bottom: 12px;
            gap: 10px;
          }
          
          .detail-label {
            font-weight: 600;
            color: #4a5568;
            font-size: 14px;
            flex-shrink: 0;
          }
          
          .detail-value {
            flex: 1;
            color: #2d3748;
            font-weight: 500;
            font-size: 14px;
            word-wrap: break-word;
            overflow-wrap: break-word;
            hyphens: auto;
          }
          
          .items-section {
            margin-bottom: 40px;
          }
          
          .section-title {
            font-size: 20px;
            font-weight: 600;
            color: #667eea;
            margin-bottom: 20px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
          }
          
          .items-table {
            width: 100%;
            border-collapse: collapse;
            background: white;
            border-radius: 8px;
            overflow: hidden;
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
          }
          
          .items-table th {
            background: #f8fafc;
            color: #4a5568;
            padding: 16px 12px;
            text-align: left;
            font-weight: 600;
            font-size: 14px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            word-wrap: break-word;
            overflow-wrap: break-word;
            border-bottom: 1px solid #e2e8f0;
          }
          
          .items-table td {
            padding: 16px 12px;
            border-bottom: 1px solid #f1f5f9;
            font-size: 14px;
            word-wrap: break-word;
            overflow-wrap: break-word;
            hyphens: auto;
            max-width: 0;
          }
          
          .items-table tr:hover {
            background-color: #f8fafc;
          }
          
          .summary-section {
            display: flex;
            justify-content: flex-end;
            margin-top: 40px;
          }
          
          .summary {
            width: 350px;
            background: #f8fafc;
            padding: 30px;
            border-radius: 12px;
            border: 2px solid #e2e8f0;
            word-wrap: break-word;
            overflow-wrap: break-word;
          }
          
          .summary-title {
            font-size: 18px;
            font-weight: 600;
            color: #667eea;
            margin-bottom: 20px;
            text-align: center;
            text-transform: uppercase;
            letter-spacing: 0.5px;
          }
          
          .summary-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 16px;
            padding-bottom: 8px;
            border-bottom: 1px solid #e2e8f0;
          }
          
          .summary-row:last-child {
            border-bottom: none;
          }
          
          .summary-label {
            font-weight: 500;
            color: #4a5568;
            font-size: 14px;
            word-wrap: break-word;
            overflow-wrap: break-word;
            flex-shrink: 0;
          }
          
          .summary-value {
            text-align: right;
            font-weight: 600;
            color: #2d3748;
            font-size: 14px;
            word-wrap: break-word;
            overflow-wrap: break-word;
            flex-shrink: 0;
          }
          
          .total {
            font-weight: 700;
            font-size: 20px;
            color: #667eea;
            border-top: 2px solid #667eea;
            padding-top: 16px;
            margin-top: 16px;
          }
          
          .footer {
            margin-top: 40px;
            padding: 20px;
            background: #f8fafc;
            border-radius: 8px;
            text-align: center;
            color: #718096;
            font-size: 12px;
          }
          
          @media print {
            body {
              padding: 0;
            }
            .container {
              box-shadow: none;
              border-radius: 0;
            }
          }
          
          /* Page break handling */
          .header {
            page-break-inside: avoid;
            break-inside: avoid;
          }
          
          .order-info {
            page-break-inside: avoid;
            break-inside: avoid;
          }
          
          .items-section {
            page-break-inside: auto;
            break-inside: auto;
          }
          
          .items-table {
            page-break-inside: auto;
            break-inside: auto;
          }
          
          .items-table tr {
            page-break-inside: avoid;
            break-inside: avoid;
          }
          
          .summary-section {
            page-break-inside: avoid;
            break-inside: avoid;
          }
          
          .footer {
            page-break-inside: avoid;
            break-inside: avoid;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <img src="https://www.dailyneeds.in/assets/logo.png" alt="DailyNeeds Logo" class="logo">
            <h1>Purchase Order</h1>
            <div class="header-subtitle">Professional Business Document</div>
          </div>
          
          <div class="content">
            <div class="order-info">
              <div class="order-details">
                <h3>Vendor Information</h3>
                <div class="detail-row">
                  <span class="detail-label">Vendor Name:</span>
                  <span class="detail-value">${vendor_name || "N/A"}</span>
                </div>
              </div>
              
              <div class="order-details">
                <h3>Order Information</h3>
                <div class="detail-row">
                  <span class="detail-label">Purchase Order #:</span>
                  <span class="detail-value">${purchase_order_id}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">Date:</span>
                  <span class="detail-value">${formatDate(date)}</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">Purchase Reference #:</span>
                  <span class="detail-value">${
                    purchase_order_ref || "N/A"
                  }</span>
                </div>
                <div class="detail-row">
                  <span class="detail-label">Delivery Date:</span>
                  <span class="detail-value">${formatDate(delivery_date)}</span>
                </div>
              </div>
            </div>

            <div class="items-section">
              <div class="section-title">Order Items</div>
              <table class="items-table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th style="text-align: center;">Quantity</th>
                    <th style="text-align: center;">Stock</th>
                    <th style="text-align: right;">Rate</th>
                    <th style="text-align: right;">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  ${itemsHTML}
                </tbody>
              </table>
            </div>

            <div class="summary-section">
              <div class="summary">
                <div class="summary-title">Order Summary</div>
                <div class="summary-row">
                  <span class="summary-label">Sub Total:</span>
                  <span class="summary-value">₹${formatCurrency(
                    subtotal
                  )}</span>
                </div>
                <div class="summary-row">
                  <span class="summary-label">Discount:</span>
                  <span class="summary-value">₹${formatCurrency(
                    discount
                  )}</span>
                </div>
                <div class="summary-row">
                  <span class="summary-label">Tax:</span>
                  <span class="summary-value">₹${formatCurrency(tax)}</span>
                </div>
                <div class="summary-row">
                  <span class="summary-label">Adjustment:</span>
                  <span class="summary-value">₹${formatCurrency(
                    adjustment
                  )}</span>
                </div>
                <div class="summary-row total">
                  <span class="summary-label">Total:</span>
                  <span class="summary-value">₹${formatCurrency(
                    total_amount
                  )}</span>
                </div>
              </div>
            </div>
            
            <div class="footer">
              <p>Thank you for your business! This document was generated by DailyNeeds.</p>
            </div>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  async closeBrowser() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

module.exports = new PDFService();
