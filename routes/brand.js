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
				const schema = {
					limit: Joi.number().required(),
					offset: Joi.number().required(),
				  };
				  const data = req.query;		  
				const brands = await this.brandUsecase.getAll(data.limit, data.offset);
				res.json(brands);
			} catch (err) {
				res.status(500).json({ code: 500, msg: "An error occurred !" });
			}
		});
		router.get("/brandcount", async (req, res) => {
			try {
			  const brands = await this.brandUsecase.getBrandCount();
			  res.json(brands);
			} catch (err) {
				console.log(err);
			  if (err.name === "ValidationError") {
				res.json({ code: 422, msg: err.toString() });
			  } else {
				res.json({ code: 500, msg: "An error occurred !" });
			  }
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
