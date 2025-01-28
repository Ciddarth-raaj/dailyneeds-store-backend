class PeopleUsecase {
  constructor(peopleRepo) {
    this.peopleRepo = peopleRepo;
  }

  async createPerson(person) {
    try {
      const result = await this.peopleRepo.create(person);

      if (result.code === 200) {
        const store_ids = person.store_ids;
        const person_id = result.id;

        store_ids.forEach(async (store_id) => {
          await this.peopleRepo.createOutletMap(store_id, person_id);
        });
      }

      return result;
    } catch (error) {
      throw error;
    }
  }

  async updatePerson(person) {
    try {
      const result = await this.peopleRepo.update(person);
      return result;
    } catch (error) {
      throw error;
    }
  }

  async deletePerson(personId) {
    try {
      const result = await this.peopleRepo.delete(personId);
      return result;
    } catch (error) {
      throw error;
    }
  }

  async getAllPeople() {
    try {
      const people = await this.peopleRepo.getAll();
      return people;
    } catch (error) {
      throw error;
    }
  }

  async getPersonById(personId) {
    try {
      const result = await this.peopleRepo.getById(personId);
      return result;
    } catch (error) {
      throw error;
    }
  }
}

module.exports = (peopleRepo) => {
  return new PeopleUsecase(peopleRepo);
};
