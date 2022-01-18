
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
    getVehicleCount() {
        return new Promise(async (resolve, reject) => {
          try {
            const data = await this.vehicleRepo.getVehicleCount();
            resolve(data);
          } catch (err) {
            reject(err);
          }
        }); 
      }
    getVehicleById(vehicle_id) {
        return new Promise(async (resolve, reject) => {
          try {
            const data = await this.vehicleRepo.getVehicleById(vehicle_id);
            resolve(data);
          } catch (err) {
            console.log(err);
            reject(err);
          }
        });
      }
      create(vehicle) {
        return new Promise(async (resolve, reject) => {
            try {
                this.vehicleRepo.create(vehicle);
                resolve(200);
            } catch (err) {
                reject(err);
            }
        });
    }
    updateVehicleDetails(vehicle) {
        return new Promise(async (resolve, reject) => {
          try {
            const vehicle_id = vehicle.vehicle_id;
            const { code } = await this.vehicleRepo.updateVehicleDetails(vehicle.vehicle_details, vehicle_id);
            resolve(code);
          } catch (err) {
            reject(err);
          }
        });
      }
    getVehicle(limit, offset) {
        return new Promise(async (resolve, reject) => {
            try {
                const data = await this.vehicleRepo.getVehicle(limit, offset);
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
