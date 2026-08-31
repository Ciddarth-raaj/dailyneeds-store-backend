global.env =
  process.env.NODE_ENV === undefined ? "development" : process.env.NODE_ENV;
global.isDev = () => {
  return global.env === "development";
};

const PORT = process.env.PORT === undefined ? 8080 : process.env.PORT;

const express = require("express");
const app = express();
const compression = require("compression");
const bodyParser = require("body-parser");
const HttpServer = require("http").createServer(app);

const logger = require("./utils/logger");
const { ALERTS_TELEGRAM_CHAT_ID } = require("./constants/telegram");

class Server {
  constructor() {
    this.drivers = [];
    this.init();
  }

  async init() {
    try {
      await this.initDrivers();

      this.initRepositories();
      const SandboxService = require("./services/sandbox");
      this.sandboxService = new SandboxService({
        gstTaxpayerSessionRepo: this.sandboxGstTaxpayerSessionRepo,
      });
      await this.sandboxService.initialize();
      this.initUsecases();
      this.initExpress();
      this.initRoutes();
      this.initServices();
      this.initServer();
    } catch (err) {
      process.exit(err);
    }
  }

  initExpress() {
    app.use(require("cors")());

    const colours = {
      GET: "\x1b[32m",
      POST: "\x1b[34m",
      DELETE: "\x1b[31m",
      PUT: "\x1b[33m",
    };
    app.use("*", (req, _, next) => {
      if (global.isDev()) {
        console.log(colours[req.method] + req.method, "\x1b[0m" + req.baseUrl);
      }
      next();
    });

    //Enable request compression
    app.use(compression());
    app.use(bodyParser.json({ limit: "120mb" }));
    app.use(
      bodyParser.urlencoded({
        // to support URL-encoded bodies
        extended: true,
      })
    );
    app.use(express.static(__dirname + "/views", { maxAge: "30 days" }));
  }

  initServer() {
    // Large ZIP downloads can take much longer; avoid cutting active streams.
    HttpServer.timeout = 0;
    HttpServer.requestTimeout = 0;
    HttpServer.listen(PORT, () => {
      console.log(`Server Running ${PORT}`);
    });
  }

  initDrivers() {
    return new Promise(async (resolve, reject) => {
      try {
        this.mysql = await require("./drivers/mysql")().connect();
        this.mysqlGofrugal =
          await require("./drivers/mysql_gofrugal")().connect();
        //this.mongo = require('./models/mongo')().connect();

        this.drivers.push(this.mysql);
        this.drivers.push(this.mysqlGofrugal);
        //this.models.push(this.mongo);

        resolve();
      } catch (err) {
        reject(err);
      }
    });
  }

  initRepositories() {
    this.documentRepo = require("./repository/document")(this.mysql.connection);
    this.whatsappRepo = require("./repository/whatsapp")(this.mysql.connection);
    this.budgetRepo = require("./repository/budget")(this.mysql.connection);
    this.issueRepo = require("./repository/issue")(this.mysql.connection);
    this.exampleRepo = require("./repository/example")(this.mysql.connection);
    this.gstVendorRepo = require("./repository/gst_vendor")(
      this.mysql.connection
    );
    this.gstFetchLogRepo = require("./repository/gst_fetch_log")(
      this.mysql.connection
    );
    this.gstB2bRepo = require("./repository/gst_b2b")(this.mysql.connection);
    this.gstB2bInvoiceRepo = require("./repository/gst_b2b_invoice")(
      this.mysql.connection
    );
    this.gstB2bInvoiceItemRepo = require("./repository/gst_b2b_invoice_item")(
      this.mysql.connection
    );
    this.vendorFilingDateRepo = require("./repository/vendor_filing_date")(
      this.mysql.connection
    );
    this.sandboxGstTaxpayerSessionRepo =
      require("./repository/sandbox_gst_taxpayer_session")(
        this.mysql.connection
      );
    this.departmentRepo = require("./repository/department")(
      this.mysql.connection
    );
    this.designationRepo = require("./repository/designation")(
      this.mysql.connection
    );
    this.employeeRepo = require("./repository/employee")(this.mysql.connection);
    this.shiftRepo = require("./repository/shift")(this.mysql.connection);
    this.storeRepo = require("./repository/store")(this.mysql.connection);
    this.outletRepo = require("./repository/outlet")(this.mysql.connection);
    this.familyRepo = require("./repository/family")(this.mysql.connection);
    this.companyRepo = require("./repository/company")(this.mysql.connection);
    this.materialtypeRepo = require("./repository/materialtype")(
      this.mysql.connection
    );
    this.materialsizeRepo = require("./repository/materialsize")(
      this.mysql.connection
    );
    this.salaryRepo = require("./repository/salary")(this.mysql.connection);
    this.resignationRepo = require("./repository/resignation")(
      this.mysql.connection
    );
    this.productRepo = require("./repository/product")(this.mysql.connection);
    this.imageRepo = require("./repository/image")(this.mysql.connection);
    this.categoryRepo = require("./repository/category")(this.mysql.connection);
    this.subcategoryRepo = require("./repository/subcategory")(
      this.mysql.connection
    );
    this.brandRepo = require("./repository/brand")(this.mysql.connection);
    this.indentRepo = require("./repository/indent")(this.mysql.connection);
    this.despatchRepo = require("./repository/despatch")(this.mysql.connection);
    this.vehicleRepo = require("./repository/vehicle")(this.mysql.connection);
    this.userRepo = require("./repository/user")(this.mysql.connection);
    this.peopleRepo = require("./repository/people")(this.mysql.connection);
    this.accountsRepo = require("./repository/accounts")(this.mysql.connection);
    this.accountsEbookRepo = require("./repository/accountsEbook")(
      this.mysql.connection
    );
    this.reconciliationRepo = require("./repository/reconciliation")(
      this.mysql.connection
    );
    this.digitalPaymentsRepo = require("./repository/digital_payments")(
      this.mysql.connection
    );
    this.purchaseRepo = require("./repository/purchase")(this.mysql.connection);
    this.purchaseTallyRepo = require("./repository/purchase_tally")(
      this.mysql.connection
    );
    this.debitNoteTallyRepo = require("./repository/debit_note_tally")(
      this.mysql.connection
    );
    this.tallyRepo = require("./repository/tally")(this.mysql.connection);
    this.gstTallyPurchaseRepo = require("./repository/gst_tally_purchase")(
      this.mysql.connection
    );
    this.purchaseGstRepo = require("./repository/purchase_gst")(
      this.mysql.connection
    );
    this.gstPurchaseMatchRepo = require("./repository/gst_purchase_match")(
      this.mysql.connection
    );
    this.debitNoteRepo = require("./repository/debit_note")(
      this.mysql.connection
    );
    // Add materials repository
    this.materialsRepo = require("./repository/materials")(
      this.mysql.connection
    );
    this.materialRequestRepo = require("./repository/material_request")(
      this.mysql.connection
    );
    this.purchaseOrderRepo = require("./repository/purchase_order")(
      this.mysql.connection
    );
    this.invoiceRepo = require("./repository/invoice")(this.mysql.connection);
    this.repackItemRepo = require("./repository/repack_item")(
      this.mysql.connection
    );
    this.cleaningPackingRepo = require("./repository/cleaning_packing")(
      this.mysql.connection
    );
    this.ebConsumptionRepo = require("./repository/eb_consumption")(
      this.mysql.connection
    );
    this.ebMasterListRepo = require("./repository/eb_master_list")(
      this.mysql.connection
    );
    this.ticketRepo = require("./repository/ticket")(this.mysql.connection);
    this.telegramDepartmentsRepo = require("./repository/telegram_departments")(
      this.mysql.connection
    );
    this.jobWorksheetRepo = require("./repository/job_worksheet")(
      this.mysql.connection
    );
    this.stickerTypesRepo = require("./repository/sticker_types")(
      this.mysql.connection
    );
    this.productImageLogRepo = require("./repository/product_image_log")(
      this.mysql.connection
    );
    this.productImageDownloadJobRepo =
      require("./repository/product_image_download_job")(this.mysql.connection);
    this.gofrugalSynkerRepo = require("./repository/gofrugal_synker")(
      this.mysqlGofrugal.connection
    );
    this.purchaseReturnRepo = require("./repository/purchase_return")(
      this.mysql.connection,
      this.mysqlGofrugal.connection
    );
    this.productDistributorsRepo = require("./repository/product_distributors")(
      this.mysqlGofrugal.connection,
      this.mysql.connection
    );
    this.purchaseAcknowledgementRepo =
      require("./repository/purchase_acknowledgement")(
        this.mysql.connection,
        this.mysqlGofrugal.connection
      );
    this.remarksMasterRepo = require("./repository/remarks_master")(
      this.mysql.connection
    );
    this.pickPackRemarksRepo = require("./repository/pick_pack_remarks")(
      this.mysql.connection
    );
    this.pickPackWriteOffRepo = require("./repository/pick_pack_write_off")(
      this.mysql.connection
    );
    this.pickPackVerificationRemarksRepo = require("./repository/pick_pack_verification_remarks")(
      this.mysql.connection
    );
    this.pickPackVerificationsRepo = require("./repository/pick_pack_verifications")(
      this.mysql.connection
    );
    this.stockCheckerRepo = require("./repository/stock_checker")(
      this.mysql.connection
    );
    this.productsExpiryCheckerRepo =
      require("./repository/products_expiry_checker")(this.mysql.connection);
    this.stockTransferOutRepo = require("./repository/stock_transfer_out")(
      this.mysqlGofrugal.connection
    );
    this.stoCheckRepo = require("./repository/sto_check")(
      this.mysql.connection
    );
    this.offersV3Repo = require("./repository/offers_v3")(
      this.mysql.connection
    );
    this.salesDashboardRepo = require("./repository/sales_dashboard")(
      this.mysql.connection
    );
    this.productSalesRepo = require("./repository/product_sales")(
      this.mysql.connection
    );
    this.deadStockItemsRepo = require("./repository/dead_stock_items")(
      this.mysql.connection
    );
    this.stockReceivedRepo = require("./repository/stock_received")(
      this.mysql.connection,
      this.mysqlGofrugal.connection
    );
    this.purchaseRefRepo = require("./repository/purchase_ref")(
      this.mysql.connection
    );
    this.stockHoldingReportRepo = require("./repository/stock_holding_report")(
      this.mysql.connection
    );
    this.priceCheckerRepo = require("./repository/price_checker")(
      this.mysql.connection
    );
    this.itemMarkupdownRepo = require("./repository/item_markupdown")(
      this.mysql.connection
    );
    this.apiSyncLogRepo = require("./repository/api_sync_log")(
      this.mysql.connection
    );
    this.hqOffersRepo = require("./repository/hq_offers")(
      this.mysql.connection
    );
  }

  initUsecases() {
    this.documentUsecase = require("./usecase/document")(this.documentRepo);
    this.whatsappUsecase = require("./usecase/whatsapp")(this.whatsappRepo);
    this.budgetUsecase = require("./usecase/budget")(this.budgetRepo);
    this.issueUsecase = require("./usecase/issue")(
      this.issueRepo,
      this.indentRepo
    );
    this.vehicleUsecase = require("./usecase/vehicle")(this.vehicleRepo);
    this.exampleUsecase = require("./usecase/example")(this.exampleRepo);
    const { GstB2bSyncService } = require("./services/gst_b2b_sync");
    this.gstB2bSyncService = new GstB2bSyncService({
      gstB2bRepo: this.gstB2bRepo,
      gstB2bInvoiceRepo: this.gstB2bInvoiceRepo,
      gstB2bInvoiceItemRepo: this.gstB2bInvoiceItemRepo,
      vendorFilingDateRepo: this.vendorFilingDateRepo,
      gstPurchaseMatchRepo: this.gstPurchaseMatchRepo,
    });
    this.gstUsecase = require("./usecase/gst")(
      this.sandboxService,
      this.gstVendorRepo,
      this.gstFetchLogRepo,
      this.gstB2bSyncService,
      this.gstB2bRepo,
      this.gstB2bInvoiceRepo,
      this.gstB2bInvoiceItemRepo
    );
    this.departmentUsecase = require("./usecase/department")(
      this.departmentRepo
    );
    this.designationUsecase = require("./usecase/designation")(
      this.designationRepo
    );
    this.employeeUsecase = require("./usecase/employee")(
      this.employeeRepo,
      this.documentUsecase,
      this.userRepo,
      this.resignationRepo
    );
    this.shiftUsecase = require("./usecase/shift")(this.shiftRepo);
    this.storeUsecase = require("./usecase/store")(this.storeRepo);
    this.outletUsecase = require("./usecase/outlet")(
      this.outletRepo,
      this.budgetRepo
    );
    this.familyUsecase = require("./usecase/family")(this.familyRepo);
    this.companyUsecase = require("./usecase/company")(this.companyRepo);
    this.materialtypeUsecase = require("./usecase/materialtype")(
      this.materialtypeRepo
    );
    this.materialsizeUsecase = require("./usecase/materialsize")(
      this.materialsizeRepo
    );
    this.salaryUsecase = require("./usecase/salary")(this.salaryRepo);
    this.resignationUsecase = require("./usecase/resignation")(
      this.resignationRepo,
      this.employeeRepo,
      this.userRepo
    );
    this.productImageLogUsecase = require("./usecase/product_image_log")(
      this.productImageLogRepo
    );
    this.productUsecase = require("./usecase/product")(
      this.productRepo,
      this.productImageLogUsecase,
      this.productImageDownloadJobRepo
    );
    this.imageUsecase = require("./usecase/image")(this.imageRepo);
    this.assetUsecase = require("./usecase/asset");
    this.categoryUsecase = require("./usecase/category")(this.categoryRepo);
    this.subcategoryUsecase = require("./usecase/subcategory")(
      this.subcategoryRepo
    );
    this.brandUsecase = require("./usecase/brand")(this.brandRepo);
    this.indentUsecase = require("./usecase/indent")(this.indentRepo);
    this.despatchUsecase = require("./usecase/despatch")(
      this.despatchRepo,
      this.indentUsecase
    );
    this.userUsecase = require("./usecase/user")(
      this.userRepo,
      this.designationRepo,
      this.employeeRepo
    );
    this.peopleUsecase = require("./usecase/people")(this.peopleRepo);
    this.accountsEbookUsecase = require("./usecase/accountsEbook")(
      this.accountsEbookRepo
    );
    this.accountsUsecase = require("./usecase/accounts")(
      this.accountsRepo,
      this.accountsEbookUsecase,
      this.outletUsecase,
      this.employeeUsecase
    );
    this.reconciliationUsecase = require("./usecase/reconciliation")(
      this.reconciliationRepo
    );
    this.digitalPaymentsUsecase = require("./usecase/digital_payments")(
      this.digitalPaymentsRepo
    );
    this.purchaseUsecase = require("./usecase/purchase")(
      this.purchaseRepo,
      this.outletUsecase
    );
    this.purchaseTallyUsecase = require("./usecase/purchase_tally")(
      this.purchaseTallyRepo,
      this.gstTallyPurchaseRepo
    );
    this.debitNoteTallyUsecase = require("./usecase/debit_note_tally")(
      this.debitNoteTallyRepo
    );
    this.debitNoteUsecase = require("./usecase/debit_note")(this.debitNoteRepo);
    this.tallyUsecase = require("./usecase/tally")(
      this.tallyRepo,
      this.purchaseUsecase,
      this.accountsUsecase,
      this.debitNoteUsecase
    );
    this.gstTallyPurchaseUsecase = require("./usecase/gst_tally_purchase")(
      this.gstTallyPurchaseRepo,
      this.gstVendorRepo
    );
    this.purchaseGstUsecase = require("./usecase/purchase_gst")(
      this.purchaseGstRepo
    );
    this.gstPurchaseMatchUsecase = require("./usecase/gst_purchase_match")(
      this.gstPurchaseMatchRepo
    );
    // Add materials usecase
    this.materialsUsecase = require("./usecase/materials")(this.materialsRepo);
    this.materialRequestUsecase = require("./usecase/material_request")(
      this.materialRequestRepo,
      this.outletRepo
    );
    this.purchaseOrderUsecase = require("./usecase/purchase_order")(
      this.purchaseOrderRepo
    );
    this.invoiceUsecase = require("./usecase/invoice")(this.invoiceRepo);
    this.repackItemUsecase = require("./usecase/repack_item")(
      this.repackItemRepo
    );
    this.cleaningPackingUsecase = require("./usecase/cleaning_packing")(
      this.cleaningPackingRepo
    );
    this.ebConsumptionUsecase = require("./usecase/eb_consumption")(
      this.ebConsumptionRepo
    );
    this.ebMasterListUsecase = require("./usecase/eb_master_list")(
      this.ebMasterListRepo
    );
    this.telegramDepartmentsUsecase = require("./usecase/telegram_departments")(
      this.telegramDepartmentsRepo
    );
    this.ticketUsecase = require("./usecase/ticket")(
      this.ticketRepo,
      this.employeeUsecase,
      this.outletUsecase,
      this.telegramDepartmentsUsecase
    );
    this.jobWorksheetUsecase = require("./usecase/job_worksheet")(
      this.jobWorksheetRepo
    );
    this.stickerTypesUsecase = require("./usecase/sticker_types")(
      this.stickerTypesRepo
    );
    this.gofrugalSynkerUsecase = require("./usecase/gofrugal_synker")(
      this.gofrugalSynkerRepo
    );
    this.purchaseReturnUsecase = require("./usecase/purchase_return")(
      this.purchaseReturnRepo
    );
    this.productDistributorsUsecase = require("./usecase/product_distributors")(
      this.productDistributorsRepo
    );
    this.purchaseAcknowledgementUsecase =
      require("./usecase/purchase_acknowledgement")(
        this.purchaseAcknowledgementRepo
      );
    this.remarksMasterUsecase = require("./usecase/remarks_master")(
      this.remarksMasterRepo
    );
    this.pickPackRemarksUsecase = require("./usecase/pick_pack_remarks")(
      this.pickPackRemarksRepo
    );
    this.pickPackWriteOffUsecase = require("./usecase/pick_pack_write_off")(
      this.pickPackWriteOffRepo
    );
    this.pickPackVerificationRemarksUsecase = require("./usecase/pick_pack_verification_remarks")(
      this.pickPackVerificationRemarksRepo
    );
    this.pickPackVerificationsUsecase = require("./usecase/pick_pack_verifications")(
      this.pickPackVerificationsRepo
    );
    this.stockCheckerUsecase = require("./usecase/stock_checker")(
      this.stockCheckerRepo,
      this.outletRepo
    );
    this.productsExpiryCheckerUsecase =
      require("./usecase/products_expiry_checker")(
        this.productsExpiryCheckerRepo
      );
    this.stoCheckUsecase = require("./usecase/sto_check")(this.stoCheckRepo);
    this.stockTransferOutUsecase = require("./usecase/stock_transfer_out")(
      this.stockTransferOutRepo,
      this.outletUsecase,
      this.stoCheckUsecase
    );
    this.offersV3Usecase = require("./usecase/offers_v3")(
      this.offersV3Repo,
      this.outletRepo,
      this.priceCheckerRepo
    );
    this.productSalesUsecase = require("./usecase/product_sales")(
      this.productSalesRepo
    );
    this.salesDashboardUsecase = require("./usecase/sales_dashboard")(
      this.salesDashboardRepo
    );
    this.deadStockItemsUsecase = require("./usecase/dead_stock_items")(
      this.deadStockItemsRepo
    );
    this.grnUsecase = require("./usecase/grn")(
      this.stockReceivedRepo,
      this.priceCheckerRepo,
      this.hqOffersRepo,
      this.offersV3Repo
    );
    this.purchaseRefUsecase = require("./usecase/purchase_ref")(
      this.purchaseRefRepo,
      this.productSalesRepo,
      this.stockReceivedRepo,
      this.stockHoldingReportRepo
    );
    this.stockHoldingReportUsecase = require("./usecase/stock_holding_report")(
      this.stockHoldingReportRepo,
      this.outletRepo
    );
    this.priceCheckerUsecase = require("./usecase/price_checker")(
      this.priceCheckerRepo,
      this.itemMarkupdownRepo,
      this.hqOffersRepo,
      this.offersV3Repo
    );
    this.itemMarkupdownUsecase = require("./usecase/item_markupdown")(
      this.itemMarkupdownRepo
    );
    this.hqOffersUsecase = require("./usecase/hq_offers")(
      this.hqOffersRepo
    );
    this.apiSyncLogUsecase = require("./usecase/api_sync_log")(
      this.apiSyncLogRepo
    );
    const ApiSyncLogger = require("./utils/api_sync_logger");
    this.apiSyncLogger = new ApiSyncLogger(this.apiSyncLogRepo);
    this.synker = require("./services/synker")(
      this.productUsecase,
      this.categoryUsecase,
      this.subcategoryUsecase,
      this.departmentUsecase,
      this.brandUsecase,
      this.cleaningPackingUsecase,
      this.designationUsecase,
      this.outletUsecase,
      this.employeeUsecase,
      this.productRepo,
      this.stockHoldingReportUsecase
    );
  }

  initRoutes() {
    if (this.apiSyncLogger) {
      app.use(this.apiSyncLogger.middleware());
    }

    const authMiddleWare = require("./middlewares/auth");
    app.use(authMiddleWare);

    const documentRouter = require("./routes/document")(this.documentUsecase);
    const whatsappRouter = require("./routes/whatsapp")(this.whatsappUsecase);
    const budgetRouter = require("./routes/budget")(this.budgetUsecase);
    const issueRouter = require("./routes/issue")(this.issueUsecase);
    const vehicleRouter = require("./routes/vehicle")(this.vehicleUsecase);
    const familyRouter = require("./routes/family")(this.familyUsecase);
    const assetRouter = require("./routes/asset")(this.assetUsecase);
    const exampleRouter = require("./routes/example")(this.exampleUsecase);
    const gstRouter = require("./routes/gst")(this.gstUsecase);
    const departmentRouter = require("./routes/department")(
      this.departmentUsecase
    );
    const designationRouter = require("./routes/designation")(
      this.designationUsecase
    );
    const employeeRouter = require("./routes/employee")(this.employeeUsecase);
    const shiftRouter = require("./routes/shift")(this.shiftUsecase);
    const storeRouter = require("./routes/store")(this.storeUsecase);
    const outletRouter = require("./routes/outlet")(this.outletUsecase);
    const companyRouter = require("./routes/company")(this.companyUsecase);
    const materialtypeRouter = require("./routes/materialtype")(
      this.materialtypeUsecase
    );
    const materialsizeRouter = require("./routes/materialsize")(
      this.materialsizeUsecase
    );
    const salaryRouter = require("./routes/salary")(this.salaryUsecase);
    const resignationRouter = require("./routes/resignation")(
      this.resignationUsecase
    );
    const imageRouter = require("./routes/image")(this.imageUsecase);
    const productRouter = require("./routes/product")(
      this.productUsecase,
      this.synker
    );
    const categoryRouter = require("./routes/category")(this.categoryUsecase);
    const subcategoryRouter = require("./routes/subcategory")(
      this.subcategoryUsecase
    );
    const brandRouter = require("./routes/brand")(this.brandUsecase);
    const indentRouter = require("./routes/indent")(this.indentUsecase);
    const despatchRouter = require("./routes/despatch")(this.despatchUsecase);
    const userRouter = require("./routes/user")(this.userUsecase);
    const peopleRouter = require("./routes/people")(this.peopleUsecase);
    const accountsRouter = require("./routes/accounts")(
      this.accountsUsecase,
      this.tallyUsecase
    );
    const accountsEbookRouter = require("./routes/accountsEbook")(
      this.accountsEbookUsecase
    );
    const reconciliationRouter = require("./routes/reconciliation")(
      this.reconciliationUsecase
    );
    const digitalPaymentsRouter = require("./routes/digital_payments")(
      this.digitalPaymentsUsecase
    );
    const purchaseRouter = require("./routes/purchase")(this.purchaseUsecase);
    const purchaseGstRouter = require("./routes/purchase_gst")(
      this.purchaseGstUsecase
    );
    const purchaseGstMatchRouter = require("./routes/purchase_gst_match")(
      this.gstPurchaseMatchUsecase
    );
    const purchaseTallyRouter = require("./routes/purchase_tally")(
      this.purchaseTallyUsecase
    );
    const debitNoteTallyRouter = require("./routes/debit_note_tally")(
      this.debitNoteTallyUsecase
    );
    const tallyRouter = require("./routes/tally")(
      this.tallyUsecase,
      this.gstTallyPurchaseUsecase
    );
    const debitNoteRouter = require("./routes/debit_note")(
      this.debitNoteUsecase
    );
    // Add materials router
    const materialsRouter = require("./routes/materials")(
      this.materialsUsecase
    );
    const materialRequestRoutes = require("./routes/material_request")(
      this.materialRequestUsecase
    );
    const purchaseOrderRouter = require("./routes/purchase_order")(
      this.purchaseOrderUsecase
    );
    const invoiceRouter = require("./routes/invoice")(this.invoiceUsecase);
    const repackItemRouter = require("./routes/repack_item")(
      this.repackItemUsecase
    );
    const cleaningPackingRouter = require("./routes/cleaning_packing")(
      this.cleaningPackingUsecase
    );
    const ebConsumptionRouter = require("./routes/eb_consumption")(
      this.ebConsumptionUsecase
    );
    const ebMasterListRouter = require("./routes/eb_master_list")(
      this.ebMasterListUsecase
    );
    const ticketRouter = require("./routes/ticket")(this.ticketUsecase);
    const telegramDepartmentsRouter = require("./routes/telegram_departments")(
      this.telegramDepartmentsUsecase
    );
    const jobWorksheetRouter = require("./routes/job_worksheet")(
      this.jobWorksheetUsecase
    );
    const stickerTypesRouter = require("./routes/sticker_types")(
      this.stickerTypesUsecase
    );
    const productImageLogRouter = require("./routes/product_image_log")(
      this.productImageLogUsecase
    );
    const gofrugalSynkerRouter = require("./routes/gofrugal_synker")(
      this.gofrugalSynkerUsecase
    );
    const purchaseReturnRouter = require("./routes/purchase_return")(
      this.purchaseReturnUsecase
    );
    const productDistributorsRouter = require("./routes/product_distributors")(
      this.productDistributorsUsecase
    );
    const purchaseAcknowledgementRouter =
      require("./routes/purchase_acknowledgement")(
        this.purchaseAcknowledgementUsecase
      );
    const remarksMasterRouter = require("./routes/remarks_master")(
      this.remarksMasterUsecase
    );
    const pickPackRemarksRouter = require("./routes/pick_pack_remarks")(
      this.pickPackRemarksUsecase
    );
    const pickPackWriteOffRouter = require("./routes/pick_pack_write_off")(
      this.pickPackWriteOffUsecase
    );
    const pickPackVerificationRemarksRouter = require("./routes/pick_pack_verification_remarks")(
      this.pickPackVerificationRemarksUsecase
    );
    const pickPackVerificationsRouter = require("./routes/pick_pack_verifications")(
      this.pickPackVerificationsUsecase
    );
    const stockCheckerRouter = require("./routes/stock_checker")(
      this.stockCheckerUsecase
    );
    const productsExpiryCheckerRouter =
      require("./routes/products_expiry_checker")(
        this.productsExpiryCheckerUsecase
      );
    const stockTransferOutRouter = require("./routes/stock_transfer_out")(
      this.stockTransferOutUsecase
    );
    const stoCheckRouter = require("./routes/sto_check")(this.stoCheckUsecase);
    const offersV3Router = require("./routes/offers_v3")(
      this.offersV3Usecase
    );
    const productSalesRouter = require("./routes/product_sales")(
      this.productSalesUsecase
    );
    const salesDashboardRouter = require("./routes/sales_dashboard")(
      this.salesDashboardUsecase
    );
    const deadStockItemsRouter = require("./routes/dead_stock_items")(
      this.deadStockItemsUsecase
    );
    const grnRouter = require("./routes/grn")(this.grnUsecase);
    const purchaseRefRouter = require("./routes/purchase_ref")(
      this.purchaseRefUsecase
    );
    const stockHoldingReportRouter = require("./routes/stock_holding_report")(
      this.stockHoldingReportUsecase
    );
    const priceCheckerRouter = require("./routes/price_checker")(
      this.priceCheckerUsecase
    );
    const itemMarkupdownRouter = require("./routes/item_markupdown")(
      this.itemMarkupdownUsecase
    );
    const apiSyncLogRouter = require("./routes/api_sync_log")(
      this.apiSyncLogUsecase
    );
    const hqOffersRouter = require("./routes/hq_offers")(
      this.hqOffersUsecase
    );

    app.use("/document", documentRouter.getRouter());
    app.use("/whatsapp", whatsappRouter.getRouter());
    app.use("/budget", budgetRouter.getRouter());
    app.use("/issue", issueRouter.getRouter());
    app.use("/vehicle", vehicleRouter.getRouter());
    app.use("/family", familyRouter.getRouter());
    app.use("/asset", assetRouter.getRouter());
    app.use("/example", exampleRouter.getRouter());
    app.use("/gst", gstRouter.getRouter());
    app.use("/department", departmentRouter.getRouter());
    app.use("/designation", designationRouter.getRouter());
    app.use("/employee", employeeRouter.getRouter());
    app.use("/shift", shiftRouter.getRouter());
    app.use("/store", storeRouter.getRouter());
    app.use("/outlet", outletRouter.getRouter());
    app.use("/company", companyRouter.getRouter());
    app.use("/materialtype", materialtypeRouter.getRouter());
    app.use("/materialsize", materialsizeRouter.getRouter());
    app.use("/salary", salaryRouter.getRouter());
    app.use("/resignation", resignationRouter.getRouter());
    app.use("/image", imageRouter.getRouter());
    app.use("/product", productRouter.getRouter());
    app.use("/category", categoryRouter.getRouter());
    app.use("/subcategory", subcategoryRouter.getRouter());
    app.use("/brand", brandRouter.getRouter());
    app.use("/indent", indentRouter.getRouter());
    app.use("/despatch", despatchRouter.getRouter());
    app.use("/user", userRouter.getRouter());
    app.use("/people", peopleRouter.getRouter());
    app.use("/accounts-ebook", accountsEbookRouter.getRouter());
    app.use("/accounts", accountsRouter.getRouter());
    app.use("/reconciliation", reconciliationRouter.getRouter());
    app.use("/digital-payments", digitalPaymentsRouter.getRouter());
    app.use("/purchase", purchaseRouter.getRouter());
    app.use("/purchase-gst", purchaseGstRouter.getRouter());
    app.use("/purchase-gst-match", purchaseGstMatchRouter.getRouter());
    app.use("/purchase-tally", purchaseTallyRouter.getRouter());
    app.use("/debit-note-tally", debitNoteTallyRouter.getRouter());
    app.use("/tally", tallyRouter.getRouter());
    app.use("/debit-note", debitNoteRouter.getRouter());
    // Register materials route at /materials
    app.use("/materials", materialsRouter.getRouter());
    app.use("/material_request", materialRequestRoutes.getRouter());
    app.use("/purchase-order", purchaseOrderRouter.getRouter());
    app.use("/invoice", invoiceRouter.getRouter());
    app.use("/repack-item", repackItemRouter.getRouter());
    app.use("/cleaning-packing", cleaningPackingRouter.getRouter());
    app.use("/eb-consumption", ebConsumptionRouter.getRouter());
    app.use("/eb-master-list", ebMasterListRouter.getRouter());
    app.use("/ticket", ticketRouter.getRouter());
    app.use("/telegram-departments", telegramDepartmentsRouter.getRouter());
    app.use("/job-worksheet", jobWorksheetRouter.getRouter());
    app.use("/sticker-types", stickerTypesRouter.getRouter());
    app.use("/product-image-log", productImageLogRouter.getRouter());
    app.use("/gofrugal-synker", gofrugalSynkerRouter.getRouter());
    app.use("/purchase-return", purchaseReturnRouter.getRouter());
    app.use("/product-distributors", productDistributorsRouter.getRouter());
    app.use(
      "/purchase-acknowledgement",
      purchaseAcknowledgementRouter.getRouter()
    );
    app.use("/remarks-master", remarksMasterRouter.getRouter());
    app.use("/pick-pack-remarks", pickPackRemarksRouter.getRouter());
    app.use("/pick-pack-write-off", pickPackWriteOffRouter.getRouter());
    app.use("/pick-pack-verification-remarks", pickPackVerificationRemarksRouter.getRouter());
    app.use("/pick-pack-verifications", pickPackVerificationsRouter.getRouter());
    app.use("/stock-checker", stockCheckerRouter.getRouter());
    app.use(
      "/products-expiry-checker",
      productsExpiryCheckerRouter.getRouter()
    );
    app.use("/stock-transfer-out", stockTransferOutRouter.getRouter());
    app.use("/sto-check", stoCheckRouter.getRouter());
    app.use("/offers-v3", offersV3Router.getRouter());
    app.use("/product-sales", productSalesRouter.getRouter());
    app.use("/sales-report", salesDashboardRouter.getRouter());
    app.use("/dead-stock-items", deadStockItemsRouter.getRouter());
    app.use("/item-markupdown", itemMarkupdownRouter.getRouter());
    app.use("/grn", grnRouter.getRouter());
    app.use("/purchase-ref", purchaseRefRouter.getRouter());
    app.use("/stock-holding-report", stockHoldingReportRouter.getRouter());
    app.use("/price-checker", priceCheckerRouter.getRouter());
    app.use("/api-sync-log", apiSyncLogRouter.getRouter());
    app.use("/hq-offers", hqOffersRouter.getRouter());

    app.use(require("./middlewares/errorHandler"));
  }

  initServices() {
    const CronService = require("./services/cron_service");
    this.cronService = new CronService();
    if (
      this.productUsecase &&
      typeof this.productUsecase.bootstrapDownloadJobsFromStore === "function"
    ) {
      this.productUsecase.bootstrapDownloadJobsFromStore().catch((err) => {
        logger.Log({
          level: logger.LEVEL.ERROR,
          component: "SERVER",
          code: "SERVER.PRODUCT_DOWNLOAD_BOOTSTRAP",
          description: err.toString(),
          category: "",
          ref: {},
        });
      });
    }
    // Edit schedule here if needed (node-cron: minute hour day month weekday)
    const PURCHASE_ACK_GOFRUGAL_CRON = "*/5 * * * *";
    this.cronService.register(
      "purchase_acknowledgement_gofrugal_sync",
      PURCHASE_ACK_GOFRUGAL_CRON,
      async () => {
        await this.purchaseAcknowledgementUsecase.syncFromGofrugal(null);
      }
    );

    // 11PM everyday
    const STOCK_CHECKER_PENDING_CRON = "0 23 * * *";
    this.cronService.register(
      "stock_checker_pending_daily_report",
      STOCK_CHECKER_PENDING_CRON,
      async () => {
        await this.stockCheckerUsecase.runDailyPendingStockCheckReport();
      }
    );

    // 12AM everyday - cleanup stale download tmp folders/files.
    const PRODUCT_IMAGE_TMP_CLEANUP_CRON = "0 0 * * *";
    this.cronService.register(
      "product_image_download_tmp_cleanup",
      PRODUCT_IMAGE_TMP_CLEANUP_CRON,
      async () => {
        await this.productUsecase.cleanupDownloadTmpDirectoryKeepingActiveJobs();
      }
    );

    // 8:15AM everyday - just after the stock holding sync (7:30AM), so the
    // first person to open Purchase Ref gets a warm cache instead of paying
    // for the full rebuild.
    const PURCHASE_REF_WARM_CRON = "15 8 * * *";
    this.cronService.register(
      "purchase_ref_cache_warm",
      PURCHASE_REF_WARM_CRON,
      async () => {
        await this.purchaseRefUsecase.refresh();
      }
    );

    const SANDBOX_GST_TAXPAYER_REFRESH_CRON = "*/2 * * * *";
    this.cronService.register(
      "sandbox_gst_taxpayer_session_refresh",
      SANDBOX_GST_TAXPAYER_REFRESH_CRON,
      async () => {
        if (
          !this.sandboxService ||
          !this.sandboxService.isEnabled() ||
          !this.sandboxService.gstAuthentication
        ) {
          return;
        }
        try {
          await this.sandboxService.gstAuthentication.refreshIfWithinRenewalWindow();
        } catch (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "SERVER",
            code: "SERVER.SANDBOX_GST_TAXPAYER_REFRESH_CRON",
            description: err.toString(),
            category: "",
            ref: {},
          });
        }
      }
    );

    const SANDBOX_GST_TAXPAYER_DAILY_CRON = "30 3 * * *";
    this.cronService.register(
      "sandbox_gst_taxpayer_daily_maintenance",
      SANDBOX_GST_TAXPAYER_DAILY_CRON,
      async () => {
        if (!this.sandboxService || !this.sandboxService.gstAuthentication) {
          return;
        }
        try {
          await this.sandboxService.gstAuthentication.applySessionWallExpiryCleanup();
          await this.sandboxService.gstAuthentication.applyDay29RevalidationJwtClear();
        } catch (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "SERVER",
            code: "SERVER.SANDBOX_GST_TAXPAYER_DAILY_CRON",
            description: err.toString(),
            category: "",
            ref: {},
          });
        }
      }
    );

    this.synker.initCronJobs(this.cronService, this.apiSyncLogger);
    this.cronService.start();

    // Wire synker back into cleaningPackingUsecase after service creation
    if (this.cleaningPackingUsecase && this.cleaningPackingUsecase.setSynker) {
      this.cleaningPackingUsecase.setSynker(this.synker);
    }

    // Wire synker back into employeesUsecase after service creation
    if (this.employeeUsecase && this.employeeUsecase.setSynker) {
      this.employeeUsecase.setSynker(this.synker);
    }
  }

  onClose() {
    if (this.cronService) {
      this.cronService.stopAll();
    }
    //Close all DB Connections
    this.drivers.map((m) => {
      m.close();
    });

    HttpServer.close();
  }
}

const server = new Server();

[
  "SIGINT",
  "SIGTERM",
  "SIGQUIT",
  "exit",
  "uncaughtException",
  "SIGUSR1",
  "SIGUSR2",
].forEach((eventType) => {
  process.on(eventType, (err = "") => {
    process.removeAllListeners();

    let error = err.toString();

    if (err.stack) {
      error = err.stack;
    }

    logger.Log({
      level: logger.LEVEL.ERROR,
      component: "SERVER",
      code: "SERVER.EXIT",
      description: error,
      category: "",
      ref: {},
    });
    server.onClose();
  });
});
