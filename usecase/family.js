
class FamilyUsecase {
    constructor(familyRepo) {
        this.familyRepo = familyRepo;
    }

    get() {
        return new Promise(async (resolve, reject) => {
            try {
                const data = await this.familyRepo.get();
                resolve(data);
            } catch (err) {
                reject(err);
            }
        });
    }
    getFamilyById(family_id) {
        return new Promise(async (resolve, reject) => {
          try {
            const data = await this.familyRepo.getFamilyById(family_id);
            resolve(data);
          } catch (err) {
            console.log(err);
            reject(err);
          }
        });
      }
      updateFamilyDetails(family) {
        return new Promise(async (resolve, reject) => {
          try {
            const family_id = family.family_id;
            const { code } = await this.familyRepo.updateFamilyDetails(family.family_details, family_id);  
            resolve(code);
          } catch (err) {
            reject(err);
          }
        });
      }
    create(family) {
        return new Promise(async (resolve, reject) => {
            try {
                this.familyRepo.create(family);
                resolve(200);
            } catch (err) {
                reject(err);
            }
        });
    }

}

module.exports = (familyRepo) => {
    return new FamilyUsecase(familyRepo);
};
