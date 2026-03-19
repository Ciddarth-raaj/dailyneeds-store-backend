const AssetUsecase = require("./asset");

class ProductUsecase {
  constructor(productRepo, productImageLogUsecase) {
    this.productRepo = productRepo;
    this.productImageLogUsecase = productImageLogUsecase;
  }
  updateProductDetails(product, createdBy) {
    return new Promise(async (resolve, reject) => {
      try {
        const product_id = product.product_id;

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

        // Update images only when an images array was explicitly sent (not when key is missing/undefined)
        if (Array.isArray(product.images)) {
          const images = product.images;
          const existingImages =
            (await this.productRepo.getProductImages(product_id)) || [];

          const existingNormalized = existingImages
            .map((img) => ({ url: img.image_url, priority: img.priority || 0 }))
            .sort((a, b) => a.priority - b.priority || (a.url || "").localeCompare(b.url || ""));
          const newNormalized = images
            .filter((img) => img && img.image_url)
            .map((img) => ({ url: img.image_url, priority: img.priority || 0 }))
            .sort((a, b) => a.priority - b.priority || (a.url || "").localeCompare(b.url || ""));
          const same =
            existingNormalized.length === newNormalized.length &&
            existingNormalized.every(
              (e, i) =>
                e.url === newNormalized[i].url && e.priority === newNormalized[i].priority
            );

          if (!same) {
            const newImageUrls = new Set(
              images
                .filter((img) => img && img.image_url)
                .map((img) => img.image_url)
            );
            for (const img of existingImages) {
              if (img.image_url && !newImageUrls.has(img.image_url)) {
                try {
                  await AssetUsecase.deleteByUrl(img.image_url);
                } catch (e) {
                  console.error(
                    "Failed to delete image from S3:",
                    img.image_url,
                    e.toString()
                  );
                }
              }
            }
            await this.productRepo.deleteProductImages(product_id);
            if (images.length > 0) {
              await this.productRepo.createProductImages(product_id, images);
            }
            const existingUrls = new Set(
              (existingImages || []).map((i) => i.image_url).filter(Boolean)
            );
            const newUrls = new Set(
              images.filter((i) => i && i.image_url).map((i) => i.image_url)
            );
            const urlsChanged =
              existingUrls.size !== newUrls.size ||
              [...newUrls].some((u) => !existingUrls.has(u));
            if (
              images.length > 0 &&
              urlsChanged &&
              this.productImageLogUsecase
            ) {
              try {
                await this.productImageLogUsecase.logImageUpdate(
                  product_id,
                  images,
                  createdBy
                );
              } catch (e) {
                console.error("Failed to log product image update:", e);
              }
            }
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

  get(limit, offset, fetchAll = false) {
    return new Promise(async (resolve, reject) => {
      try {
        const data = await this.productRepo.get(limit, offset, fetchAll);
        resolve(data);
      } catch (err) {
        reject(err);
      }
    });
  }

  create(product, createdBy) {
    return new Promise(async (resolve, reject) => {
      try {
        const productData = { ...product };
        delete productData.images;

        const code = await this.productRepo.create(productData);

        // Only touch images when an images array was explicitly sent (sync often omits images)
        if ((code.code === 200 || code.code === 101) && Array.isArray(product.images)) {
          const images = product.images;
          const productId = product.product_id || code.id;
          if (productId) {
            const existingImages =
              (await this.productRepo.getProductImages(productId)) || [];
            const existingNormalized = existingImages
              .map((img) => ({ url: img.image_url, priority: img.priority || 0 }))
              .sort((a, b) => a.priority - b.priority || (a.url || "").localeCompare(b.url || ""));
            const newNormalized = images
              .filter((img) => img && img.image_url)
              .map((img) => ({ url: img.image_url, priority: img.priority || 0 }))
              .sort((a, b) => a.priority - b.priority || (a.url || "").localeCompare(b.url || ""));
            const same =
              existingNormalized.length === newNormalized.length &&
              existingNormalized.every(
                (e, i) =>
                  e.url === newNormalized[i].url && e.priority === newNormalized[i].priority
              );

            if (!same) {
              await this.productRepo.deleteProductImages(productId);
              if (images.length > 0) {
                await this.productRepo.createProductImages(productId, images);
              }
              const existingUrls = new Set(
                (existingImages || []).map((i) => i.image_url).filter(Boolean)
              );
              const newUrls = new Set(
                images.filter((i) => i && i.image_url).map((i) => i.image_url)
              );
              const urlsChanged =
                existingUrls.size !== newUrls.size ||
                [...newUrls].some((u) => !existingUrls.has(u));
              if (
                images.length > 0 &&
                urlsChanged &&
                this.productImageLogUsecase
              ) {
                try {
                  await this.productImageLogUsecase.logImageUpdate(
                    productId,
                    images,
                    createdBy
                  );
                } catch (e) {
                  console.error("Failed to log product image create:", e);
                }
              }
            }
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

module.exports = (productRepo, productImageLogUsecase) => {
  return new ProductUsecase(productRepo, productImageLogUsecase);
};
