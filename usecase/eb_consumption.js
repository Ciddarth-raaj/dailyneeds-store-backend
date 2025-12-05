class EbConsumptionUsecase {
  constructor(ebConsumptionRepo) {
    this.ebConsumptionRepo = ebConsumptionRepo;
  }

  create(consumptionData) {
    return new Promise(async (resolve, reject) => {
      try {
        // Check if new format with eb_machines array is used
        if (
          consumptionData.eb_machines &&
          Array.isArray(consumptionData.eb_machines)
        ) {
          const result = await this.ebConsumptionRepo.bulkCreateOrUpdate(
            consumptionData
          );
          resolve({
            code: 200,
            message: "EB Consumption records created/updated successfully",
            data: result.records,
          });
        } else {
          // Legacy single record format
          const result = await this.ebConsumptionRepo.create(consumptionData);
          resolve({
            code: 200,
            message: "EB Consumption record created successfully",
            data: result,
          });
        }
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
        const records = await this.ebConsumptionRepo.getById(consumptionId);
        if (!records || records.length === 0) {
          resolve({
            code: 404,
            message: "EB Consumption record not found",
          });
          return;
        }

        // Format the response similar to create schema
        const firstRecord = records[0];
        const formattedData = {
          date: firstRecord.date,
          branch_id: firstRecord.branch_id,
          eb_machines: records.map((record) => ({
            ...record,
            nickname: record.machine_nickname,
            eb_machine_id: record.eb_machine_id,
            opening_units: parseFloat(record.opening_units) || 0,
            closing_units: parseFloat(record.closing_units) || 0,
          })),
        };

        resolve({
          code: 200,
          message: "EB Consumption records retrieved successfully",
          data: formattedData,
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  update(consumptionId, consumptionData) {
    return new Promise(async (resolve, reject) => {
      try {
        // Check if new format with eb_machines array is used
        if (
          consumptionData.eb_machines &&
          Array.isArray(consumptionData.eb_machines)
        ) {
          const result = await this.ebConsumptionRepo.bulkCreateOrUpdate(
            consumptionData
          );
          resolve({
            code: 200,
            message: "EB Consumption records updated successfully",
            data: result.records,
          });
          return;
        }

        // Legacy single record format
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

  getByDateAndBranch(date, branchId) {
    return new Promise(async (resolve, reject) => {
      try {
        const records = await this.ebConsumptionRepo.getByDateAndBranch(
          date,
          branchId
        );
        resolve({
          code: 200,
          message: "EB Consumption records retrieved successfully",
          data: records,
        });
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
