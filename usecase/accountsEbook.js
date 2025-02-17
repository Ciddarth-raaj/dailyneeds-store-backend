class AccountsEbookUsecase {
  constructor(accountsEbookRepo) {
    this.accountsEbookRepo = accountsEbookRepo;
  }

  async createEbook(ebook) {
    try {
      const result = await this.accountsEbookRepo.create(ebook);
      return result;
    } catch (error) {
      throw error;
    }
  }

  async updateEbook(ebook) {
    try {
      const result = await this.accountsEbookRepo.update(ebook);
      return result;
    } catch (error) {
      throw error;
    }
  }

  async deleteEbook(ebookId) {
    try {
      const result = await this.accountsEbookRepo.delete(ebookId);
      return result;
    } catch (error) {
      throw error;
    }
  }

  async getAllEbooks(filters) {
    try {
      const result = await this.accountsEbookRepo.getAll(filters);
      return result;
    } catch (error) {
      throw error;
    }
  }

  async getEbookById(ebookId) {
    try {
      const result = await this.accountsEbookRepo.getById(ebookId);
      return result;
    } catch (error) {
      throw error;
    }
  }

  async bulkCreateEbook(ebookList, store_id, date) {
    try {
      await this.deleteEbooksByDateAndStore(date, store_id);
      const result = await this.accountsEbookRepo.bulkCreate(
        ebookList,
        store_id,
        date
      );
      return result;
    } catch (error) {
      throw error;
    }
  }

  async deleteEbooksByDateAndStore(date, store_id) {
    try {
      const result = await this.accountsEbookRepo.deleteByDateAndStore(
        date,
        store_id
      );
      return result;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = (accountsEbookRepo) => {
  return new AccountsEbookUsecase(accountsEbookRepo);
};
