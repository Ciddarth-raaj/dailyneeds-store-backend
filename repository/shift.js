const logger = require("../utils/logger");

class ShiftRepository {
    constructor(db) {
        this.db = db;
    }

    get() {
        return new Promise((resolve, reject) => {
            this.db.query(
                "SELECT * FROM SHIFT_MASTER",
                [],
                (err, docs) => {
                    if (err) {
                        logger.Log({
                            level: logger.LEVEL.ERROR,
                            component: "REPOSITORY.SHIFT",
                            code: "REPOSITORY.SHIFT.GET",
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
    return new ShiftRepository(db);
};
