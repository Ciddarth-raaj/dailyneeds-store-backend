const moment = require("moment");

class TallyUsecase {
  constructor(tallyRepo, purchaseUsecase) {
    this.tallyRepo = tallyRepo;
    this.purchaseUsecase = purchaseUsecase;
  }

  async getPurchase(from_date, to_date) {
    try {
      let formatted_from_date = moment(from_date, "MM-DD-YYYY").format(
        "YYYY-MM-DD"
      );
      let formatted_to_date = moment(to_date, "MM-DD-YYYY").format(
        "YYYY-MM-DD"
      );

      const filters = {
        from_date: formatted_from_date,
        to_date: formatted_to_date,
        is_approved: 1,
      };

      const data = await this.purchaseUsecase.getAllPurchases(filters);
      return data;
    } catch (err) {
      throw err;
    }
  }
}

module.exports = (tallyRepo, purchaseUsecase) => {
  return new TallyUsecase(tallyRepo, purchaseUsecase);
};
