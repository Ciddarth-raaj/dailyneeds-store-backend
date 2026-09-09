class ShiftUsecase {
    constructor(shiftRepo) {
        this.shiftRepo = shiftRepo;
    }

    get() {
        return new Promise(async (resolve, reject) => {
            try {
                const data = await this.shiftRepo.get();
                resolve(data);
            } catch (err) {
                reject(err);
            }
        });
    }
    updateStatus(file) {
      return new Promise(async (resolve, reject) => {
        try {
          await this.shiftRepo.updateStatus(file);
          resolve(200);
        } catch (err) {
          reject(err);
        }
      });
    }
    getShiftById(shift_id) {
        return new Promise(async (resolve, reject) => {
          try {
            const data = await this.shiftRepo.getShiftById(shift_id);
            resolve(data);
          } catch (err) {
            console.log(err);
            reject(err);
          }
        });
      }
      updateShiftDetails(shift) {
        return new Promise(async (resolve, reject) => {
          try {
            const shift_id = shift.shift_id;
            const { code } = await this.shiftRepo.updateShiftDetails(shift.shift_details, shift_id);  
            resolve(code);
          } catch (err) {
            reject(err);
          }
        });
      }
    create(shift) {
        return new Promise(async (resolve, reject) => {
            try {
                this.shiftRepo.create(shift);
                resolve({ code: 200 });
            } catch (err) {
                reject(err);
            }
        });
    }
}

module.exports = (shiftRepo) => {
    return new ShiftUsecase(shiftRepo);
};
