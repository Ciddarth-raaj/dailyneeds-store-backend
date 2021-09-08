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
    this.exampleRepo = require("./repository/example")(this.mysql.connection);
    this.departmentRepo = require("./repository/department")(this.mysql.connection);
    this.designationRepo = require("./repository/designation")(this.mysql.connection);
    this.employeeRepo = require("./repository/employee")(this.mysql.connection);
    this.shiftRepo = require("./repository/shift")(this.mysql.connection);
    this.storeRepo = require("./repository/store")(this.mysql.connection);
  }

  initUsecases() {
    this.documentUsecase = require("./usecase/document")(this.documentRepo);
    this.exampleUsecase = require("./usecase/example")(this.exampleRepo);
    this.departmentUsecase = require("./usecase/department")(this.departmentRepo);
    this.designationUsecase = require("./usecase/designation")(this.designationRepo);
    this.employeeUsecase = require("./usecase/employee")(this.employeeRepo, this.documentUsecase);
    this.shiftUsecase = require("./usecase/shift")(this.shiftRepo);
    this.storeUsecase = require("./usecase/store")(this.storeRepo);
    this.assetUsecase = require("./usecase/asset");
  }

  initRoutes() {
    const authMiddleWare = require("./middlewares/auth");
    app.use(authMiddleWare);

    const documentRouter = require("./routes/document")(this.documentUsecase);
    const assetRouter = require("./routes/asset")(this.assetUsecase);
    const exampleRouter = require("./routes/example")(this.exampleUsecase);
    const departmentRouter = require("./routes/department")(this.departmentUsecase);
    const designationRouter = require("./routes/designation")(this.designationUsecase);
    const employeeRouter = require("./routes/employee")(this.employeeUsecase);
    const shiftRouter = require("./routes/shift")(this.shiftUsecase);
    const storeRouter = require("./routes/store")(this.storeUsecase);
    //const exampleRouter = require('./routes/example')( this.example_controller );

    app.use("/document", documentRouter.getRouter());
		app.use("/asset", assetRouter.getRouter());
    app.use("/example", exampleRouter.getRouter());
    app.use("/department", departmentRouter.getRouter());
    app.use("/designation", designationRouter.getRouter());
    app.use("/employee", employeeRouter.getRouter());
    app.use("/shift", shiftRouter.getRouter());
    app.use("/store", storeRouter.getRouter());
    //app.use('/example', displayRouter.getRouter());
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
