const router = require("express").Router();
const Joi = require("@hapi/joi");

class BrandRoutes {
	constructor(brandUsecase) {
		this.brandUsecase = brandUsecase;
		this.init();
	}

	init() {
		router.get("/", async (req, res) => {
			try {
				const brands = await this.brandUsecase.getAll();
				res.json(brands);
			} catch (err) {
				res.status(500).json({ code: 500, msg: "An error occurred !" });
			}
		});

		router.get("/category", async (req, res) => {
			try {
				const brands = await this.brandUsecase.getByCategory(
					req.query.category_id
				);
				res.json(brands);
			} catch (err) {
				res.status(500).json({ code: 500, msg: "An error occurred !" });
			}
		});

		router.get("/subcategory", async (req, res) => {
			try {
				const brands = await this.brandUsecase.getBySubCategory(
					req.query.subcategory_id
				);
				res.json(brands);
			} catch (err) {
				res.status(500).json({ code: 500, msg: "An error occurred !" });
			}
		});

		router.get("/department", async (req, res) => {
			try {
				const brands = await this.brandUsecase.getByDepartment(
					req.query.department_id
				);
				res.json(brands);
			} catch (err) {
				res.status(500).json({ code: 500, msg: "An error occurred !" });
			}
		});

		router.get("/search", async (req, res) => {
			try {
				const brands = await this.brandUsecase.getBySearch(
					req.query.search
				);
				res.json(brands);
			} catch (err) {
				res.status(500).json({ code: 500, msg: "An error occurred !" });
			}
		});
	}

	getRouter() {
		return router;
	}
}

module.exports = (brandUsecase) => {
	return new BrandRoutes(brandUsecase);
};
