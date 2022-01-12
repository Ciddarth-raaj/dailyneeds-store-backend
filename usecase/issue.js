class IssueUsecase {
    constructor(issueRepo, indentRepo) {
      this.issueRepo = issueRepo;
      this.indentRepo = indentRepo;
    }
  
    get() {
      return new Promise(async (resolve, reject) => {
        try {
          const data = await this.issueRepo.get();
          resolve(data);
        } catch (err) {
          reject(err);
        }
      });
    }
    updateStatus(file) {
      return new Promise(async (resolve, reject) => {
        try {
          await this.issueRepo.updateStatus(file);
          resolve(200);
        } catch (err) {
          reject(err);
        }
      });
    }
    getIssueByStoreId(store_id) {
        return new Promise(async (resolve, reject) => {
          try {
            const data = await this.issueRepo.getIssueByStoreId(store_id);
            resolve(data);
          } catch (err) {
            console.log(err);
            reject(err);
          }
        });
      }
      getIssueFromStoreId(store_id) {
        return new Promise(async (resolve, reject) => {
          try {
            const data = await this.issueRepo.getIssueFromStoreId(store_id);
            resolve(data);
          } catch (err) {
            console.log(err);
            reject(err);
          }
        });
      }
  getIssueById(issue_id) {
      return new Promise(async (resolve, reject) => {
        try {
          const data = await this.issueRepo.getById(issue_id);
          resolve(data);
        } catch (err) {
          console.log(err);
          reject(err);
        }
      });
    }
    create(issue) {
      return new Promise(async (resolve, reject) => {
        try {
          this.issueRepo.create(issue);
          const code = await this.indentRepo.updateIssueDeliveryStatus(issue.indent_id)
          
          resolve(200);
        } catch (err) {
          reject(err);
        }
      });
    }
  }
  
  module.exports = (issueRepo, indentRepo) => {
    return new IssueUsecase(issueRepo, indentRepo);
  };
  