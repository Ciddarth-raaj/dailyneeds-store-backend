class SubCategoryUsecase {
	constructor(subCategoryRepo) {
		this.subCategoryRepo = subCategoryRepo;
	}

	getAll(limit, offset) {
		return new Promise(async (resolve, reject) => {
			try {
				const subCategories = await this.subCategoryRepo.getAll(limit, offset);
				resolve(subCategories);
			} catch (err) {
				reject(err);
			}
		});
	}
	getSubCategoryCount() {
		return new Promise(async (resolve, reject) => {
		  try {
			const data = await this.subCategoryRepo.getSubCategoryCount();
			resolve(data);
		  } catch (err) {
			reject(err);
		  }
		}); 
	  }
	upsert(subCategory) {
		return new Promise(async (resolve, reject) => {
			try {
				await this.subCategoryRepo.upsert(subCategory);
				resolve();
			} catch (err) {
				reject(err);
			}
		});
	}

	update(subcategory) {
		return new Promise(async (resolve, reject) => {
			try {
				await this.subCategoryRepo.update(subcategory);
				resolve();
			} catch (err) {
				reject(err);
			}
		});
	}
}

module.exports = (subCategoryRepo) => {
	return new SubCategoryUsecase(subCategoryRepo);
};
