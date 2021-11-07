class BrandUsecase {
	constructor(brandRepo) {
		this.brandRepo = brandRepo;
	}

	getAll() {
		return new Promise(async (resolve, reject) => {
			try {
				const brands = await this.brandRepo.getAll();
				resolve(brands);
			} catch (err) {
				reject(err);
			}
		});
	}

	getByCategory(categoryId) {
		return new Promise(async (resolve, reject) => {
			try {
				const brands = await this.brandRepo.getByCategory(categoryId);
				resolve(brands);
			} catch (err) {
				reject(err);
			}
		});
	}

	getBySubCategory(categoryId) {
		return new Promise(async (resolve, reject) => {
			try {
				const brands = await this.brandRepo.getBySubCategory(
					categoryId
				);
				resolve(brands);
			} catch (err) {
				reject(err);
			}
		});
	}

	getByDepartment(categoryId) {
		return new Promise(async (resolve, reject) => {
			try {
				const brands = await this.brandRepo.getByDepartment(categoryId);
				resolve(brands);
			} catch (err) {
				reject(err);
			}
		});
	}

	getBySearch(search) {
		return new Promise(async (resolve, reject) => {
			try {
				const brands = await this.brandRepo.getBySearch(search);
				resolve(brands);
			} catch (err) {
				reject(err);
			}
		});
	}

	upsert(brand) {
		return new Promise(async (resolve, reject) => {
			try {
				await this.brandRepo.upsert(brand);
				resolve();
			} catch (err) {
				reject(err);
			}
		});
	}
}

module.exports = (brandRepo) => {
	return new BrandUsecase(brandRepo);
};
