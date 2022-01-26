const logger = require("../utils/logger")

class WhatsappRepository {
  constructor (db) {
    this.db = db
  }

  get () {
    return new Promise((resolve, reject) => {
      this.db.query("SELECT * FROM whatsapp", [], (err, docs) => {
        if (err) {
          logger.Log({
            level: logger.LEVEL.ERROR,
            component: "REPOSITORY.WHATSAPP",
            code: "REPOSITORY.WHATSAPP.GET",
            description: err.toString(),
            category: "",
            ref: {}
          })
          reject(err)
          return
        }
        resolve(docs)
      })
    })
  }

  getById (order_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "SELECT * FROM whatsapp where order_id = ?",
        [order_id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.WHATSAPP",
              code: "REPOSITORY.WHATSAPP.GET-ID",
              description: err.toString(),
              category: "",
              ref: {}
            })
            reject(err)
            return
          }
          resolve(docs)
        }
      )
    })
  }
  updateStatus (file) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "UPDATE whatsapp SET status = ? WHERE order_id = ?",
        [file.status, file.order_id],
        (err, docs) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.WHATSAPP",
              code: "REPOSITORY.WHATSAPP.UPDATE-STATUS",
              description: err.toString(),
              category: "",
              ref: {}
            })
            reject(err)
            return
          }
          resolve(docs)
        }
      )
    })
  }
  
  updateWhatsappDetails (data, order_id) {
    return new Promise((resolve, reject) => {
      this.db.query(
        `UPDATE whatsapp SET ? WHERE order_id = ?`,
        [data, order_id],
        (err, res) => {
          if (err) {
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.WHATSAPP",
              code: "REPOSITORY.WHATSAPP.UPDATE-WHATSAPP-DETAILS",
              description: err.toString(),
              category: "",
              ref: {}
            })
            reject(err)
            return
          }
          resolve({ code: 200 })
        }
      )
    })
  }
  create (whatsapp) {
    return new Promise((resolve, reject) => {
      this.db.query(
        "INSERT INTO whatsapp (first_name, last_name, primary_address, city, mobile_no, pin_code, payment_type, order_text, attached_image) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            whatsapp.first_name, 
            whatsapp.last_name,
            whatsapp.primary_address,
            whatsapp.city,
            whatsapp.mobile_no,
            whatsapp.pin_code,
            whatsapp.payment_type,
            whatsapp.order_text,
            whatsapp.attached_image
        ],
        (err, res) => {
          if (err) {
            if (err.code === "ER_DUP_ENTRY") {
              resolve({ code: 101 })
              return
            }
            logger.Log({
              level: logger.LEVEL.ERROR,
              component: "REPOSITORY.WHATSAPP",
              code: "REPOSITORY.WHATSAPP.CREATE",
              description: err.toString(),
              category: "",
              ref: {}
            })
            reject(err)
            return
          }
          resolve({ code: 200, id: res.insertId })
        }
      )
    })
  }
}

module.exports = db => {
  return new WhatsappRepository(db)
}
