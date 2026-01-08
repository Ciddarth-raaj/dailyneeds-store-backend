class ProductUsecase {
  constructor(productRepo) {
    this.productRepo = productRepo;
  }
  updateProductDetails(product) {
    return new Promise(async (resolve, reject) => {
      try {
        const product_id = product.product_id;
        const images = product.images || [];

        let code = { code: 200 };

        // Update product details if provided
        if (product.product_details) {
          delete product.product_details.product_id;
          const result = await this.productRepo.updateProductDetails(
            product.product_details,
            product_id
          );
          code = result;
        }

        // Update images if provided
        if (product.hasOwnProperty("images")) {
          // Delete existing images for this product
          await this.productRepo.deleteProductImages(product_id);
          // Insert new images if any
          if (images.length > 0) {
            await this.productRepo.createProductImages(product_id, images);
          }
        }

        resolve(code);
      } catch (err) {
        reject(err);
      }
    });
  }
  getAllProductData() {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.productRepo.getAllProductData();
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }
  getProductById(product_id) {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.productRepo.getProductById(product_id);
        if (data && data.length > 0) {
          const product = data[0];
          const images = await this.productRepo.getProductImages(product_id);
          product.images = images || [];
        }
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }

  getProductByFilter(filter, limit, offset) {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.productRepo.getProductByFilter(
          filter,
          limit,
          offset
        );
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }

  getProductCount() {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.productRepo.getProductCount();
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }

  get(limit, offset) {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.productRepo.get(limit, offset);
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }

  create(product) {
    return new Promise(async (resolve, reject) => {
      try {
        const images = product.images || [];
        const productData = { ...product };
        delete productData.images;

        const code = await this.productRepo.create(productData);

        // If product was created/updated successfully and we have images
        if ((code.code === 200 || code.code === 101) && images.length > 0) {
          // Use product_id from request, or from insertId if new product
          const productId = product.product_id || code.id;
          if (productId) {
            // Delete existing images for this product
            await this.productRepo.deleteProductImages(productId);
            // Insert new images
            await this.productRepo.createProductImages(productId, images);
          }
        }

        resolve(code);
      } catch (err) {
        reject(err);
        console.log(err);
      }
    });
  }
}

module.exports = (productRepo) => {
  return new ProductUsecase(productRepo);
};
