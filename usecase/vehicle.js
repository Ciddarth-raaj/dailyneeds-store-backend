
class VehicelUsecase {
    constructor(vehicleRepo) {
        this.vehicleRepo = vehicleRepo;
    }

    get() {
        return new Promise(async (resolve, reject) => {
            try {
                const data = await this.vehicleRepo.get();
                resolve(data);
            } catch (err) {
                reject(err);
            }
        });
    }
}
module.exports = (vehicleRepo) => {
    return new VehicelUsecase(vehicleRepo);
};
