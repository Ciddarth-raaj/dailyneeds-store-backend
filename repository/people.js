const logger = require("../utils/logger");

class PeopleRepository {
  constructor(db) {
    this.db = db;
  }

  create(person) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "INSERT INTO people_list (name, primary_phone, secondary_phone, person_type) VALUES (?, ?, ?, ?)",
        [
          person.name,
          person.primary_phone,
          person.secondary_phone,
          person.person_type,
        ],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PEOPLE",
              code: "REPOSITORY.PEOPLE.CREATE",
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

  update(person) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "UPDATE people_list SET name = ?, primary_phone = ?, secondary_phone = ?, person_type = ? WHERE person_id = ?",
        [
          person.name,
          person.primary_phone,
          person.secondary_phone,
          person.person_type,
          person.person_id,
        ],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PEOPLE",
              code: "REPOSITORY.PEOPLE.UPDATE",
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

  delete(personId) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "DELETE FROM people_list WHERE person_id = ?",
        [personId],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PEOPLE",
              code: "REPOSITORY.PEOPLE.DELETE",
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

  getAll() {
    return new Promise((resolve, reject) => {
      this.db.query("SELECT * FROM people_list", [], (err, docs) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.PEOPLE",
            code: "REPOSITORY.PEOPLE.GET-ALL",
            description: err.toString(),
            category: "",
            ref: {},
          });
          reject(err);
          return;
        }
        resolve({ code: 200, data: docs });
      });
    });
  }
}

module.exports = (db) => {
  return new PeopleRepository(db);
};
