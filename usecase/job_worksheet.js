class JobWorksheetUsecase {
  constructor(jobWorksheetRepo) {
    this.jobWorksheetRepo = jobWorksheetRepo;
  }

  async createJobWorksheet(data) {
    return this.jobWorksheetRepo.createJobWorksheet(data);
  }

  async createJobWorksheetWithItems(data) {
    const { items, ...worksheet } = data;
    const result = await this.jobWorksheetRepo.createJobWorksheet(worksheet);
    if (items && items.length > 0) {
      await Promise.all(
        items.map((item) =>
          this.jobWorksheetRepo.createJobWorksheetItem({
            ...item,
            job_worksheet_id: result.id,
          })
        )
      );
    }
    return result;
  }

  async getJobWorksheetById(jobWorksheetId) {
    return this.jobWorksheetRepo.getJobWorksheetById(jobWorksheetId);
  }

  async getJobWorksheetWithItems(jobWorksheetId) {
    return this.jobWorksheetRepo.getJobWorksheetWithItems(jobWorksheetId);
  }

  async getAllJobWorksheets(filters) {
    return this.jobWorksheetRepo.getAllJobWorksheets(filters);
  }

  async updateJobWorksheet(jobWorksheetId, data) {
    return this.jobWorksheetRepo.updateJobWorksheet(jobWorksheetId, data);
  }

  async updateJobWorksheetWithItems(jobWorksheetId, data) {
    const { items, ...worksheet } = data;
    await this.jobWorksheetRepo.updateJobWorksheet(jobWorksheetId, worksheet);
    if (items) {
      const existing = await this.jobWorksheetRepo.getJobWorksheetItems(
        jobWorksheetId
      );
      for (const item of existing) {
        await this.jobWorksheetRepo.deleteJobWorksheetItem(
          item.job_worksheet_item_id
        );
      }
      if (items.length > 0) {
        await Promise.all(
          items.map((item) =>
            this.jobWorksheetRepo.createJobWorksheetItem({
              ...item,
              job_worksheet_id: jobWorksheetId,
            })
          )
        );
      }
    }
    return { code: 200, message: "Job worksheet updated successfully" };
  }

  async deleteJobWorksheet(jobWorksheetId) {
    return this.jobWorksheetRepo.deleteJobWorksheet(jobWorksheetId);
  }

  async getJobWorksheetItems(jobWorksheetId) {
    return this.jobWorksheetRepo.getJobWorksheetItems(jobWorksheetId);
  }

  async createJobWorksheetItem(item) {
    return this.jobWorksheetRepo.createJobWorksheetItem(item);
  }

  async updateJobWorksheetItem(itemId, item) {
    return this.jobWorksheetRepo.updateJobWorksheetItem(itemId, item);
  }

  async deleteJobWorksheetItem(itemId) {
    return this.jobWorksheetRepo.deleteJobWorksheetItem(itemId);
  }
}

module.exports = (jobWorksheetRepo) => {
  return new JobWorksheetUsecase(jobWorksheetRepo);
};
