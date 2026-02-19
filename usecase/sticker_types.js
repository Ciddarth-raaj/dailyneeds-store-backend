class StickerTypesUsecase {
  constructor(stickerTypesRepo) {
    this.stickerTypesRepo = stickerTypesRepo;
  }

  async create(data) {
    return this.stickerTypesRepo.create(data);
  }

  async getById(stickerId) {
    return this.stickerTypesRepo.getById(stickerId);
  }

  async getAll(filters) {
    return this.stickerTypesRepo.getAll(filters);
  }

  async update(stickerId, data) {
    return this.stickerTypesRepo.update(stickerId, data);
  }

  async delete(stickerId) {
    return this.stickerTypesRepo.delete(stickerId);
  }
}

module.exports = (stickerTypesRepo) => {
  return new StickerTypesUsecase(stickerTypesRepo);
};
