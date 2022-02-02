global.env =
  process.env.NODE_ENV === undefined ? "development" : process.env.NODE_ENV
global.isDev = () => {
  return global.env === "development"
}

const PORT = process.env.PORT === undefined ? 8080 : process.env.PORT;

const express = require("express");
const app = express();
const compression = require("compression");
const bodyParser = require("body-parser");
const HttpServer = require("http").createServer(app);

const logger = require("./utils/logger");

class Server {
  constructor() {
    this.drivers = [];
    this.init();
  }

  async init() {
    try {
      await this.initDrivers();

      this.initRepositories();
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
    app.use(bodyParser.json()); // to support JSON-encoded bodies
    app.use(
      bodyParser.urlencoded({
        // to support URL-encoded bodies
        extended: true,
      })
    );
    app.use(express.static(__dirname + "/views", { maxAge: "30 days" }));
  }

  initServer() {
    HttpServer.listen(PORT, () => {
      console.log(`Server Running ${PORT}`);
    });
  }

  initDrivers() {
    return new Promise(async (resolve, reject) => {
      try {
        this.mysql = await require("./drivers/mysql")().connect();
        //this.mongo = require('./models/mongo')().connect();

        this.drivers.push(this.mysql);
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
    this.departmentRepo = require("./repository/department")(this.mysql.connection);
    this.designationRepo = require("./repository/designation")(this.mysql.connection);
    this.employeeRepo = require("./repository/employee")(this.mysql.connection);
    this.shiftRepo = require("./repository/shift")(this.mysql.connection);
    this.storeRepo = require("./repository/store")(this.mysql.connection);
    this.outletRepo = require("./repository/outlet")(this.mysql.connection);
    this.familyRepo = require("./repository/family")(this.mysql.connection);
    this.companyRepo = require("./repository/company")(this.mysql.connection);
    this.materialtypeRepo = require("./repository/materialtype")(this.mysql.connection);
    this.materialsizeRepo = require("./repository/materialsize")(this.mysql.connection);
    this.salaryRepo = require("./repository/salary")(this.mysql.connection);
    this.resignationRepo = require("./repository/resignation")(this.mysql.connection);
    this.productRepo = require("./repository/product")(this.mysql.connection);
    this.imageRepo = require("./repository/image")(this.mysql.connection);
    this.categoryRepo = require("./repository/category")(this.mysql.connection)
    this.subcategoryRepo = require("./repository/subcategory")(this.mysql.connection)
    this.brandRepo = require("./repository/brand")(this.mysql.connection)
    this.indentRepo = require("./repository/indent")(this.mysql.connection)
    this.despatchRepo = require("./repository/despatch")(this.mysql.connection)
    this.vehicleRepo = require("./repository/vehicle")(this.mysql.connection)
    this.userRepo = require("./repository/user")(this.mysql.connection)
  }

  initUsecases() {
    this.documentUsecase = require("./usecase/document")(this.documentRepo);
    this.whatsappUsecase = require("./usecase/whatsapp")(this.whatsappRepo);
    this.budgetUsecase = require("./usecase/budget")(this.budgetRepo);
    this.issueUsecase = require("./usecase/issue")(this.issueRepo, this.indentRepo);
    this.vehicleUsecase = require("./usecase/vehicle")(this.vehicleRepo);
    this.exampleUsecase = require("./usecase/example")(this.exampleRepo);
    this.departmentUsecase = require("./usecase/department")(this.departmentRepo);
    this.designationUsecase = require("./usecase/designation")(this.designationRepo);
    this.employeeUsecase = require("./usecase/employee")(
      this.employeeRepo,
      this.documentUsecase,
      this.userRepo,
      this.resignationRepo
    );
    this.shiftUsecase = require("./usecase/shift")(this.shiftRepo);
    this.storeUsecase = require("./usecase/store")(this.storeRepo);
    this.outletUsecase = require("./usecase/outlet")(this.outletRepo, this.budgetRepo);
    this.familyUsecase = require("./usecase/family")(this.familyRepo);
    this.companyUsecase = require("./usecase/company")(this.companyRepo);
    this.materialtypeUsecase = require("./usecase/materialtype")(this.materialtypeRepo);
    this.materialsizeUsecase = require("./usecase/materialsize")(this.materialsizeRepo);
    this.salaryUsecase = require("./usecase/salary")(this.salaryRepo);
    this.resignationUsecase = require("./usecase/resignation")(this.resignationRepo);
    this.productUsecase = require("./usecase/product")(this.productRepo);
    this.imageUsecase = require("./usecase/image")(this.imageRepo);
    this.assetUsecase = require("./usecase/asset");
    this.categoryUsecase = require("./usecase/category")(this.categoryRepo)
    this.subcategoryUsecase = require("./usecase/subcategory")(this.subcategoryRepo)
    this.brandUsecase = require("./usecase/brand")(this.brandRepo)
    this.indentUsecase = require("./usecase/indent")(this.indentRepo)
    this.despatchUsecase = require("./usecase/despatch")(
      this.despatchRepo,
      this.indentUsecase
    )
    this.userUsecase = require("./usecase/user")(
      this.userRepo, 
      this.designationRepo, 
      this.employeeRepo
    )
  }

  initRoutes() {
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
    const departmentRouter = require("./routes/department")(this.departmentUsecase);
    const designationRouter = require("./routes/designation")(this.designationUsecase);
    const employeeRouter = require("./routes/employee")(this.employeeUsecase);
    const shiftRouter = require("./routes/shift")(this.shiftUsecase);
    const storeRouter = require("./routes/store")(this.storeUsecase);
    const outletRouter = require("./routes/outlet")(this.outletUsecase);
    const companyRouter = require("./routes/company")(this.companyUsecase);
    const materialtypeRouter = require("./routes/materialtype")(this.materialtypeUsecase);
    const materialsizeRouter = require("./routes/materialsize")(this.materialsizeUsecase);
    const salaryRouter = require("./routes/salary")(this.salaryUsecase);
    const resignationRouter = require("./routes/resignation")(this.resignationUsecase);
    const imageRouter = require("./routes/image")(this.imageUsecase);
    const productRouter = require("./routes/product")(this.productUsecase);
    const categoryRouter = require("./routes/category")(this.categoryUsecase);
    const subcategoryRouter = require("./routes/subcategory")(this.subcategoryUsecase);
    const brandRouter = require("./routes/brand")(this.brandUsecase);
    const indentRouter = require("./routes/indent")(this.indentUsecase);
    const despatchRouter = require("./routes/despatch")(this.despatchUsecase);
    const userRouter = require('./routes/user')(this.userUsecase);

    app.use("/document", documentRouter.getRouter());
    app.use("/whatsapp", whatsappRouter.getRouter());
    app.use("/budget", budgetRouter.getRouter());
    app.use("/issue", issueRouter.getRouter());
    app.use("/vehicle", vehicleRouter.getRouter());
    app.use("/family", familyRouter.getRouter());
    app.use("/asset", assetRouter.getRouter());
    app.use("/example", exampleRouter.getRouter());
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
  }

  initServices() {
    this.synker = require("./services/synker")(
      this.productUsecase,
      this.categoryUsecase,
      this.subcategoryUsecase,
      this.departmentUsecase,
      this.brandUsecase)
    this.synker.syncProducts()

    // this.telegram = require("./services/telegram")();
    // this.telegram.sendMessage(chat_id, msg)
  }

  onClose() {
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
