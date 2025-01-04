class PeopleUsecase {
  constructor(peopleRepo) {
    this.peopleRepo = peopleRepo;
  }

  async createPerson(person) {
    try {
      const result = await this.peopleRepo.create(person);
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
}

module.exports = (peopleRepo) => {
  return new PeopleUsecase(peopleRepo);
};
