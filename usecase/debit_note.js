class DebitNoteUsecase {
  constructor(debitNoteRepo) {
    this.debitNoteRepo = debitNoteRepo;
  }

  async create(data) {
    try {
      const result = await this.debitNoteRepo.create(data);
      return result;
    } catch (error) {
      throw error;
    }
  }

  async getAll(filters) {
    try {
      const result = await this.debitNoteRepo.getAll(filters);
      return result;
    } catch (error) {
      throw error;
    }
  }

  async bulkCreate(dataList) {
    try {
      const result = await this.debitNoteRepo.bulkCreate(dataList);
      return result;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = (debitNoteRepo) => {
  return new DebitNoteUsecase(debitNoteRepo);
};
