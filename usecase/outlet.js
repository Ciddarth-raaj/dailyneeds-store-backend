
class OutletUsecase {
    constructor(outletRepo) {
        this.outletRepo = outletRepo;
    }

    get() {
        return new Promise(async (resolve, reject) => {
            try {
                const data = await this.outletRepo.get();
                resolve(data);
            } catch (err) {
                reject(err);
            }
        });
    }
    updateOutletDetails(outlet) {
        return new Promise(async (resolve, reject) => {
          try {
            const outlet_id = outlet.outlet_id;
            const { code } = await this.outletRepo.updateOutletDetails(outlet.outlet_details, outlet_id);  
            resolve(code);
          } catch (err) {
            reject(err);
          }
        });
      }
    create(outlet) {
        return new Promise(async (resolve, reject) => {
            try {
                this.outletRepo.create(outlet);
                resolve(200);
            } catch (err) {
                reject(err);
            }
        });
    }
}
module.exports = (outletRepo) => {
    return new OutletUsecase(outletRepo);
};
