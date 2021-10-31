class ProductUsecase {
    constructor(productRepo) {
      this.productRepo = productRepo;
    }
    updateProductDetails(product) {
      return new Promise(async (resolve, reject) => {
        try {
          const product_id = product.product_id;
          const { code } = await this.productRepo.updateProductDetails(product.product_details, product_id);
          resolve(code); 
        } catch (err) {
          reject(err);
        }
      });
    }
    getProductById(product_id) {
      return new Promise(async(resolve,reject) => {
        try {
        const data = await this.productRepo.getProductById(product_id);
        resolve(data);
        } catch(err) {
          reject(err);
        }
      })
    }

    get() {
      return new Promise(async (resolve, reject) => {
        try {
          const data = await this.productRepo.get();
          resolve(data);
        } catch (err) {
          reject(err);
        }
      });
    }
  
    create(product) {
      return new Promise(async (resolve, reject) => {
        try {
          const code  = await this.productRepo.create(product);
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
  