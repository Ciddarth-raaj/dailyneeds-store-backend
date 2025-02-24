const logger = require("../utils/logger");

class TallyRepository {
  constructor(db) {
    this.db = db;
  }

  // getPurchase(from_date, to_date) {
  //   return new Promise((resolve, reject) => {
  //     this.db.query(
  //       "SELECT * FROM purchase WHERE mmh_dist_bill_dt BETWEEN ? AND ? AND is_approved = 1",
  //       [from_date, to_date],
  //       (err, docs) => {
  //         if (err) {
  //           logger.Log({
  //             level: logger.LEVEL.ERROR,
  //             component: "REPOSITORY.TALLY",
  //             code: "REPOSITORY.TALLY.GET_PURCHASE",
  //             description: err.toString(),
  //             category: "",
  //             ref: {},
  //           });
  //           reject(err);
  //           return;
  //         }
  //         resolve(docs);
  //       }
  //     );
  //   });
  // }
}

module.exports = (db) => {
  return new TallyRepository(db);
};
