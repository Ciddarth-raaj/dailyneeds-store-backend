class ImageUsecase {
    constructor(imageRepo) {
        this.imageRepo = imageRepo;
    }

    getImageById(product_id) {
        return new Promise(async (resolve, reject) => {
          try {
            const data = await this.imageRepo.getImageById(product_id);
            resolve(data);
          } catch (err) {
            console.log(err);
            reject(err);
          }
        });
      }
}

module.exports = (imageRepo) => {
    return new ImageUsecase(imageRepo);
};
