const logger = require("../utils/logger");

class ExampleUsecase {
  constructor(exampleRepo) {
    this.exampleRepo = exampleRepo;
  }

  login(username, password) {
    return new Promise(async (resolve, reject) => {
      try {
        const resp = await this.exampleRepo.login(username, password);
        resolve(resp);
      } catch (err) {
        reject(err);
      }
    });
  }
}

module.exports = (exampleRepo) => {
  return new ExampleUsecase(exampleRepo);
};
