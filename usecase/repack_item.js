class RepackItemUsecase {
  constructor(repackItemRepo) {
    this.repackItemRepo = repackItemRepo;
  }

  create(repackItem) {
    return new Promise(async (resolve, reject) => {
      try {
        // Validate required fields
        if (!repackItem.item_id) {
          throw new Error("item_id is required");
        }

        const response = await this.repackItemRepo.create(repackItem);
        resolve(response);
      } catch (err) {
        reject(err);
      }
    });
  }


  getByItemId(item_id) {
    return new Promise(async (resolve, reject) => {
      try {
        if (!item_id) {
          throw new Error("item_id is required");
        }

        const repackItem = await this.repackItemRepo.getByItemId(item_id);
        if (!repackItem) {
          resolve({ code: 404, msg: "Repack item not found" });
        } else {
          resolve({ code: 200, data: repackItem });
        }
      } catch (err) {
        reject(err);
      }
    });
  }

  getAll(limit = 100, offset = 0) {
    return new Promise(async (resolve, reject) => {
      try {
        const repackItems = await this.repackItemRepo.getAll(limit, offset);
        const count = await this.repackItemRepo.getCount();
        
        resolve({
          code: 200,
          data: repackItems,
          pagination: {
            total: count,
            limit: parseInt(limit),
            offset: parseInt(offset),
            hasMore: (parseInt(offset) + parseInt(limit)) < count
          }
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  update(item_id, repackItem) {
    return new Promise(async (resolve, reject) => {
      try {
        if (!item_id) {
          throw new Error("item_id is required");
        }

        const response = await this.repackItemRepo.update(item_id, repackItem);
        resolve(response);
      } catch (err) {
        reject(err);
      }
    });
  }

  delete(item_id) {
    return new Promise(async (resolve, reject) => {
      try {
        if (!item_id) {
          throw new Error("item_id is required");
        }

        const response = await this.repackItemRepo.delete(item_id);
        resolve(response);
      } catch (err) {
        reject(err);
      }
    });
  }

  getCount() {
    return new Promise(async (resolve, reject) => {
      try {
        const count = await this.repackItemRepo.getCount();
        resolve({ code: 200, count });
      } catch (err) {
        reject(err);
      }
    });
  }
}

module.exports = (repackItemRepo) => new RepackItemUsecase(repackItemRepo);
