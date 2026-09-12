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

/**
 * Express `trust proxy` from TRUST_PROXY. Default: loopback (nginx on the
 * same host). Never `true`.
 */
function resolveTrustProxy(raw) {
  if (raw === undefined || raw === "") return "loopback";
  const v = String(raw).trim();
  if (v === "false" || v === "0") return false;
  if (v === "true") {
    console.warn("TRUST_PROXY=true is not accepted (it lets clients forge X-Forwarded-*); using loopback");
    return "loopback";
  }
  if (/^\d+$/.test(v)) return Number(v);
  return v; // "loopback", "linklocal", "uniquelocal", or an address/CIDR list
}

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
    // In production the app sits behind a reverse proxy, so the socket
    // address is the proxy's. `trust proxy` makes Express read the real
    // client from X-Forwarded-For, which is what the IP restriction checks.
    // Set TRUST_PROXY=false if the app is ever exposed directly, otherwise
    // a client could spoof the header.
    // Stage 0A correction: blanket `true` let a client's own X-Forwarded-For
    // win whenever the proxy appended rather than overwrote the header. The
    // real topology is nginx on this same host, so only loopback is trusted
    // by default. TRUST_PROXY accepts Express's forms - "loopback", an
    // address or CIDR list, a hop count, or "false" - and is read once here.
    app.set("trust proxy", resolveTrustProxy(process.env.TRUST_PROXY));

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

        const { ensureGofrugalIndexes } = require("./utils/ensureGofrugalIndexes");
        await ensureGofrugalIndexes(this.mysqlGofrugal.connection);

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
    // Stage 0C / C1c: employment periods and lifecycle events.
    this.employeeLifecycleRepo = require("./repository/employee_lifecycle")(
      this.mysql.connection
    );
    // Stage 0C / C2: the local employee master.
    this.employeeMasterRepo = require("./repository/employee_master")(
      this.mysql.connection
    );
    this.employeeAadhaarRepo = require("./repository/employee_aadhaar")(
      this.mysql.connection
    );
    this.employeeBankRepo = require("./repository/employee_bank")(
      this.mysql.connection
    );
    // A cache of public reference data - which bank and branch an IFSC
    // belongs to - so the same branch code is bought from the provider once
    // rather than once per employee. It holds no employee data.
    this.ifscMasterRepo = require("./repository/ifsc_master")(
      this.mysql.connection
    );
    // Reports: saved templates, the export audit trail, and the lookups
    // reconciliation needs. It builds no report SQL - that is the resolver's.
    this.reportTemplateRepo = require("./repository/report_template")(
      this.mysql.connection
    );
    this.shiftRepo = require("./repository/shift")(this.mysql.connection);
    // The new payroll/attendance shift master. Separate from shiftRepo above,
    // which still owns the legacy `shift_master` table.
    this.workShiftRepo = require("./repository/work_shift")(this.mysql.connection);
    // The manual employee -> work shift mapping. It owns exactly one column,
    // `new_employee.default_work_shift_id`, and never touches the legacy
    // `shift_id` / `shift_code` pair that employeeRepo still reads.
    this.employeeWorkShiftRepo = require("./repository/employee_work_shift")(
      this.mysql.connection
    );
    // M2: the salary history. It owns `employee_salary` and reads exactly five
    // statutory columns off `new_employee`; it never reads or writes the
    // legacy `new_employee.salary`, which stays where it is for reference.
    this.employeeSalaryRepo = require("./repository/employee_salary")(
      this.mysql.connection
    );
    // Attendance v2. The reads the calculation engine needs and the writes of
    // what it produced. It SELECTs the Biomax punch tables and never writes
    // them - the receiver process remains their only writer - and the two
    // tables it does write hold derived numbers that can be recomputed.
    this.attendanceCalculationRepo = require("./repository/attendance_calculation")(
      this.mysql.connection
    );
    // Attendance v2 / A3. The regularization and OT approval store. It cannot
    // reach `biomax_punch` at all: an approved manual punch is a row in its
    // own table, and the raw punch stays exactly as the device sent it.
    this.attendanceRegularizationRepo = require("./repository/attendance_regularization")(
      this.mysql.connection
    );
    // Attendance Approver Setup: the EMPLOYEE-LEVEL approver master and its
    // append-only audit. Read by the regularization usecase to resolve a new
    // request's chain; an unmapped employee falls back to the role chain.
    this.attendanceApproverSetupRepo = require("./repository/attendance_approver_setup")(
      this.mysql.connection
    );
    // Attendance - Part 1. Read-only over the Biomax punch tables (the
    // receiver process is their only writer) plus the device registry. On
    // the PRIMARY application pool, never the GoFrugal one.
    this.biomaxPunchRepo = require("./repository/biomax_punch")(this.mysql.connection);
    this.biomaxDeviceRepo = require("./repository/biomax_device")(this.mysql.connection);
    // Historical pull scaffolding: the API queues GET_LOG_DATA requests and
    // reads their state; only the receiver process ever hands one to a device.
    this.biomaxHistoricalPullRepo = require("./repository/biomax_historical_pull")(this.mysql.connection);
    // DigiSME Excel attendance import: staging tables here; the punches
    // themselves are written through biomax/store.js on the API pool - the
    // same insert path and tables as a live punch.
    this.attendanceImportRepo = require("./repository/attendance_import")(this.mysql.connection);
    this.biomaxImportStore = require("./biomax/store").createStore(this.mysql.connection);
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
    this.authLogRepo = require("./repository/auth_log")(this.mysql.connection);
    this.passwordResetRepo = require("./repository/passwordReset")(
      this.mysql.connection
    );
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
    this.gstPurchaseNo2aRepo = require("./repository/gst_purchase_no_2a")(
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
    this.advanceRequestRepo = require("./repository/advance_request")(
      this.mysql.connection
    );
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
    this.offersV3TalkerRepo = require("./repository/offers_v3_talker")(
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
    // Stage 0C / C1c. userRepo is here only so a rejoin can revoke old
    // sessions through the existing Stage 0A token_valid_from mechanism.
    this.employeeLifecycleUsecase = require("./usecase/employee_lifecycle")(
      this.employeeLifecycleRepo,
      this.userRepo
    );
    // Stage 0C / C2. The lifecycle usecase and its repository are both here
    // so the four HR actions can run C1c on their OWN transaction - the
    // master change and the period it implies commit or roll back together.
    // Stage 0C / C2. Aadhaar and Bank share the GST integration's Sandbox
    // authentication - one token cache, one set of credentials - while their
    // business logic stays in separate modules. GST is untouched.
    this.sandboxClient = require("./services/sandbox_client")(this.sandboxService);
    this.sandboxAadhaarService = require("./services/sandbox_aadhaar")(this.sandboxClient);
    this.sandboxBankService = require("./services/sandbox_bank")(this.sandboxClient);

    this.employeeAadhaarUsecase = require("./usecase/employee_aadhaar")(
      this.employeeAadhaarRepo,
      this.sandboxAadhaarService
    );
    this.employeeBankUsecase = require("./usecase/employee_bank")(
      this.employeeBankRepo,
      this.sandboxBankService,
      this.employeeAadhaarRepo
    );
    // Resolving an IFSC while bank details are being entered. It shares the
    // Sandbox bank service, and therefore the one token cache, but spends no
    // Penny-Less verification and never touches the employee master.
    this.ifscLookupUsecase = require("./usecase/ifsc_lookup")(
      this.ifscMasterRepo,
      this.sandboxBankService
    );
    this.employeeMasterUsecase = require("./usecase/employee_master")(
      this.employeeMasterRepo,
      this.employeeLifecycleUsecase,
      this.employeeLifecycleRepo,
      this.employeeAadhaarUsecase,
      // M1: the initial work shift on a create is checked against the NEW
      // work shift master through the same lookup the assignment uses.
      this.employeeWorkShiftRepo
    );
    // Stage 0C / C3: Aadhaar and bank status for a whole employee list at
    // once. It takes the employee usecase itself rather than a repository, so
    // the population it summarises is literally the one `GET
    // /employee/employees` returns and cannot drift from it.
    // Reports: the Employee Master service. It takes the shared connection
    // for the one report query and the template repository for everything
    // saved, so preview and export resolve a request the same way.
    this.employeeReportService = require("./usecase/employee_report_service")(
      this.mysql.connection,
      this.reportTemplateRepo
    );
    // The employee-master repository is passed for one read - whether the PF
    // and ESI decision has been recorded - which is what lets the list say an
    // employee is still waiting on HR onboarding. No column value leaves it.
    this.employeeStatusSummaryUsecase = require("./usecase/employee_status_summary")(
      this.employeeUsecase,
      this.employeeAadhaarRepo,
      this.employeeBankRepo,
      this.employeeMasterRepo
    );
    this.shiftUsecase = require("./usecase/shift")(this.shiftRepo);
    this.workShiftUsecase = require("./usecase/work_shift")(this.workShiftRepo);
    // Attendance - Part 1. Exports are audited through the same
    // report_export_log the Reports module writes.
    this.attendanceRawUsecase = require("./usecase/attendance_raw")(
      this.biomaxPunchRepo,
      this.reportTemplateRepo
    );
    this.biomaxDeviceUsecase = require("./usecase/biomax_device")(this.biomaxDeviceRepo);
    this.biomaxHistoricalPullUsecase = require("./usecase/biomax_historical_pull")(this.biomaxHistoricalPullRepo);
    this.attendanceImportUsecase = require("./usecase/attendance_import")(this.attendanceImportRepo, this.biomaxImportStore);
    this.employeeWorkShiftUsecase = require("./usecase/employee_work_shift")(
      this.employeeWorkShiftRepo
    );
    // M2: the salary engine's lifecycle. The arithmetic itself is in
    // `utils/salary_engine.js` and is pure, so this holds only the rules about
    // when a salary may be created, amended, approved or rejected.
    this.employeeSalaryUsecase = require("./usecase/employee_salary")(
      this.employeeSalaryRepo
    );
    // Attendance v2. Orchestration only: the arithmetic is in the pure
    // `utils/attendance_engine.js`, `utils/shiftResolution.js` and
    // `utils/attendance_payroll.js`, and this fetches what they need and
    // shapes what they returned.
    this.attendanceCalculationUsecase = require("./usecase/attendance_calculation")(
      this.attendanceCalculationRepo
    );
    // Attendance v2 / A3. Handed the calculation usecase as well, because a
    // request is validated against what the engine actually says is wrong with
    // the date, and a final approval recalculates that date immediately.
    this.attendanceRegularizationUsecase = require("./usecase/attendance_regularization")(
      this.attendanceRegularizationRepo,
      this.attendanceCalculationUsecase,
      this.attendanceApproverSetupRepo
    );
    this.attendanceApproverSetupUsecase = require("./usecase/attendance_approver_setup")(
      this.attendanceApproverSetupRepo
    );
    // Finalized OT flow. The calculation usecase raises NO OT request of its
    // own; it needs the regularization usecase for one thing - closing
    // unresolved OT when a payroll month is locked - and the hook is handed
    // back the other way once both exist, because wiring it as a constructor
    // argument would be a cycle.
    this.attendanceCalculationUsecase.setOtRequestService(
      this.attendanceRegularizationUsecase
    );
    // M5: Bulk Salary Upload. A BATCH over the lifecycle above rather than a
    // second one - it is handed the same repository and the same usecase, and
    // every amount it stores is calculated by the engine through them.
    this.salaryBulkUploadUsecase = require("./usecase/salary_bulk_upload")(
      this.employeeSalaryRepo,
      this.employeeSalaryUsecase
    );
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
      this.employeeRepo,
      {
        authLogRepo: this.authLogRepo,
        telegram: require("./services/telegram")(),
      }
    );
    // Stage 0A integration: the Telegram reset writes through the modern
    // password service and audits to user_auth_log; it never touches SHA-1.
    this.passwordResetUsecase = require("./usecase/passwordReset")(
      this.userRepo,
      this.passwordResetRepo,
      require("./services/telegram")(),
      { authLogRepo: this.authLogRepo }
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
    this.gstPurchaseNo2aUsecase = require("./usecase/gst_purchase_no_2a")(
      this.gstPurchaseNo2aRepo
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
    this.advanceRequestUsecase = require("./usecase/advance_request")(
      this.advanceRequestRepo
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
    this.offersV3TalkerUsecase = require("./usecase/offers_v3_talker")(
      this.offersV3TalkerRepo,
      this.outletRepo
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

    // Stage 0A: built with the user usecase so a revoked or disabled
    // session stops within the cache window rather than at token expiry.
    const authMiddleWare = require("./middlewares/auth").create({
      userUsecase: this.userUsecase,
    });
    this.authMiddleware = authMiddleWare;
    app.use(authMiddleWare);

    this.permissions = require("./middlewares/permissions")(
      this.designationUsecase
    );

    // Stage 0B / B3: field-level protection for sensitive employee data,
    // built on the same permission lookup so the admin bypass is shared.
    this.sensitive = require("./middlewares/sensitive")(this.permissions);

    // Runs after auth so it can see the decoded user: an account with an IP
    // allow-list is cut off the moment it is used outside that network, not
    // just at login.
    this.ipRestriction = require("./middlewares/ip_restriction")(
      this.userUsecase
    );
    app.use(this.ipRestriction);

    const documentRouter = require("./routes/document")(
      this.documentUsecase,
      this.permissions,
      this.sensitive
    );
    const whatsappRouter = require("./routes/whatsapp")(this.whatsappUsecase);
    const budgetRouter = require("./routes/budget")(this.budgetUsecase);
    const issueRouter = require("./routes/issue")(this.issueUsecase);
    const vehicleRouter = require("./routes/vehicle")(this.vehicleUsecase);
    const familyRouter = require("./routes/family")(
      this.familyUsecase,
      this.permissions
    );
    const assetRouter = require("./routes/asset")(this.assetUsecase);
    const exampleRouter = require("./routes/example")(this.exampleUsecase);
    const gstRouter = require("./routes/gst")(this.gstUsecase);
    const departmentRouter = require("./routes/department")(
      this.departmentUsecase,
      this.permissions
    );
    const designationRouter = require("./routes/designation")(
      this.designationUsecase,
      this.permissions
    );
    const employeeRouter = require("./routes/employee")(
      this.employeeUsecase,
      this.permissions,
      this.sensitive
    );
    // Stage 0C / C2: the local employee-master lifecycle actions.
    const employeeMasterRouter = require("./routes/employee_master")(
      this.employeeMasterUsecase,
      this.permissions,
      this.sensitive,
      this.employeeAadhaarUsecase,
      this.employeeBankUsecase,
      this.employeeStatusSummaryUsecase,
      this.ifscLookupUsecase
    );
    // Reports: discovery, saved templates, preview and the two exports.
    const employeeReportRouter = require("./routes/employee_report")(
      this.employeeReportService,
      this.permissions
    );
    const shiftRouter = require("./routes/shift")(this.shiftUsecase, this.permissions);
    const workShiftRouter = require("./routes/work_shift")(
      this.workShiftUsecase,
      this.permissions
    );
    // Attendance - Part 1: the Attendance List, the Punch Audit and the
    // Biomax device registry.
    const attendanceRawRouter = require("./routes/attendance_raw")(
      this.attendanceRawUsecase,
      this.permissions
    );
    const biomaxDeviceRouter = require("./routes/biomax_device")(
      this.biomaxDeviceUsecase,
      this.permissions
    );
    const biomaxHistoricalPullRouter = require("./routes/biomax_historical_pull")(
      this.biomaxHistoricalPullUsecase,
      this.permissions
    );
    const attendanceImportRouter = require("./routes/attendance_import")(
      this.attendanceImportUsecase,
      this.permissions
    );
    // Employee Shift Assignment. Mounted at /hr with the other employee
    // writes, because what it changes is an employee record.
    const employeeWorkShiftRouter = require("./routes/employee_work_shift")(
      this.employeeWorkShiftUsecase,
      this.permissions,
      this.sensitive
    );
    // M2: the salary API. Mounted at /hr with the other employee routes,
    // because a salary is a fact about an employee record.
    const employeeSalaryRouter = require("./routes/employee_salary")(
      this.employeeSalaryUsecase,
      this.permissions,
      this.sensitive,
      // M5: the two /hr/salary/bulk endpoints mount on this same router, so
      // they inherit the B3 response filter and write guard mounted on /salary.
      this.salaryBulkUploadUsecase
    );
    // Attendance v2: calculated attendance, the monthly payroll roll-up, and
    // the regularization / OT approval API. Read and recalculate only; no
    // punch is created, edited or deleted from either router.
    const attendanceCalculationRouter = require("./routes/attendance_calculation")(
      this.attendanceCalculationUsecase,
      this.permissions,
      this.sensitive
    );
    const attendanceRegularizationRouter = require("./routes/attendance_regularization")(
      this.attendanceRegularizationUsecase,
      this.permissions,
      this.sensitive
    );
    const attendanceApproverSetupRouter = require("./routes/attendance_approver_setup")(
      this.attendanceApproverSetupUsecase,
      this.permissions
    );
    const storeRouter = require("./routes/store")(this.storeUsecase);
    const outletRouter = require("./routes/outlet")(
      this.outletUsecase,
      this.permissions,
      this.ipRestriction
    );
    const companyRouter = require("./routes/company")(this.companyUsecase);
    const materialtypeRouter = require("./routes/materialtype")(
      this.materialtypeUsecase
    );
    const materialsizeRouter = require("./routes/materialsize")(
      this.materialsizeUsecase
    );
    const salaryRouter = require("./routes/salary")(
      this.salaryUsecase,
      this.permissions
    );
    const resignationRouter = require("./routes/resignation")(
      this.resignationUsecase,
      this.permissions
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
    const userRouter = require("./routes/user")(
      this.userUsecase,
      this.permissions,
      this.ipRestriction,
      {
        authLogRepo: this.authLogRepo,
        authMiddleware: this.authMiddleware,
        passwordResetUsecase: this.passwordResetUsecase,
      }
    );
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
    const purchaseGstNo2aRouter = require("./routes/purchase_gst_no_2a")(
      this.gstPurchaseNo2aUsecase
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
    const advanceRequestRouter = require("./routes/advance_request")(
      this.advanceRequestUsecase,
      this.permissions
    );
    const ticketRouter = require("./routes/ticket")(
      this.ticketUsecase,
      this.permissions
    );
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
    const offersV3TalkerRouter = require("./routes/offers_v3_talker")(
      this.offersV3TalkerUsecase
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
    // Stage 0C / C2. Mounted at /hr so the lifecycle actions do not collide
    // with the existing employee routes and C3 can find them in one place.
    app.use("/hr", employeeMasterRouter.getRouter());
    // Also /hr: Express tries the routers in order and this one only claims
    // /hr/work-shift-assignments, which the master router does not define.
    app.use("/hr", employeeWorkShiftRouter.getRouter());
    // Also /hr: this one only claims /hr/salary, which neither router above
    // defines, so the ordering is unambiguous.
    app.use("/hr", employeeSalaryRouter.getRouter());
    // Mounted under /reports rather than /hr: the machinery is per-dataset
    // and Attendance and Payroll will mount beside this one, not inside HR.
    app.use("/reports/employee-master", employeeReportRouter.getRouter());
    app.use("/shift", shiftRouter.getRouter());
    // The new payroll/attendance shift master. /shift above is unchanged and
    // still serves the legacy `shift_master` system.
    app.use("/work-shift", workShiftRouter.getRouter());
    // Attendance is its own top-level module beside HR, as the frontend's
    // navigation already anticipates. Devices first: Express tries routers
    // in order and /attendance/devices must not be swallowed by /attendance.
    app.use("/attendance/devices", biomaxDeviceRouter.getRouter());
    app.use("/attendance/historical-pulls", biomaxHistoricalPullRouter.getRouter());
    app.use("/attendance/imports", attendanceImportRouter.getRouter());
    // Attendance v2. Both declare their full `/attendance/...` paths, so they
    // mount at the root and are tried BEFORE the Part 1 router, which claims
    // the bare `/attendance` prefix.
    app.use("/", attendanceCalculationRouter.getRouter());
    app.use("/", attendanceRegularizationRouter.getRouter());
    app.use("/", attendanceApproverSetupRouter.getRouter());
    app.use("/attendance", attendanceRawRouter.getRouter());
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
    app.use("/purchase-gst-no-2a", purchaseGstNo2aRouter.getRouter());
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
    app.use("/advance-request", advanceRequestRouter.getRouter());
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
    app.use("/offers-v3-talker", offersV3TalkerRouter.getRouter());
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

    // 6AM everyday - materialise recurring tasks that fall due today.
    const RECURRING_TASKS_CRON = "0 6 * * *";
    this.cronService.register(
      "recurring_task_generation",
      RECURRING_TASKS_CRON,
      async () => {
        await this.ticketUsecase.runRecurringTaskGeneration();
      }
    );

    // 9AM everyday - nudge each chat about work that is past its due date.
    const OVERDUE_REMINDER_CRON = "0 9 * * *";
    this.cronService.register(
      "ticket_overdue_reminders",
      OVERDUE_REMINDER_CRON,
      async () => {
        await this.ticketUsecase.runOverdueReminders();
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

    // Every minute - pick up `/start <token>` messages sent to the Telegram
    // bot and finish linking. Polling rather than a webhook, so the API does
    // not have to be reachable from the internet over HTTPS.
    const TELEGRAM_LINK_POLL_CRON = "* * * * *";
    this.cronService.register(
      "telegram_link_poll",
      TELEGRAM_LINK_POLL_CRON,
      async () => {
        await this.passwordResetUsecase.pollTelegramUpdates();
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

    // Stage 0A / A5: a break-glass credential is due rotation after any use
    // and on a fixed interval even if unused. Nothing is rotated here — the
    // job only raises the alert; rotation is the documented manual procedure.
    this.cronService.register("break_glass_rotation_check", "0 8 * * *", async () => {
      const authConfig = require("./config/auth");
      const due = await this.authLogRepo.findSystemAccountsDueRotation(
        authConfig.breakGlass.rotationDays
      );
      if (!due || due.length === 0) return;
      const telegram = require("./services/telegram")();
      for (const row of due) {
        await this.authLogRepo.record({
          event: "break_glass_rotation_due",
          userId: row.user_id,
          username: row.username,
          detail: row.last_login_at && row.credential_rotated_at && row.last_login_at > row.credential_rotated_at
            ? "used_since_last_rotation"
            : "interval_elapsed",
        });
        // Plain text, no parse mode: the username is database text and must
        // never be able to break the message (gate 19A).
        const field = (v) => String(v ?? "unknown").replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 120);
        await telegram.sendMessage(
          authConfig.breakGlass.alertChatId || ALERTS_TELEGRAM_CHAT_ID,
          `🔐 BREAK-GLASS CREDENTIAL ROTATION DUE\nAccount: ${field(row.username)}\nLast rotated: ${field(row.credential_rotated_at || "never")}\nLast used: ${field(row.last_login_at || "never")}\n\nRotate with scripts/auth/break-glass.js rotate.`,
          { disableNotification: false, parseMode: null }
        );
      }
    });

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

    // Stage 0C / C1c: the lifecycle reconciler runs after every Digisme
    // employee sync - the 07:00 cron and POST /employee/sync alike, since
    // both reach syncDigismeEmployees.
    if (this.synker && this.synker.setEmployeeLifecycleUsecase) {
      this.synker.setEmployeeLifecycleUsecase(this.employeeLifecycleUsecase);
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
