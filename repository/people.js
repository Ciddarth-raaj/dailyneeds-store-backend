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

  createOutletMap(store_id, person_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "INSERT INTO people_list_outlets_map (store_id, person_id) VALUES (?, ?)",
        [store_id, person_id],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.PEOPLE",
              code: "REPOSITORY.PEOPLE.CREATE-OUTLET-MAP",
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
        "UPDATE people_list SET name = ?, primary_phone = ?, secondary_phone = ?, person_type = ?, store_id = ? WHERE person_id = ?",
        [
          person.name,
          person.primary_phone,
          person.secondary_phone,
          person.person_type,
          person.store_id,
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
      this.db.query(
        `SELECT people_list.*, 
         GROUP_CONCAT(people_list_outlets_map.store_id) as store_ids 
         FROM people_list 
         LEFT JOIN people_list_outlets_map ON people_list_outlets_map.person_id = people_list.person_id 
         GROUP BY people_list.person_id`,
        [],
        (err, docs) => {
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

          // Convert comma-separated store_ids string to array of numbers
          const people = docs.map((person) => ({
            ...person,
            store_ids: person.store_ids
              ? person.store_ids.split(",").map(Number)
              : null,
          }));

          resolve({ code: 200, data: people });
        }
      );
    });
  }
}

module.exports = (db) => {
  return new PeopleRepository(db);
};
