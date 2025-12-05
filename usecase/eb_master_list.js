class EbMasterListUsecase {
  constructor(ebMasterListRepo) {
    this.ebMasterListRepo = ebMasterListRepo;
  }

  create(machine) {
    return new Promise(async (resolve, reject) => {
      try {
        const result = await this.ebMasterListRepo.create(machine);
        const createdMachine = await this.ebMasterListRepo.getById(result.id);
        resolve(createdMachine);
      } catch (err) {
        reject(err);
      }
    });
  }

  getAll(filters, limit, offset) {
    return new Promise(async (resolve, reject) => {
      try {
        const machines = await this.ebMasterListRepo.getAll(
          filters,
          limit,
          offset
        );
        resolve(machines);
      } catch (err) {
        reject(err);
      }
    });
  }

  getById(id) {
    return new Promise(async (resolve, reject) => {
      try {
        const machine = await this.ebMasterListRepo.getById(id);
        resolve(machine);
      } catch (err) {
        reject(err);
      }
    });
  }

  update(id, machine) {
    return new Promise(async (resolve, reject) => {
      try {
        await this.ebMasterListRepo.update(id, machine);
        const updatedMachine = await this.ebMasterListRepo.getById(id);
        resolve(updatedMachine);
      } catch (err) {
        reject(err);
      }
    });
  }

  delete(id) {
    return new Promise(async (resolve, reject) => {
      try {
        const result = await this.ebMasterListRepo.delete(id);
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
  }

  getCount(filters) {
    return new Promise(async (resolve, reject) => {
      try {
        const count = await this.ebMasterListRepo.getCount(filters);
        resolve(count);
      } catch (err) {
        reject(err);
      }
    });
  }
}

module.exports = (ebMasterListRepo) => {
  return new EbMasterListUsecase(ebMasterListRepo);
};

