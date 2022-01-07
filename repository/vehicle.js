const logger = require("../utils/logger");

class VehicleRepository {
  constructor(db) {
    this.db = db;
  }

  get() {
    return new Promise((resolve, reject) => {
      this.db.query(
        "SELECT * FROM vehicle",
        [],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.VEHICLE",
              code: "REPOSITORY.VEHICLE.GET",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs)
        }
      );
    });
  }
}

module.exports = (db) => {
  return new VehicleRepository(db);
};
