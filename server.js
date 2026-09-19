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
const { ALERTS_TELEGRAM_CHAT_ID, DIGISME_ATTENDANCE_ALERT_CHAT_ID } = require("./constants/telegram");

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
    // Employee Master Bulk Export / Import. Reads only: the export
    // population, the three masters a human-readable cell resolves against,
    // and the bulk-operation audit row. It contains no employee UPDATE at
    // all - every change goes through the C2 employee-master usecase.
    this.employeeBulkUpdateRepo = require("./repository/employee_bulk_update")(
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
    // Payrun Initialization. It owns THREE tables - `payrun_period`,
    // `payrun_employee` and the pay type audit - and reads four it does not
    // own: the employee master, `employee_salary`, `attendance_monthly_payroll`
    // and `attendance_approval_request`. It writes none of those four, and in
    // particular never `new_employee.payment_type`: a payrun pay type is a
    // fact about one month.
    this.payrunRepo = require("./repository/payrun")(this.mysql.connection);
    // Payrun Adjustments V1. It owns THREE tables of its own - the component
    // amounts, the per-employee state (remarks and the EXPLICIT no-adjustment
    // confirmation) and an append-only change log - and READS `payrun_employee`
    // to learn who is in the month. It has no statement that writes
    // `payrun_employee`, `new_employee`, `employee_salary` or any attendance
    // table: an adjustment hangs off an initialized month and cannot create one.
    this.payrunAdjustmentRepo = require("./repository/payrun_adjustment")(
      this.mysql.connection
    );
    // Payrun Calculation & Review. It owns TWO tables - the per-employee
    // calculated month and an append-only calculation/approval log - and READS
    // five it does not own: `payrun_employee`, `attendance_monthly_payroll`,
    // `attendance_day_calculation` (for the effective NRM the engine already
    // resolved), the employee master's statutory context, and the adjustment
    // amounts. It writes none of those five, and it never writes
    // `payrun_period`: approval locks ONE EMPLOYEE'S month, never the month.
    this.payrunCalculationRepo = require("./repository/payrun_calculation")(
      this.mysql.connection
    );
    // Attendance v2. The reads the calculation engine needs and the writes of
    // what it produced. It SELECTs the Biomax punch tables and never writes
    // them - the receiver process remains their only writer - and the two
    // tables it does write hold derived numbers that can be recomputed.
    this.attendanceCalculationRepo = require("./repository/attendance_calculation")(
      this.mysql.connection
    );
    // The Attendance Dashboard's reads. A SEPARATE repository from the one
    // above because every statement in it is batched across a whole
    // population: the calculation repository is built for one employee over a
    // range and issues six queries per employee, which a company-wide
    // overview cannot afford. It contains no INSERT, UPDATE or DELETE at all.
    this.attendanceDashboardRepo = require("./repository/attendance_dashboard")(
      this.mysql.connection
    );
    // Missing Attendance: the report's OWN two reads - the candidate
    // population, and the notification ledger the 06:00 Telegram job claims
    // against. It reads NO attendance table: punches, dated shifts, stored
    // calculations and approvals all come from the dashboard repository
    // above, which is what keeps the report agreeing with the screens.
    this.attendanceMissingRepo = require("./repository/attendance_missing")(
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
    // Void Punch: the additive `attendance_punch_void` record beside a raw
    // punch. The only writer of that table; it never writes `biomax_punch`.
    this.attendancePunchVoidRepo = require("./repository/attendance_punch_void")(
      this.mysql.connection
    );
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
    // The Telegram Group Registry: a record of which Telegram groups the bot
    // posts to. Nothing reads it to choose a destination yet - the hardcoded
    // ids in constants/telegram.js are unchanged.
    this.telegramGroupRegistryRepo = require("./repository/telegram_group_registry")(
      this.mysql.connection
    );

    // Phase 3C: MANAGED MEMBERSHIP. Claims are what the company has said it
    // manages; the job table is how that work reaches Telegram afterwards,
    // never inside the transaction that caused it.
    this.telegramMembershipClaimRepo = require("./repository/telegram_membership_claim")(
      this.mysql.connection
    );
    this.telegramMembershipJobRepo = require("./repository/telegram_membership_job")(
      this.mysql.connection
    );

    // Phase 3A: WHICH EMPLOYEES SHOULD BELONG TO WHICH GROUP. Configuration
    // only - this repository writes mapping rows and reads the employee
    // master; it touches nothing on Telegram.
    this.telegramGroupMappingRepo = require("./repository/telegram_group_mapping")(
      this.mysql.connection
    );
    // Phase 3B: durable join attempts. A join is asynchronous and crosses a
    // process boundary - an in-memory attempt would die with the next pm2
    // reload and refuse an employee who did nothing wrong.
    this.employeeTelegramGroupJoinRepo = require("./repository/employee_telegram_group_join")(
      this.mysql.connection
    );
    // The dashboard's membership-verification cache. Written by the employee
    // DETAIL screen when Telegram gives a definitive answer, read only by the
    // bulk status summary - so the dashboard needs no Telegram call at all.
    this.employeeTelegramGroupVerificationRepo = require("./repository/employee_telegram_group_verification")(
      this.mysql.connection
    );    // EMPLOYEE Telegram identity. Keyed by employee_id, never by a login:
    // most employees have no dnds.co.in account, so `telegram_links` (which is
    // keyed by user_id, for password reset) could not serve them.
    this.employeeTelegramRepo = require("./repository/employee_telegram")(
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
    // Employee Master Bulk Export / Import. A BATCH over the C2 employee
    // master and nothing more: it is handed `employeeMasterUsecase` itself
    // rather than a repository, so every field it writes goes through the
    // same `editEmployee` / `correctJoiningDate` that a single-employee edit
    // does - with the same branch checks, the same session revocation on a
    // store or designation change, and the same lifecycle reconciliation on
    // a joining date.
    this.employeeBulkUpdateUsecase = require("./usecase/employee_bulk_update")(
      this.employeeBulkUpdateRepo,
      this.employeeMasterUsecase
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
    // The salary repository is passed for one read too - whether a live,
    // costed salary exists today - which is what lets the queue say an
    // employee is not yet on payroll. No amount leaves it.
    this.employeeStatusSummaryUsecase = require("./usecase/employee_status_summary")(
      this.employeeUsecase,
      this.employeeAadhaarRepo,
      this.employeeBankRepo,
      this.employeeMasterRepo,
      this.employeeSalaryRepo,
      // Telegram status for the onboarding dashboard's column, read in TWO
      // bulk queries for the whole list. The browser must never ask
      // /hr/employee/:id/telegram per row - that is the N+1 this endpoint
      // exists to prevent.
      this.employeeTelegramRepo,
      // PHASE 3B COMPLETION, from the same page's data and the cache - and
      // from NO Telegram call. Asking here would be two calls per required
      // group per employee, thousands per page load, on the token the
      // three-second poller shares.
      {
        mappingRepo: this.telegramGroupMappingRepo,
        verificationRepo: this.employeeTelegramGroupVerificationRepo,
      }
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
    // A punch stored under an Employee Code nobody knew yet (device or
    // DigiSME import) is UNMATCHED and counts for nobody. Once HR creates
    // that employee, re-derive their punches automatically.
    // A punch that could not be DATED - unknown code, no shift, no schedule
    // row, no cutoff - is revisited whenever the cause may have been fixed.
    this.employeeMasterUsecase.onEmployeeCreated = (employeeId) =>
      this.attendanceImportUsecase.redriveUndated({ employeeIds: [employeeId] });
    this.employeeWorkShiftUsecase = require("./usecase/employee_work_shift")(
      this.employeeWorkShiftRepo
    );
    // Assigning a shift is the moment a NO_SHIFT punch becomes datable, so
    // the assignment re-derives that employee's undatable punches.
    this.employeeWorkShiftUsecase.setPunchRedriveService(this.attendanceImportUsecase);
    // M2: the salary engine's lifecycle. The arithmetic itself is in
    // `utils/salary_engine.js` and is pure, so this holds only the rules about
    // when a salary may be created, amended, approved or rejected.
    this.employeeSalaryUsecase = require("./usecase/employee_salary")(
      this.employeeSalaryRepo
    );
    // Payrun Initialization. Orchestration only: the eligibility rules are in
    // the pure `utils/payrun_eligibility.js`, and this fetches what they need
    // and performs what they permit. It calculates NO attendance - the payrun
    // consumes the month the attendance engine already stored.
    //
    // IT TAKES THE CALCULATION REPOSITORY FOR ONE READ - which employees are
    // approved and locked - because a locked month's pay type is part of what
    // the approval committed to and may not be changed afterwards.
    this.payrunCalculationLocks = {
      listLockedEmployeeIds: (args) => this.payrunCalculationRepo.listLockedEmployeeIds(args),
    };
    this.payrunUsecase = require("./usecase/payrun")(
      this.payrunRepo,
      this.payrunCalculationLocks
    );
    // Payrun Adjustments V1: the stage after initialization. The rules are in
    // the pure `utils/payrun_adjustments.js` - including the CALCULATION
    // CONTRACT the later calculation stage will consume - and this fetches
    // what they need and performs what they permit. It takes the
    // initialization repository for exactly ONE read: whether the month is
    // locked.
    // It also takes the lock reader, for the same one question: an approved
    // employee's adjustments are frozen, per employee and never per month.
    this.payrunAdjustmentUsecase = require("./usecase/payrun_adjustment")(
      this.payrunAdjustmentRepo,
      this.payrunRepo,
      this.payrunCalculationLocks
    );
    // Payrun Calculation & Review: the stage after adjustments, and the one
    // that approves and locks. The rules are in the pure
    // `utils/payrun_calculation.js` - which calls `utils/salary_engine.js` for
    // PF and ESI and `utils/payrun_adjustments.js#computeContract` for the
    // adjustment deltas rather than reimplementing either - and this fetches
    // what they need and performs what they permit. It RECREATES NO ATTENDANCE
    // LOGIC: Salary Days, Extra Days, Missing Hours, the deduction, the
    // approved OT minutes and the effective NRM are all consumed as the
    // attendance engine left them.
    this.payrunCalculationUsecase = require("./usecase/payrun_calculation")(
      this.payrunCalculationRepo,
      this.payrunRepo,
      this.payrunAdjustmentRepo
    );
    // Attendance v2. Orchestration only: the arithmetic is in the pure
    // `utils/attendance_engine.js`, `utils/shiftResolution.js` and
    // `utils/attendance_payroll.js`, and this fetches what they need and
    // shapes what they returned.
    this.attendanceCalculationUsecase = require("./usecase/attendance_calculation")(
      this.attendanceCalculationRepo
    );
    // The Attendance Dashboard. Orchestration only, and it calculates nothing
    // of its own: it calls the SAME pure `calculateAttendanceDay` over the
    // same effective punch stream and the same dated shift resolution, so the
    // dashboard and the employee's own screen can never disagree about a
    // date. It writes nothing and recalculates nothing.
    this.attendanceDashboardUsecase = require("./usecase/attendance_dashboard")(
      this.attendanceDashboardRepo
    );
    // Attendance & Staffing: the operational "right now" snapshot. Built on
    // the dashboard usecase - same batched reads, same engine - and adding
    // only the as-of classification. Stores nothing.
    this.attendanceStaffingUsecase = require("./usecase/attendance_staffing")(
      this.attendanceDashboardRepo,
      this.attendanceDashboardUsecase
    );
    // MISSING ATTENDANCE - one rule, two consumers. The report and the 06:00
    // Telegram job both call this usecase; neither has a population of its
    // own. It reuses the dashboard usecase's batched reads and day
    // computation verbatim, so "punch count" means the same thing here as on
    // every attendance screen. It writes nothing.
    this.attendanceMissingUsecase = require("./usecase/attendance_missing")(
      this.attendanceMissingRepo,
      this.attendanceDashboardUsecase
    );
    // The alert side of the same rule. It decides HOW a message is addressed,
    // sent, recorded and retried - never WHO gets one, which is the usecase
    // above and only that.
    this.attendanceMissingTelegram = require("./usecase/attendance_missing_telegram")({
      attendanceMissingUsecase: this.attendanceMissingUsecase,
      attendanceMissingRepo: this.attendanceMissingRepo,
      telegramService: require("./services/telegram")(),
      // No Mini App exists in this repository yet, so no button is attached.
      // When one does, this is the single value that turns it on - no
      // message, schedule, ledger or population rule has to move.
      miniAppUrl: process.env.ATTENDANCE_CORRECTION_MINI_APP_URL || null,
    });
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
    // Recalculate also re-derives the range's undatable punches, so the
    // Punch Audit stops reporting "No Shift" for an employee whose shift was
    // assigned after their punches arrived. Injected rather than required for
    // the same cycle reason as the OT service above.
    this.attendanceCalculationUsecase.setPunchRedriveService(
      this.attendanceImportUsecase
    );
    // Void Punch. Handed the calculation usecase for the date the punch
    // belongs to and for the recalculation afterwards, and the
    // regularization repository to refuse a void while a request on that
    // date is still pending.
    this.attendancePunchVoidUsecase = require("./usecase/attendance_punch_void")(
      this.attendancePunchVoidRepo,
      this.attendanceCalculationUsecase,
      this.attendanceRegularizationRepo
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
    // Telegram group DETECTION. It owns no Telegram cursor and fetches
    // nothing: `passwordResetUsecase.pollTelegramUpdates` is the single
    // reader of `getUpdates`, and it hands every message it reads to this as
    // an observer. A second poller here would race that one for the shared
    // update offset and each would swallow the other's messages.
    this.telegramGroupDetectionUsecase = require("./usecase/telegram_group_detection")({
      telegram: require("./services/telegram")(),
      registryRepo: this.telegramGroupRegistryRepo,
    });
    // THE UPDATE DISPATCHER. The poller below still owns the loop and the
    // offset; this is only how the one stream reaches more than one feature.
    // Handlers are registered here, once, and never at runtime.
    this.telegramUpdateDispatcher = require("./usecase/telegram_update_dispatcher")();
    this.telegramUpdateDispatcher.register({
      name: "telegram_group_detection",
      updateTypes: ["message"],
      // NO `claims` PREDICATE. Detection OBSERVES `/setup` in a group; it
      // never owns a private `/start`, so password-reset linking is reached
      // exactly as it was before the dispatcher existed. Note that
      // `handleMessage` RETURNS a detection object - a truthy value that means
      // nothing about ownership, which is why ownership is a predicate.
      handle: (update) => this.telegramGroupDetectionUsecase.handleMessage(update.message),
    });
    // EMPLOYEE TELEGRAM LINKING. Registered on the same dispatcher, and it is
    // the first handler that CLAIMS: an employee deep link is `/start e_…`,
    // and password-reset linking must not also answer it - `completeLink`
    // would not find that payload in `telegram_link_tokens` and would tell the
    // employee their link had expired. The predicate is pure and synchronous,
    // so the claim holds even if this handler throws or times out.
    this.employeeTelegramLinkUsecase = require("./usecase/employee_telegram_link")(
      this.employeeTelegramRepo,
      require("./services/telegram")()
    );
    this.telegramUpdateDispatcher.register({
      name: "employee_telegram_link",
      updateTypes: ["message"],
      claims: (update) => this.employeeTelegramLinkUsecase.claims(update),
      handle: (update) => this.employeeTelegramLinkUsecase.handle(update),
    });
    // PHASE 3B: GROUP READINESS AND MANAGED JOINS.
    //
    // Readiness asks TELEGRAM whether a group can be managed - it never
    // trusts the registry's `bot_is_admin` checkbox, which is what somebody
    // declared when registering the group rather than what is true now.
    this.telegramGroupReadinessUsecase = require("./usecase/telegram_group_readiness")(
      require("./services/telegram")()
    );
    this.employeeTelegramMembershipUsecase = require("./usecase/employee_telegram_membership")({
      mappingRepo: this.telegramGroupMappingRepo,
      identityRepo: this.employeeTelegramRepo,
      joinRepo: this.employeeTelegramGroupJoinRepo,
      readiness: this.telegramGroupReadinessUsecase,
      telegram: require("./services/telegram")(),
      // This screen WRITES the cache and never reads it - it asks Telegram.
      verificationRepo: this.employeeTelegramGroupVerificationRepo,
      // Phase 3C: a MANUAL grant makes a group required, so the join action,
      // the membership status and Telegram Complete all cover it - and the
      // join-request approval honours it through the same `isGroupRequired`.
      claimRepo: this.telegramMembershipClaimRepo,
    });
    // THE JOIN-REQUEST HANDLER, ON THE SAME DISPATCHER. `chat_join_request`
    // is already in `allowed_updates` and already aliased by the dispatcher,
    // so this adds a handler and NOT a second poller, offset owner or
    // webhook. `chat_member` is deliberately NOT subscribed: membership is
    // verified on demand with `getChatMember` after an approval or on a
    // screen read, rather than by asking Telegram to stream every member
    // change in every group at us forever.
    this.employeeTelegramJoinRequestUsecase = require("./usecase/employee_telegram_join_request")({
      registryRepo: this.telegramGroupRegistryRepo,
      identityRepo: this.employeeTelegramRepo,
      joinRepo: this.employeeTelegramGroupJoinRepo,
      membership: this.employeeTelegramMembershipUsecase,
      readiness: this.telegramGroupReadinessUsecase,
      telegram: require("./services/telegram")(),
      mappingRepo: this.telegramGroupMappingRepo,
      // A confirmed join teaches the dashboard immediately - the join
      // completes asynchronously, with nobody looking at a screen.
      verificationRepo: this.employeeTelegramGroupVerificationRepo,
    });
    /* ------------------------------------------- Phase 3C: lifecycle ---- */
    //
    // EVERYTHING HERE IS OFF UNTIL IT IS SWITCHED ON. `TELEGRAM_MEMBERSHIP_WORKER`
    // gates the worker entirely, and `TELEGRAM_MEMBERSHIP_REMOVALS` gates
    // removals separately - so the rollout can run claims-only for as long
    // as it likes, maintaining and adopting, before anything is removed from
    // any group.
    this.telegramMembershipConfig = {
      workerEnabled: String(process.env.TELEGRAM_MEMBERSHIP_WORKER || "").toLowerCase() === "on",
      removalsEnabled:
        String(process.env.TELEGRAM_MEMBERSHIP_REMOVALS || "").toLowerCase() === "on",
      jobsPerTick: Number(process.env.TELEGRAM_MEMBERSHIP_JOBS_PER_TICK || 5),
      apiCallsPerTick: Number(process.env.TELEGRAM_MEMBERSHIP_CALLS_PER_TICK || 20),
      removalCapPerTick: Number(process.env.TELEGRAM_MEMBERSHIP_REMOVALS_PER_TICK || 5),
      removalCapPerHour: Number(process.env.TELEGRAM_MEMBERSHIP_REMOVALS_PER_HOUR || 50),
    };
    this.telegramMembershipReconcileUsecase = require("./usecase/telegram_membership_reconcile")({
      claimRepo: this.telegramMembershipClaimRepo,
      jobRepo: this.telegramMembershipJobRepo,
      mappingRepo: this.telegramGroupMappingRepo,
      registryRepo: this.telegramGroupRegistryRepo,
      identityRepo: this.employeeTelegramRepo,
      telegram: require("./services/telegram")(),
      config: this.telegramMembershipConfig,
    });
    this.telegramMembershipWorkerUsecase = require("./usecase/telegram_membership_worker")({
      jobRepo: this.telegramMembershipJobRepo,
      claimRepo: this.telegramMembershipClaimRepo,
      identityRepo: this.employeeTelegramRepo,
      reconcile: this.telegramMembershipReconcileUsecase,
      config: this.telegramMembershipConfig,
    });
    this.telegramMembershipAdminUsecase = require("./usecase/telegram_membership_admin")({
      claimRepo: this.telegramMembershipClaimRepo,
      jobRepo: this.telegramMembershipJobRepo,
      registryRepo: this.telegramGroupRegistryRepo,
    });
    // The two write paths that are not screens: an employee change and an
    // identity change both enqueue inside their own transaction.
    this.employeeMasterUsecase.membershipQueue = this.telegramMembershipJobRepo;
    this.employeeTelegramRepo.membershipQueue = this.telegramMembershipJobRepo;

    this.telegramUpdateDispatcher.register({
      name: "employee_telegram_join_request",
      updateTypes: ["chat_join_request"],
      claims: (update) => this.employeeTelegramJoinRequestUsecase.claims(update),
      handle: (update) => this.employeeTelegramJoinRequestUsecase.handle(update),
    });
    // Stage 0A integration: the Telegram reset writes through the modern
    // password service and audits to user_auth_log; it never touches SHA-1.
    this.passwordResetUsecase = require("./usecase/passwordReset")(
      this.userRepo,
      this.passwordResetRepo,
      require("./services/telegram")(),
      {
        authLogRepo: this.authLogRepo,
        onTelegramUpdate: (update) => this.telegramUpdateDispatcher.dispatch(update),
      }
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
    this.telegramGroupRegistryUsecase = require("./usecase/telegram_group_registry")(
      this.telegramGroupRegistryRepo,
      {
        // Phase 3C: a hard delete cascades the claim rows, and a Chat ID
        // change re-points them, so both are refused while the group still
        // has mappings or unresolved cleanup - decided under row locks
        // these two repositories take, never from a stale count.
        mappingRepo: this.telegramGroupMappingRepo,
        claimRepo: this.telegramMembershipClaimRepo,
      }
    );
    // NO TELEGRAM SERVICE IS PASSED, and that is deliberate rather than an
    // omission: Phase 3A decides who SHOULD be in a group and performs no
    // membership action, so it is given nothing it could send with.
    this.telegramGroupMappingUsecase = require("./usecase/telegram_group_mapping")(
      this.telegramGroupMappingRepo,
      this.telegramGroupRegistryRepo,
      {
        // Phase 3C: a mapping change enqueues reconciliation in the same
        // transaction that writes the mapping. Still no Telegram service
        // here - Phase 3A performs no membership action and this does not
        // change that; the worker is the only thing that calls Telegram.
        membershipQueue: this.telegramMembershipJobRepo,
      }
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

    // GLOBAL DASHBOARD ACCESS - the one location-authorization layer every
    // dashboard uses. Built on the same permission middleware so the
    // administrator bypass is the system's single existing one, and on its own
    // small repository so a future HR or Sales dashboard can be gated without
    // depending on Attendance for its authorization.
    this.dashboardScopeRepo = new (require("./repository/dashboard_scope"))(
      this.mysql.connection
    );
    this.dashboardScope = require("./middlewares/dashboard_scope")(
      this.permissions,
      this.dashboardScopeRepo
    );

    // EMPLOYEE BRANCH SCOPE - the one branch-authorization layer every employee
    // read and every employee write goes through. Built on the same permission
    // middleware so the administrator bypass is the system's single existing
    // one, and on its own small repository so resolving a branch never reaches
    // into the employee repository's `SELECT *` queries.
    this.employeeBranchRepo = new (require("./repository/employee_branch"))(
      this.mysql.connection
    );
    this.employeeBranchScope = require("./middlewares/employee_branch_scope")(
      this.permissions,
      this.employeeBranchRepo
    );

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
      this.sensitive,
      this.employeeBranchScope
    );
    // Stage 0C / C2: the local employee-master lifecycle actions.
    const employeeMasterRouter = require("./routes/employee_master")(
      this.employeeMasterUsecase,
      this.permissions,
      this.sensitive,
      this.employeeAadhaarUsecase,
      this.employeeBankUsecase,
      this.employeeStatusSummaryUsecase,
      this.ifscLookupUsecase,
      this.employeeBranchScope
    );
    // Employee Master Bulk Export / Import. Mounted at /hr with the other
    // employee writes; it claims only the /hr/employees/bulk endpoints,
    // which no other /hr router defines.
    const employeeBulkUpdateRouter = require("./routes/employee_bulk_update")(
      this.employeeBulkUpdateUsecase,
      this.permissions,
      this.sensitive,
      this.employeeBranchScope
    );
    // Employee Telegram setup. A router of its own rather than three more
    // endpoints on the master router: these return no sensitive employee
    // column at all, so there is nothing for B3's response filter to strip.
    const employeeTelegramRouter = require("./routes/employee_telegram")(
      this.employeeTelegramLinkUsecase,
      this.permissions,
      this.employeeBranchScope,
      this.employeeTelegramMembershipUsecase,
      this.telegramGroupMappingRepo,
      // Phase 3C, READ-ONLY on this router: Employee Master shows managed
      // membership; granting one is Group Map work under a different key.
      this.telegramMembershipAdminUsecase
    );
    // THE EXISTING-EMPLOYEE AADHAAR VERIFICATION PATH. A router of its own so
    // that the one endpoint which legitimately accepts an `aadhaar_number` for
    // an employee who already exists is not under the master router's blanket
    // `guardWrite` - see routes/employee_aadhaar_verification.js, which states
    // in full why that is safe and what runs in its place.
    const employeeAadhaarVerificationRouter = require("./routes/employee_aadhaar_verification")(
      this.employeeMasterUsecase,
      this.employeeAadhaarUsecase,
      this.permissions,
      this.sensitive,
      this.employeeBranchScope
    );
    // Reports: discovery, saved templates, preview and the two exports.
    const employeeReportRouter = require("./routes/employee_report")(
      this.employeeReportService,
      this.permissions,
      this.employeeBranchScope
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
      this.permissions,
      this.attendancePunchVoidUsecase
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
      this.sensitive,
      this.employeeBranchScope
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
    // The Attendance Dashboard: read-only aggregates over one attendance date.
    // Every route on it goes through the SHARED Global Dashboard resolver,
    // which requires `view_attendance_dashboard` AND a resolved store scope
    // (Own Store or All Stores) individually per endpoint.
    const attendanceDashboardRouter = require("./routes/attendance_dashboard")(
      this.attendanceDashboardUsecase,
      this.permissions,
      this.sensitive,
      this.attendanceStaffingUsecase,
      this.dashboardScope
    );
    // The Missing Attendance Report: read-only rows and their Excel export.
    // Behind the SAME Global Dashboard resolver as the dashboard above, so a
    // branch manager sees their own branch here and nothing more - a new
    // report widens nobody. The export needs a second key on top.
    const attendanceMissingRouter = require("./routes/attendance_missing")(
      this.attendanceMissingUsecase,
      this.permissions,
      this.sensitive,
      this.dashboardScope
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
    // Payrun Initialization: the first stage of the Monthly Payrun. Mounted at
    // the root, like the attendance routers, because /payrun is its own
    // top-level surface rather than a fact about one employee record.
    const payrunRouter = require("./routes/payrun")(
      this.payrunUsecase,
      this.permissions,
      this.sensitive,
      this.employeeBranchScope
    );
    // Payrun Adjustments: a STAGE of the payrun, not a module beside it, so it
    // claims /payrun/adjustments and nothing else. It adds NO permission key -
    // reads take the same three `GET /payrun/month` takes, writes take
    // `process_payroll`, which is the key initialization already claimed.
    const payrunAdjustmentRouter = require("./routes/payrun_adjustment")(
      this.payrunAdjustmentUsecase,
      this.permissions,
      this.sensitive,
      this.employeeBranchScope
    );
    // Payrun Calculation & Review: a STAGE of the payrun, claiming
    // /payrun/calculation and nothing else. It adds ONE permission key -
    // `approve_payrun` - because approving LOCKS an employee's month, and this
    // repository already separates proposing from approving wherever money is
    // concerned. Reading and calculating reuse the existing keys.
    const payrunCalculationRouter = require("./routes/payrun_calculation")(
      this.payrunCalculationUsecase,
      this.permissions,
      this.sensitive,
      this.employeeBranchScope
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
    const telegramGroupRegistryRouter = require("./routes/telegram_group_registry")(
      this.telegramGroupRegistryUsecase,
      this.permissions,
      this.telegramGroupDetectionUsecase,
      this.telegramGroupMappingUsecase,
      // The SAME live branch resolver every other employee read uses. Passed
      // in rather than resolved inside the usecase so there is one
      // authorization layer for employee names on dnds.co.in, not two.
      this.employeeBranchScope,
      // Phase 3C: manual membership and the queue's admin view, both under
      // `manage_telegram_groups`.
      this.telegramMembershipAdminUsecase
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
    const grnRouter = require("./routes/grn")(
      this.grnUsecase,
      this.permissions
    );
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
    // BEFORE the employee-master router, and the order is load-bearing: the
    // master router mounts B3's `guardWrite` with `router.use`, which runs for
    // every request that enters it whether or not one of its routes matches.
    // Mounted after it, these two endpoints would be refused by that guard -
    // for carrying the very Aadhaar number they exist to verify - before ever
    // being reached. It claims only
    // /hr/employee/:id/aadhaar/initiate and /hr/employee/:id/aadhaar/verify-otp,
    // neither of which any other /hr router defines, so nothing else changes.
    app.use("/hr", employeeAadhaarVerificationRouter.getRouter());
    // Stage 0C / C2. Mounted at /hr so the lifecycle actions do not collide
    // with the existing employee routes and C3 can find them in one place.
    app.use("/hr", employeeMasterRouter.getRouter());
    app.use("/hr", employeeTelegramRouter.getRouter());
    app.use("/hr", employeeBulkUpdateRouter.getRouter());
    // Also /hr: Express tries the routers in order and this one only claims
    // /hr/work-shift-assignments, which the master router does not define.
    app.use("/hr", employeeWorkShiftRouter.getRouter());
    // Also /hr: this one only claims /hr/salary, which neither router above
    // defines, so the ordering is unambiguous.
    app.use("/hr", employeeSalaryRouter.getRouter());
    // Mounted under /reports rather than /hr: the machinery is per-dataset
    // and Attendance and Payroll will mount beside this one, not inside HR.
    app.use("/reports/employee-master", employeeReportRouter.getRouter());
    // Payrun Initialization. Claims only /payrun, which no other router defines.
    app.use("/", payrunRouter.getRouter());
    // The order of these two is immaterial: every path the adjustments router
    // defines sits under /payrun/adjustments, which is disjoint from the four
    // the initialization router defines, so neither shadows the other.
    app.use("/", payrunAdjustmentRouter.getRouter());
    // Likewise /payrun/calculation, which is disjoint from both.
    app.use("/", payrunCalculationRouter.getRouter());

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
    app.use("/", attendanceDashboardRouter.getRouter());
    app.use("/", attendanceMissingRouter.getRouter());
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
    app.use("/telegram-groups", telegramGroupRegistryRouter.getRouter());
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

    // EVERY THREE SECONDS - pick up `/start <token>` messages sent to the
    // Telegram bot and finish linking. Polling rather than a webhook, so the
    // API does not have to be reachable from the internet over HTTPS.
    //
    // SIX FIELDS, AND THE FIRST ONE IS SECONDS. node-cron's optional seconds
    // field is what makes this expressible at all; the five-field form cannot
    // say anything faster than "once a minute". Verified against the pinned
    // node-cron (3.0.3): `cron.validate` accepts it and the task fires on
    // every wall-clock second divisible by three. `services/cron_service.js`
    // now refuses anything that is not five or six fields, because
    // `cron.validate` does NOT - see the guard there.
    //
    // WHY IT CHANGED. A minute was the wait an employee saw while holding
    // their phone after scanning the QR: they tap Start, Telegram shows the
    // message delivered, and then nothing happens for up to sixty seconds
    // while the screen in front of them still says pending. People re-scan,
    // re-tap, and ask whether it is broken. Three seconds is below the point
    // where somebody starts doubting it worked.
    //
    // THE COST IS TWENTY SHORT REQUESTS A MINUTE to one Telegram endpoint,
    // against the ~30-per-second the Bot API permits. `getUpdates` is still
    // SHORT polling (`timeout: 0` in `services/telegram.js`), so each call
    // returns immediately rather than holding a connection open across ticks.
    //
    // OVERLAP IS ALREADY IMPOSSIBLE, and that mattered enough to check before
    // changing this number: `pollTelegramUpdates` takes an in-process
    // re-entrancy guard and returns `skipped: "in_progress"` if a previous
    // tick is still running, so a slow call makes ticks a no-op instead of
    // stacking twenty concurrent readers onto one shared update offset. That
    // guard is in-process, which is sound only while the API is a single
    // fork-mode pm2 instance - asserted in
    // `services/telegram_poll_topology.test.js`.
    const TELEGRAM_LINK_POLL_CRON = "*/3 * * * * *";
    this.cronService.register(
      "telegram_link_poll",
      TELEGRAM_LINK_POLL_CRON,
      async () => {
        await this.passwordResetUsecase.pollTelegramUpdates();
      }
    );

    // PHASE 3C: THE MEMBERSHIP WORKER. A SEPARATE job from the poller above,
    // on a separate schedule, and it must stay that way: the poller owns the
    // getUpdates offset and nothing else may touch it. This one only reads
    // its own queue.
    //
    // Thirty seconds, not three. Reconciliation is not interactive - nobody
    // is watching a screen for it - and the two share one rate-limited bot
    // token, so this one takes the slower lane. Every tick is additionally
    // bounded (jobs, API calls, removals) and guarded against re-entry, and
    // the whole thing is inert unless TELEGRAM_MEMBERSHIP_WORKER=on.
    const TELEGRAM_MEMBERSHIP_WORKER_CRON = "*/30 * * * * *";
    this.cronService.register("telegram_membership_worker", TELEGRAM_MEMBERSHIP_WORKER_CRON, async () => {
      await this.telegramMembershipWorkerUsecase.tick();
    });

    // The safety net, hourly: reclaim jobs whose worker died, and re-enqueue
    // the bounded population that could have changed without passing a
    // hooked path - the Digisme sync reconciles employment in bulk. Enqueue
    // collapses onto one live job per scope, so this is cheap even when it
    // finds nothing.
    this.cronService.register("telegram_membership_sweep", "0 * * * *", async () => {
      await this.telegramMembershipWorkerUsecase.sweep();
    });

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

    /* ------------------------------------------- DigiSME attendance sync
     *
     * Constructed HERE, not beside the other usecases, because it needs
     * `this.apiSyncLogger` and that is not built until initRoutes(). One
     * instance is deliberate: both jobs must share the same pair of
     * re-entrancy guards, and two instances would each think they were the
     * only run in flight.
     *
     * It inserts nothing of its own - it reuses the import repository, the
     * import usecase's resolver and the same biomax/store insertPunch path
     * the Excel upload and a live device punch use.
     *
     * Target: employee punch -> DigiSME -> this sync -> the existing
     * insertPunch path -> dnds.co.in, in about one to two minutes.
     *
     * BOTH JOBS SHARE ONE VENDOR BUDGET, and neither reasons about it. Every
     * DigiSME call - authentication, live fetch, recovery fetch, the 401
     * refresh and its retry - queues behind the single serialized throttle
     * in services/digisme_attendance.js at MIN_CALL_INTERVAL_MS (15s), which
     * caps any 60-second window at four calls against the vendor's limit of
     * five. Adding a third DigiSME caller needs no new coordination; adding
     * a SECOND PROCESS does - see the topology note below.
     *
     * TOPOLOGY. The re-entrancy guards inside the usecase are in-process,
     * and that is sound only while the API runs as ONE process:
     * ecosystem.config.js declares the API with no `instances` and no
     * `exec_mode`, so pm2 runs it in fork mode, single instance, and
     * `pm2 reload 0` is a restart rather than an overlap
     * (docs/auth-stage0a-preproduction-readiness.md, verified snapshot:
     * pm_id=0, exec_mode=fork_mode, instances=1).
     *
     * IF THE API IS EVER CLUSTERED OR SCALED TO MULTIPLE INSTANCES, every
     * instance runs its own copy of these crons AND its own throttle queue.
     * Vendor traffic multiplies by the instance count and silently breaches
     * the 5/minute limit with no error anywhere in our logs. Moving to
     * cluster mode therefore requires revisiting this block first - a lock
     * these jobs can share across processes, or a single designated worker.
     * `services/digisme_cron_topology.test.js` fails if ecosystem.config.js
     * starts declaring instances, so this cannot happen quietly.
     */

    this.digismeAttendanceSyncUsecase = require("./usecase/digisme_attendance_sync")({
      client: require("./services/digisme_attendance"),
      repo: this.attendanceImportRepo,
      store: this.biomaxImportStore,
      importUsecase: this.attendanceImportUsecase,
      apiSyncLogger: this.apiSyncLogger,
      // TEMPORARY, DIGISME-ONLY DESTINATION. Not the shared alerts group.
      //
      // These alerts go to one personal chat because this bridge lasts about
      // ten days and its failures are one person's to chase. Everything else
      // that alerts - accounts, purchase orders, break-glass - keeps using
      // ALERTS_TELEGRAM_CHAT_ID, untouched. Remove this alerter with the rest
      // of the bridge when Biomax reaches dnds.co.in directly.
      //
      // ONLY EXCEPTIONAL CONDITIONS REACH HERE. The usecase decides what is
      // exceptional and a routine poll never is: a quiet minute, and a poll
      // whose punches are all already stored, are ordinary successes that
      // send nothing. See `_alert` and its 60-minute per-condition cooldown.
      alerter: {
        sendMessage: (text) =>
          require("./services/telegram")().sendMessage(DIGISME_ATTENDANCE_ALERT_CHAT_ID, text, {
            disableNotification: false,
            parseMode: null,
          }),
      },
    });

    // Every minute: TODAY only. Fetches the whole current day rather than a
    // delta, so a minute lost to a deploy or a vendor blip is recovered by
    // the next poll and today never needs the recovery job. A tick arriving
    // while the previous run is still in flight is skipped, not queued.
    /**
     * MISSING ATTENDANCE ALERTS - 06:00 IST, yesterday only.
     *
     * "0 6 * * *" in `CRON_TIMEZONE`, which `services/cron_service.js` pins
     * to Asia/Kolkata. The job asks the SHARED rule for yesterday's Missing
     * Attendance (`usecase/attendance_missing.js#getTelegramCandidates` - the
     * report's own builder with the window pinned) and messages each employee
     * privately. It never computes a population of its own, so it cannot
     * disagree with the report a manager opens at 09:00.
     *
     * OFF BY DEFAULT, AND DELIBERATELY. `ATTENDANCE_MISSING_TELEGRAM_ENABLED`
     * must be set to "true" before a single message is sent. The feature is
     * complete and tested, but the first run messages every employee who
     * missed a punch yesterday, on their personal Telegram, at six in the
     * morning - that is an operational decision for a person to make on a
     * chosen day, not something a deploy should start doing by itself. With
     * the flag unset the job is registered, logs that it is disabled, and
     * sends nothing.
     *
     * RE-RUNNING IT IS SAFE. Every send is claimed against a UNIQUE
     * (employee, attendance_date) key before it is attempted, so a retry, a
     * second instance or a manual re-run sends nothing new.
     *
     * ONE FAILURE IS ONE FAILURE. The batch catches per employee; a blocked
     * bot or a deleted chat is recorded FAILED and the loop carries on. The
     * wrapper below catches anything that escapes so a cron tick can never
     * take the process down.
     */
    this.cronService.register("attendance_missing_telegram", "0 6 * * *", async () => {
      if (String(process.env.ATTENDANCE_MISSING_TELEGRAM_ENABLED || "").toLowerCase() !== "true") {
        console.log(
          "[CRON] attendance_missing_telegram — ATTENDANCE_MISSING_TELEGRAM_ENABLED is not 'true'; nothing sent"
        );
        return;
      }
      try {
        const summary = await this.attendanceMissingTelegram.run();
        console.log(
          `[CRON] attendance_missing_telegram ${summary.attendance_date}: ` +
            `${summary.sent} sent, ${summary.failed} failed, ${summary.skipped} skipped ` +
            `of ${summary.candidates} candidate(s)`
        );
      } catch (err) {
        logger.Log({
          level: logger.LEVEL.ERROR,
          component: "CRON.ATTENDANCE_MISSING_TELEGRAM",
          code: "CRON.ATTENDANCE_MISSING_TELEGRAM.RUN",
          description: err.toString(),
          category: "",
          ref: {},
        });
      }
    });

    this.cronService.register("digisme_attendance_live", "* * * * *", async () => {
      return await this.digismeAttendanceSyncUsecase.runLive();
    });

    // Four times a day: today-3, today-2, yesterday - for vendor-delayed
    // records only. :45 is chosen because every other in-process cron sits
    // at :00, :15 or :30, so a recovery run never contends with one.
    this.cronService.register("digisme_attendance_recovery", "45 6,12,18,23 * * *", async () => {
      return await this.digismeAttendanceSyncUsecase.runHistorical();
    });

    this.synker.initCronJobs(this.cronService, this.apiSyncLogger);
    this.cronService.start();

    // Wire synker back into cleaningPackingUsecase after service creation
    if (this.cleaningPackingUsecase && this.cleaningPackingUsecase.setSynker) {
      this.cleaningPackingUsecase.setSynker(this.synker);
    }

    // Stage 0C / C1c: wired so the reconciler is callable. It has no caller
    // since the Digisme employee sync was removed - see
    // Synker#reconcileEmployeeLifecycle and
    // docs/digisme-employee-sync-removal.md.
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
