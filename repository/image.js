const logger = require("../utils/logger");

class ImageRepository {
  constructor(db) {
    this.db = db;
  }

  getImageById(product_id) {
    return new Promise((resolve, reject) => {
      this.db.query("SELECT image_url FROM product_images where product_id = ?",
      [product_id], 
      (err, docs) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.IMAGE",
            code: "REPOSITORY.IMAGE.GET-IMAGE-ID",
            description: err.toString(),
            category: "",
            ref: {},
          });
          reject(err);
          return;
        }
        resolve(docs);
      });
    });
  }
}

module.exports = (db) => {
  return new ImageRepository(db);
};