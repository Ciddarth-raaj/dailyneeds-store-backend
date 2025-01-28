class DigitalPaymentsUsecase {
  constructor(digitalPaymentsRepo) {
    this.digitalPaymentsRepo = digitalPaymentsRepo;
  }

  async create(payment) {
    try {
      const result = await this.digitalPaymentsRepo.create(payment);
      return result;
    } catch (error) {
      throw error;
    }
  }

  async getAll(filters) {
    try {
      const result = await this.digitalPaymentsRepo.getAll(filters);
      return result;
    } catch (error) {
      throw error;
    }
  }

  async getById(paymentId) {
    try {
      const result = await this.digitalPaymentsRepo.getById(paymentId);
      return result;
    } catch (error) {
      throw error;
    }
  }

  async update(payment) {
    try {
      const result = await this.digitalPaymentsRepo.update(payment);
      return result;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = (digitalPaymentsRepo) => {
  return new DigitalPaymentsUsecase(digitalPaymentsRepo);
};
