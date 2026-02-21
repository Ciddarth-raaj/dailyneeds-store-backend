class ProductImageLogUsecase {
  constructor(productImageLogRepo) {
    this.productImageLogRepo = productImageLogRepo;
  }

  async create(data) {
    return this.productImageLogRepo.create(data);
  }

  async getById(logId) {
    return this.productImageLogRepo.getById(logId);
  }

  async getAll(filters) {
    return this.productImageLogRepo.getAll(filters);
  }

  async update(logId, data) {
    return this.productImageLogRepo.update(logId, data);
  }

  async delete(logId) {
    return this.productImageLogRepo.delete(logId);
  }

  async logImageUpdate(productId, imagesArray, createdBy) {
    if (createdBy == null) return;
    return this.productImageLogRepo.create({
      product_id: productId,
      change_json: imagesArray || [],
      created_by: createdBy,
    });
  }
}

module.exports = (productImageLogRepo) => {
  return new ProductImageLogUsecase(productImageLogRepo);
};
