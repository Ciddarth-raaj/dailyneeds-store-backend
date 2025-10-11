class EbConsumptionUsecase {
  constructor(ebConsumptionRepo) {
    this.ebConsumptionRepo = ebConsumptionRepo;
  }

  create(consumptionData) {
    return new Promise(async (resolve, reject) => {
      try {
        const result = await this.ebConsumptionRepo.create(consumptionData);
        resolve({
          code: 200,
          message: "EB Consumption record created successfully",
          data: result,
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  getAll() {
    return new Promise(async (resolve, reject) => {
      try {
        const consumptions = await this.ebConsumptionRepo.getAll();
        resolve({
          code: 200,
          message: "EB Consumption records retrieved successfully",
          data: consumptions,
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  getById(consumptionId) {
    return new Promise(async (resolve, reject) => {
      try {
        const consumption = await this.ebConsumptionRepo.getById(consumptionId);
        if (consumption) {
          resolve({
            code: 200,
            message: "EB Consumption record retrieved successfully",
            data: consumption,
          });
        } else {
          resolve({
            code: 404,
            message: "EB Consumption record not found",
          });
        }
      } catch (err) {
        reject(err);
      }
    });
  }

  update(consumptionId, consumptionData) {
    return new Promise(async (resolve, reject) => {
      try {
        // Check if consumption record exists first
        const existingConsumption = await this.ebConsumptionRepo.getById(
          consumptionId
        );
        if (!existingConsumption) {
          resolve({
            code: 404,
            message: "EB Consumption record not found",
          });
          return;
        }

        const result = await this.ebConsumptionRepo.update(
          consumptionId,
          consumptionData
        );
        if (result.affectedRows > 0) {
          resolve({
            code: 200,
            message: "EB Consumption record updated successfully",
            data: { consumptionId, ...consumptionData },
          });
        } else {
          resolve({
            code: 400,
            message: "No changes made to the EB Consumption record",
          });
        }
      } catch (err) {
        reject(err);
      }
    });
  }

  delete(consumptionId) {
    return new Promise(async (resolve, reject) => {
      try {
        // Check if consumption record exists first
        const existingConsumption = await this.ebConsumptionRepo.getById(
          consumptionId
        );
        if (!existingConsumption) {
          resolve({
            code: 404,
            message: "EB Consumption record not found",
          });
          return;
        }

        const result = await this.ebConsumptionRepo.delete(consumptionId);
        if (result.affectedRows > 0) {
          resolve({
            code: 200,
            message: "EB Consumption record deleted successfully",
            data: { consumptionId },
          });
        } else {
          resolve({
            code: 400,
            message: "Failed to delete EB Consumption record",
          });
        }
      } catch (err) {
        reject(err);
      }
    });
  }
}

module.exports = (ebConsumptionRepo) => {
  return new EbConsumptionUsecase(ebConsumptionRepo);
};
