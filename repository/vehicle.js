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
  getVehicleCount() {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT count(vehicle_id) AS vehiclecount FROM vehicle`,
        [],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.VEHICLE",
              code: "REPOSITORY.VEHICLE.GET-VEHICLE-COUNT",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs);
        }
      );
    });
  }
  getVehicleById(vehicle_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "SELECT * FROM vehicle where vehicle_id = ?",
        [vehicle_id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.VEHICLE",
              code: "REPOSITORY.VEHICLE.GET-ID",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve(docs);
        }
      );
    });
  }
  updateVehicleDetails(data, vehicle_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `UPDATE vehicle SET ? WHERE vehicle_id = ?`,
        [data, vehicle_id],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.VEHICLE",
              code: "REPOSITORY.VEHICLE.UPDATE-VEHICLE-DETAILS",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve({ code: 200 });
        }
      );
    });
  }
  create(vehicle) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "INSERT INTO vehicle (vehicle_name, vehicle_number, chasis_number, engine_number, fc_validity, insurance_validity) VALUES (?, ?, ?, ?, ?, ?)",
        [
          vehicle.vehicle_name,
          vehicle.vehicle_number,
          vehicle.chasis_number,
          vehicle.engine_number,
          vehicle.fc_validity,
          vehicle.insurance_validity
        ],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.VEHICLE",
              code: "REPOSITORY.VEHICLE.CREATE",
              description: err.toString(),
              category: "",
              ref: {},
            });
            reject(err);
            return;
          }
          resolve({ code: 200, id: res.insertId });
        }
      );
    });
  }
  getVehicle(limit, offset) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `SELECT * FROM vehicle LIMIT ${offset},${limit}`,
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.VEHICLE",
              code: "REPOSITORY.VEHICLE.GET-DETAILS",
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
