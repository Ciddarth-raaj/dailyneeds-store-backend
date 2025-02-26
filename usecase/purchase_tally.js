class PurchaseTallyUsecase {
  constructor(purchaseTallyRepo) {
    this.purchaseTallyRepo = purchaseTallyRepo;
  }

  async create(data) {
    try {
      const result = await this.purchaseTallyRepo.create(data);
      return result;
    } catch (error) {
      throw error;
    }
  }

  async getAll() {
    try {
      const result = await this.purchaseTallyRepo.getAll();
      return result;
    } catch (error) {
      throw error;
    }
  }

  async getById(id) {
    try {
      const result = await this.purchaseTallyRepo.getById(id);
      return result;
    } catch (error) {
      throw error;
    }
  }

  async update(id, data) {
    try {
      const result = await this.purchaseTallyRepo.update(id, data);
      return result;
    } catch (error) {
      throw error;
    }
  }

  async delete(id) {
    try {
      const result = await this.purchaseTallyRepo.delete(id);
      return result;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = (purchaseTallyRepo) => {
  return new PurchaseTallyUsecase(purchaseTallyRepo);
};
