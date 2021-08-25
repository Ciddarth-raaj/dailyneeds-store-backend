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
