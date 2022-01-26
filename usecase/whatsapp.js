
class WhatsappUsecase {
    constructor(whatsappRepo) {
      this.whatsappRepo = whatsappRepo;
    }
  
    get() {
      return new Promise(async (resolve, reject) => {
        try {
          const data = await this.whatsappRepo.get();
          resolve(data);
        } catch (err) {
          reject(err);
        }
      });
    }

    updateStatus(file) {
      return new Promise(async (resolve, reject) => {
        try {
          await this.whatsappRepo.updateStatus(file);
          resolve(200);
        } catch (err) {
          reject(err);
        }
      });
    }
  
    updateWhatsappDetails(whatsapp) {
      return new Promise(async (resolve, reject) => {
        try {
          const order_id = whatsapp.order_id;
          const { code } = await this.whatsappRepo.updateWhatsappDetails(whatsapp.whatsapp_details, order_id);
          resolve(code);
        } catch (err) {
          reject(err);
        }
      });
    }
  
    getWhatsappById(order_id) {
      return new Promise(async (resolve, reject) => {
        try {
          const data = await this.whatsappRepo.getById(order_id);
          resolve(data);
        } catch (err) {
          console.log(err);
          reject(err);
        }
      });
    }
  
    create(whatsapp) {
      return new Promise(async (resolve, reject) => {
        try {
          this.whatsappRepo.create(whatsapp);
          resolve(200);
        } catch (err) {
          reject(err);
        }
      });
    }
  }
  
  module.exports = (whatsappRepo) => {
    return new WhatsappUsecase(whatsappRepo);
  };
  