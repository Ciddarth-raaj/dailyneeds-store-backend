const ticketsUtil = require("../utils/tickets");
const { TEST_TELEGRAM_CHAT_ID } = require("../constants/telegram");
const telegram = require("../services/telegram")();

class TicketUsecase {
  constructor(
    ticketRepo,
    employeeUsecase,
    outletUsecase,
    telegramDepartmentsUsecase
  ) {
    this.ticketRepo = ticketRepo;
    this.employeeUsecase = employeeUsecase;
    this.outletUsecase = outletUsecase;
    this.telegramDepartmentsUsecase = telegramDepartmentsUsecase;
  }

  create(ticket) {
    return new Promise(async (resolve, reject) => {
      try {
        // Extract images from ticket data
        const images = ticket.images || [];
        delete ticket.images;

        // Create the ticket
        const result = await this.ticketRepo.create(ticket);

        // Create images if provided
        if (images.length > 0 && result.id) {
          try {
            await Promise.all(
              images.map((s3Url) =>
                this.ticketRepo.createImage(result.id, s3Url)
              )
            );
          } catch (imageErr) {
            // Log error but don't fail the ticket creation
            console.error("Error creating ticket images:", imageErr);
          }
        }

        // Get the created ticket with images
        const createdTicket = await this.ticketRepo.getById(result.id);
        if (createdTicket) {
          const ticketImages = await this.ticketRepo.getImagesByTicketId(
            result.id
          );

          createdTicket.images = ticketImages;
          await this.handleTelegramMessage(
            createdTicket,
            "New Ticket Created!"
          );

          if (createdTicket.assigned_to) {
            await this.handleAssigned(createdTicket);
          }

          resolve(createdTicket);
        } else {
          resolve(result);
        }
      } catch (err) {
        reject(err);
      }
    });
  }

  getAll(filters, limit, offset) {
    return new Promise(async (resolve, reject) => {
      try {
        const tickets = await this.ticketRepo.getAll(filters, limit, offset);

        // Get images for each ticket
        const ticketsWithImages = await Promise.all(
          tickets.map(async (ticket) => {
            try {
              const images = await this.ticketRepo.getImagesByTicketId(
                ticket.id
              );
              return { ...ticket, images };
            } catch (err) {
              return { ...ticket, images: [] };
            }
          })
        );

        resolve(ticketsWithImages);
      } catch (err) {
        reject(err);
      }
    });
  }

  getById(id) {
    return new Promise(async (resolve, reject) => {
      try {
        const ticket = await this.ticketRepo.getById(id);
        if (!ticket) {
          resolve(null);
          return;
        }

        // Get images for the ticket
        try {
          const images = await this.ticketRepo.getImagesByTicketId(id);
          resolve({ ...ticket, images });
        } catch (err) {
          resolve({ ...ticket, images: [] });
        }
      } catch (err) {
        reject(err);
      }
    });
  }

  update(id, ticket) {
    return new Promise(async (resolve, reject) => {
      try {
        // Extract image operations from ticket data
        const imagesToDelete = ticket.images_to_delete || [];
        const imagesToAdd = ticket.images_to_add || [];
        delete ticket.images_to_delete;
        delete ticket.images_to_add;

        // Update ticket fields if any
        const hasTicketUpdates = Object.keys(ticket).length > 0;
        if (hasTicketUpdates) {
          await this.ticketRepo.update(id, ticket);
        }

        // Delete images if provided
        if (imagesToDelete.length > 0) {
          try {
            await Promise.all(
              imagesToDelete.map((imageId) =>
                this.ticketRepo.deleteImage(imageId)
              )
            );
          } catch (imageErr) {
            console.error("Error deleting ticket images:", imageErr);
            // Continue even if image deletion fails
          }
        }

        // Add images if provided
        if (imagesToAdd.length > 0) {
          try {
            await Promise.all(
              imagesToAdd.map((s3Url) => this.ticketRepo.createImage(id, s3Url))
            );
          } catch (imageErr) {
            console.error("Error adding ticket images:", imageErr);
            // Continue even if image addition fails
          }
        }

        // Get updated ticket with images
        const updatedTicket = await this.ticketRepo.getById(id);
        if (updatedTicket) {
          const ticketImages = await this.ticketRepo.getImagesByTicketId(id);
          updatedTicket.images = ticketImages;

          if (Object.keys(ticket).length === 1 && ticket.status) {
            await this.handleStatusUpdate(updatedTicket);
          } else if (Object.keys(ticket).length === 1 && ticket.assigned_to) {
            await this.handleAssigned(updatedTicket);
          } else {
            await this.handleTelegramMessage(
              updatedTicket,
              "Ticket Updated!",
              false
            );
          }

          resolve(updatedTicket);
        } else {
          resolve({ code: 200 });
        }
      } catch (err) {
        reject(err);
      }
    });
  }

  async handleTelegramMessage(ticket, title = "", includeImages = true) {
    try {
      const message = await ticketsUtil.formatTicketMessage(
        this.employeeUsecase,
        ticket,
        includeImages
      );

      let outletChatId = null;
      let departmentChatId = null;

      if (ticket.outlet_id) {
        const outlet = await this.outletUsecase.getOutletById(ticket.outlet_id);
        if (outlet.length > 0) {
          outletChatId = outlet[0].telegram_chat_id;
        }
      }

      if (ticket.department_id) {
        const department = await this.telegramDepartmentsUsecase.getById(
          ticket.department_id
        );
        if (department.id) {
          departmentChatId = department.telegram_chat_id;
        }
      }

      if (includeImages && ticket.images.length > 0) {
        if (outletChatId) {
          await telegram.sendImages(
            outletChatId,
            ticket.images.map((item) => ({ type: "photo", media: item.s3_url }))
          );
        }
        if (departmentChatId) {
          await telegram.sendImages(
            departmentChatId,
            ticket.images.map((item) => ({ type: "photo", media: item.s3_url }))
          );
        }
      }

      const options = {
        reply_markup: {
          inline_keyboard: [],
        },
      };

      if (!ticket.assigned_to) {
        options.reply_markup.inline_keyboard.push([
          {
            text: "📌 Assign Ticket",
            switch_inline_query_current_chat: `/assign ${ticket.id} @`,
          },
        ]);
      }

      if (!ticket.outlet_id) {
        options.reply_markup.inline_keyboard.push([
          {
            text: "🏪 Outlet",
            switch_inline_query_current_chat: `/change_outlet ${ticket.id}`,
          },
        ]);
      }

      if (!ticket.department_id) {
        options.reply_markup.inline_keyboard.push([
          {
            text: "🏢 Department",
            switch_inline_query_current_chat: `/assign_department ${ticket.id}`,
          },
        ]);
      }

      if (outletChatId) {
        await telegram.sendMessage(
          outletChatId,
          `✅ ${title}\n\n${message}`,
          options
        );
      }

      if (departmentChatId) {
        await telegram.sendMessage(
          departmentChatId,
          `✅ ${title}\n\n${message}`,
          options
        );
      }
    } catch (err) {
      throw err;
    }
  }

  async handleStatusUpdate(ticket) {
    try {
      const message = await ticketsUtil.formatStatusUpdateMessage(ticket);

      let outletChatId = null;
      let departmentChatId = null;

      if (ticket.outlet_id) {
        const outlet = await this.outletUsecase.getOutletById(ticket.outlet_id);
        if (outlet.length > 0) {
          outletChatId = outlet[0].telegram_chat_id;
        }
      }

      if (ticket.department_id) {
        const department = await this.telegramDepartmentsUsecase.getById(
          ticket.department_id
        );
        if (department.id) {
          departmentChatId = department.telegram_chat_id;
        }
      }

      if (outletChatId) {
        await telegram.sendMessage(outletChatId, message);
      }
      if (departmentChatId) {
        await telegram.sendMessage(departmentChatId, message);
      }
    } catch (err) {
      throw err;
    }
  }

  async handleAssigned(ticket) {
    try {
      const message = `Ticket #${ticket.id} has been assigned to @${
        ticket.assigned_to_telegram_username ?? ticket.assigned_to_name
      }`;

      let outletChatId = null;
      let departmentChatId = null;

      if (ticket.outlet_id) {
        const outlet = await this.outletUsecase.getOutletById(ticket.outlet_id);
        if (outlet.length > 0) {
          outletChatId = outlet[0].telegram_chat_id;
        }
      }

      if (ticket.department_id) {
        const department = await this.telegramDepartmentsUsecase.getById(
          ticket.department_id
        );
        if (department.id) {
          departmentChatId = department.telegram_chat_id;
        }
      }

      if (outletChatId) {
        await telegram.sendMessage(outletChatId, message);
      }
      if (departmentChatId) {
        await telegram.sendMessage(departmentChatId, message);
      }
    } catch (err) {
      throw err;
    }
  }

  delete(id) {
    return new Promise(async (resolve, reject) => {
      try {
        const result = await this.ticketRepo.delete(id);
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
  }

  getCount(filters) {
    return new Promise(async (resolve, reject) => {
      try {
        const count = await this.ticketRepo.getCount(filters);
        resolve(count);
      } catch (err) {
        reject(err);
      }
    });
  }

  // Ticket Images methods
  createImage(ticketId, s3Url) {
    return new Promise(async (resolve, reject) => {
      try {
        const result = await this.ticketRepo.createImage(ticketId, s3Url);
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
  }

  getImagesByTicketId(ticketId) {
    return new Promise(async (resolve, reject) => {
      try {
        const images = await this.ticketRepo.getImagesByTicketId(ticketId);
        resolve(images);
      } catch (err) {
        reject(err);
      }
    });
  }

  deleteImage(imageId) {
    return new Promise(async (resolve, reject) => {
      try {
        const result = await this.ticketRepo.deleteImage(imageId);
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
  }
}

module.exports = (
  ticketRepo,
  employeeUsecase,
  outletUsecase,
  telegramDepartmentsUsecase
) => {
  return new TicketUsecase(
    ticketRepo,
    employeeUsecase,
    outletUsecase,
    telegramDepartmentsUsecase
  );
};
