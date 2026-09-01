const ticketsUtil = require("../utils/tickets");
const telegram = require("../services/telegram")();

/** Fields whose changes are worth recording on the activity log. */
const TRACKED_FIELDS = [
  "title",
  "description",
  "status",
  "priority",
  "due_date",
  "outlet_id",
  "assigned_to",
  "department_id",
  "item_type",
];

const toDateString = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (isNaN(date.getTime())) return null;
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
};

const addDays = (date, days) => {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next;
};

/** Compares two values loosely, so 5 and "5" and Date/"2026-09-01" don't look like edits. */
const isSameValue = (a, b) => {
  if (a === b) return true;
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  if (a instanceof Date || b instanceof Date) {
    return toDateString(a) === toDateString(b);
  }
  return String(a) === String(b);
};

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

  // ------------------------------------------------------------------ read

  async getAll(filters, limit, offset, sortBy, sortDir) {
    const items = await this.ticketRepo.getAll(
      filters,
      limit,
      offset,
      sortBy,
      sortDir
    );

    if (items.length === 0) return items;

    // One query for the whole page rather than one per row.
    const images = await this.ticketRepo.getImagesByTicketIds(
      items.map((item) => item.id)
    );

    const imagesByTicket = new Map();
    images.forEach((image) => {
      const bucket = imagesByTicket.get(image.ticket_id) || [];
      bucket.push(image);
      imagesByTicket.set(image.ticket_id, bucket);
    });

    return items.map((item) => ({
      ...item,
      images: imagesByTicket.get(item.id) || [],
    }));
  }

  getCount(filters) {
    return this.ticketRepo.getCount(filters);
  }

  getSummary(filters) {
    return this.ticketRepo.getSummary(filters);
  }

  async getById(id) {
    const ticket = await this.ticketRepo.getById(id);
    if (!ticket) return null;

    const [images, checklist, comments, activity] = await Promise.all([
      this.ticketRepo.getImagesByTicketId(id).catch(() => []),
      this.ticketRepo.getChecklistByTicketId(id).catch(() => []),
      this.ticketRepo.getCommentsByTicketId(id).catch(() => []),
      this.ticketRepo.getActivityByTicketId(id).catch(() => []),
    ]);

    return { ...ticket, images, checklist, comments, activity };
  }

  // ----------------------------------------------------------------- write

  async create(item) {
    const images = item.images || [];
    const checklist = item.checklist || [];
    const recurrence = item.recurrence || null;
    delete item.images;
    delete item.checklist;
    delete item.recurrence;

    // A recurring task's blueprint is stored as a hidden template row; the
    // scheduler clones it. Nothing else should ever see it in a list.
    if (recurrence) {
      item.is_template = 1;
    }

    const result = await this.ticketRepo.create(item);

    if (images.length > 0 && result.id) {
      try {
        await Promise.all(
          images.map((s3Url) => this.ticketRepo.createImage(result.id, s3Url))
        );
      } catch (imageErr) {
        console.error("Error creating ticket images:", imageErr);
      }
    }

    if (checklist.length > 0 && result.id) {
      try {
        await Promise.all(
          checklist.map((title, index) =>
            this.ticketRepo.createChecklistItem(result.id, title, index)
          )
        );
      } catch (checklistErr) {
        console.error("Error creating checklist items:", checklistErr);
      }
    }

    if (recurrence && result.id) {
      await this.ticketRepo.createRecurrence({
        ...recurrence,
        template_ticket_id: result.id,
        created_by: item.created_by,
        next_run_on:
          recurrence.next_run_on || toDateString(new Date()),
      });

      // A template is never announced — its generated instances are.
      return this.getById(result.id);
    }

    const created = await this.getById(result.id);
    if (!created) return result;

    const type = ticketsUtil.itemLabel(created.item_type);
    await this.notify(created, `New ${type.label} Created!`);

    if (created.assigned_to) {
      await this.notifyAssigned(created);
    }

    return created;
  }

  /**
   * Applies changes, records what actually changed, and sends the one
   * notification that matches the edit — rather than inferring intent from
   * how many keys the caller happened to send.
   */
  async update(id, changes, actorEmployeeId = null) {
    const imagesToDelete = changes.images_to_delete || [];
    const imagesToAdd = changes.images_to_add || [];
    delete changes.images_to_delete;
    delete changes.images_to_add;

    const before = await this.ticketRepo.getById(id);
    if (!before) return { code: 404, msg: "Ticket not found" };

    const changedFields = TRACKED_FIELDS.filter(
      (field) =>
        changes[field] !== undefined &&
        !isSameValue(before[field], changes[field])
    );

    if (Object.keys(changes).length > 0) {
      await this.ticketRepo.update(id, changes);
    }

    if (imagesToDelete.length > 0) {
      try {
        await Promise.all(
          imagesToDelete.map((imageId) => this.ticketRepo.deleteImage(imageId))
        );
      } catch (imageErr) {
        console.error("Error deleting ticket images:", imageErr);
      }
    }

    if (imagesToAdd.length > 0) {
      try {
        await Promise.all(
          imagesToAdd.map((s3Url) => this.ticketRepo.createImage(id, s3Url))
        );
      } catch (imageErr) {
        console.error("Error adding ticket images:", imageErr);
      }
    }

    await Promise.all(
      changedFields.map((field) =>
        this.ticketRepo
          .createActivity(
            id,
            actorEmployeeId,
            field,
            before[field],
            changes[field]
          )
          .catch((err) => console.error("Error logging activity:", err))
      )
    );

    const updated = await this.getById(id);
    if (!updated) return { code: 200 };

    // Templates are silent; their instances do the talking.
    if (updated.is_template) return updated;

    const onlyChanged = (field) =>
      changedFields.length === 1 && changedFields[0] === field;

    if (changedFields.length === 0 && imagesToAdd.length === 0) {
      // Nothing actually moved — don't spam the group.
      return updated;
    }

    if (onlyChanged("status")) {
      await this.notifyStatus(updated);
    } else if (onlyChanged("assigned_to")) {
      await this.notifyAssigned(updated);
    } else {
      const type = ticketsUtil.itemLabel(updated.item_type);
      await this.notify(updated, `${type.label} Updated!`, false);
      if (changedFields.includes("assigned_to")) {
        await this.notifyAssigned(updated);
      }
    }

    return updated;
  }

  delete(id) {
    return this.ticketRepo.delete(id);
  }

  // ------------------------------------------------------------- checklist

  getChecklist(ticketId) {
    return this.ticketRepo.getChecklistByTicketId(ticketId);
  }

  getChecklistItemById(checklistItemId) {
    return this.ticketRepo.getChecklistItemById(checklistItemId);
  }

  async addChecklistItem(ticketId, title) {
    const existing = await this.ticketRepo.getChecklistByTicketId(ticketId);
    await this.ticketRepo.createChecklistItem(ticketId, title, existing.length);
    return this.ticketRepo.getChecklistByTicketId(ticketId);
  }

  async updateChecklistItem(checklistItemId, changes, actorEmployeeId) {
    const item = await this.ticketRepo.getChecklistItemById(checklistItemId);
    if (!item) return { code: 404, msg: "Checklist item not found" };

    await this.ticketRepo.updateChecklistItem(
      checklistItemId,
      changes,
      actorEmployeeId
    );

    return this.ticketRepo.getChecklistByTicketId(item.ticket_id);
  }

  async deleteChecklistItem(checklistItemId) {
    const item = await this.ticketRepo.getChecklistItemById(checklistItemId);
    if (!item) return { code: 404, msg: "Checklist item not found" };

    await this.ticketRepo.deleteChecklistItem(checklistItemId);
    return this.ticketRepo.getChecklistByTicketId(item.ticket_id);
  }

  // -------------------------------------------------------------- comments

  getComments(ticketId) {
    return this.ticketRepo.getCommentsByTicketId(ticketId);
  }

  getCommentById(commentId) {
    return this.ticketRepo.getCommentById(commentId);
  }

  async addComment(ticketId, employeeId, comment) {
    const ticket = await this.ticketRepo.getById(ticketId);
    if (!ticket) return { code: 404, msg: "Ticket not found" };

    await this.ticketRepo.createComment(ticketId, employeeId, comment);

    let authorName = "Someone";
    if (employeeId) {
      try {
        const rows = await this.employeeUsecase.getEmployeeById(employeeId);
        if (rows && rows.length > 0) {
          authorName = rows[0].employee_name || authorName;
        }
      } catch (err) {
        console.error("Error resolving comment author:", err);
      }
    }

    await this.sendToChats(
      ticket,
      ticketsUtil.formatCommentMessage(ticket, authorName, comment)
    );

    return this.ticketRepo.getCommentsByTicketId(ticketId);
  }

  async deleteComment(commentId) {
    const comment = await this.ticketRepo.getCommentById(commentId);
    if (!comment) return { code: 404, msg: "Comment not found" };

    await this.ticketRepo.deleteComment(commentId);
    return this.ticketRepo.getCommentsByTicketId(comment.ticket_id);
  }

  getActivity(ticketId) {
    return this.ticketRepo.getActivityByTicketId(ticketId);
  }

  // ------------------------------------------------------------ recurrence

  getRecurrences() {
    return this.ticketRepo.getAllRecurrences();
  }

  getRecurrenceById(recurrenceId) {
    return this.ticketRepo.getRecurrenceById(recurrenceId);
  }

  updateRecurrence(recurrenceId, changes) {
    return this.ticketRepo.updateRecurrence(recurrenceId, changes);
  }

  async deleteRecurrence(recurrenceId) {
    const recurrence = await this.ticketRepo.getRecurrenceById(recurrenceId);
    if (!recurrence) return { code: 404, msg: "Recurrence not found" };

    // Removing the template cascades the recurrence row away with it.
    await this.ticketRepo.delete(recurrence.template_ticket_id);
    return { code: 200 };
  }

  /**
   * The next date a recurrence should fire, strictly after `from`.
   * Missed days are skipped rather than backfilled — nobody wants sixty
   * copies of a daily task after the server was down for two months.
   */
  computeNextRun(recurrence, from = new Date()) {
    const interval = Math.max(1, parseInt(recurrence.interval_value, 10) || 1);
    let next = addDays(from, 1);

    if (recurrence.frequency === "daily") {
      next = addDays(from, interval);
    }

    if (recurrence.frequency === "weekly") {
      const target =
        recurrence.day_of_week === null || recurrence.day_of_week === undefined
          ? from.getDay()
          : Number(recurrence.day_of_week);
      next = addDays(from, 1);
      while (next.getDay() !== target) {
        next = addDays(next, 1);
      }
      // Honour an every-N-weeks interval beyond the first hop.
      if (interval > 1) {
        next = addDays(next, (interval - 1) * 7);
      }
    }

    if (recurrence.frequency === "monthly") {
      const target =
        recurrence.day_of_month === null ||
        recurrence.day_of_month === undefined
          ? from.getDate()
          : Number(recurrence.day_of_month);
      next = new Date(from.getFullYear(), from.getMonth() + interval, 1);
      // Clamp to the last day for months that are too short (e.g. the 31st).
      const lastDay = new Date(
        next.getFullYear(),
        next.getMonth() + 1,
        0
      ).getDate();
      next.setDate(Math.min(target, lastDay));
    }

    // Never hand back a date in the past.
    while (next <= from) {
      next = addDays(next, 1);
    }

    return next;
  }

  /** Clones every due recurrence template into a live task. */
  async runRecurringTaskGeneration() {
    const due = await this.ticketRepo.getDueRecurrences();
    const created = [];

    for (const recurrence of due) {
      try {
        const template = await this.ticketRepo.getById(
          recurrence.template_ticket_id
        );
        if (!template) continue;

        const dueDate = addDays(
          new Date(),
          parseInt(recurrence.due_in_days, 10) || 0
        );

        const result = await this.ticketRepo.create({
          title: template.title,
          item_type: "task",
          is_template: 0,
          description: template.description,
          status: "open",
          priority: template.priority,
          due_date: toDateString(dueDate),
          outlet_id: template.outlet_id,
          created_by: template.created_by,
          assigned_to: template.assigned_to,
          department_id: template.department_id,
        });

        // Carry the blueprint's checklist onto each generated task.
        const checklist = await this.ticketRepo.getChecklistByTicketId(
          template.id
        );
        await Promise.all(
          checklist.map((item, index) =>
            this.ticketRepo.createChecklistItem(result.id, item.title, index)
          )
        );

        await this.ticketRepo.updateRecurrence(recurrence.recurrence_id, {
          last_created_on: toDateString(new Date()),
          next_run_on: toDateString(this.computeNextRun(recurrence)),
        });

        const task = await this.getById(result.id);
        if (task) {
          await this.notify(task, "Recurring Task Due!");
          if (task.assigned_to) {
            await this.notifyAssigned(task);
          }
          created.push(task.id);
        }
      } catch (err) {
        console.error(
          `Error generating recurring task for recurrence ${recurrence.recurrence_id}:`,
          err
        );
      }
    }

    return { code: 200, created: created.length, ids: created };
  }

  /** Posts one digest per chat listing everything past its due date. */
  async runOverdueReminders() {
    const overdue = await this.ticketRepo.getOverdueForReminder();
    if (overdue.length === 0) return { code: 200, notified: 0 };

    // Group by destination chat so a busy outlet gets one message, not thirty.
    const byOutlet = new Map();
    const byDepartment = new Map();

    overdue.forEach((item) => {
      if (item.outlet_id) {
        const bucket = byOutlet.get(item.outlet_id) || [];
        bucket.push(item);
        byOutlet.set(item.outlet_id, bucket);
      }
      if (item.department_id) {
        const bucket = byDepartment.get(item.department_id) || [];
        bucket.push(item);
        byDepartment.set(item.department_id, bucket);
      }
    });

    let notified = 0;

    for (const [outletId, items] of byOutlet) {
      const chatId = await this.getOutletChatId(outletId);
      if (!chatId) continue;
      await this.send(chatId, ticketsUtil.formatOverdueDigest(items));
      notified += 1;
    }

    for (const [departmentId, items] of byDepartment) {
      const chatId = await this.getDepartmentChatId(departmentId);
      if (!chatId) continue;
      await this.send(chatId, ticketsUtil.formatOverdueDigest(items));
      notified += 1;
    }

    return { code: 200, notified, overdue: overdue.length };
  }

  // ---------------------------------------------------------- notification

  async getOutletChatId(outletId) {
    if (!outletId) return null;
    try {
      const outlet = await this.outletUsecase.getOutletById(outletId);
      return outlet.length > 0 ? outlet[0].telegram_chat_id : null;
    } catch (err) {
      console.error("Error resolving outlet chat:", err);
      return null;
    }
  }

  async getDepartmentChatId(departmentId) {
    if (!departmentId) return null;
    try {
      const department = await this.telegramDepartmentsUsecase.getById(
        departmentId
      );
      return department && department.id ? department.telegram_chat_id : null;
    } catch (err) {
      console.error("Error resolving department chat:", err);
      return null;
    }
  }

  /** A Telegram failure must never fail the write that triggered it. */
  async send(chatId, message, options = {}) {
    if (!chatId) return;
    try {
      await telegram.sendMessage(chatId, message, options);
    } catch (err) {
      console.error("Error sending telegram message:", err);
    }
  }

  async sendToChats(ticket, message, options = {}) {
    const [outletChatId, departmentChatId] = await Promise.all([
      this.getOutletChatId(ticket.outlet_id),
      this.getDepartmentChatId(ticket.department_id),
    ]);

    await this.send(outletChatId, message, options);
    await this.send(departmentChatId, message, options);
  }

  async notify(ticket, title = "", includeImages = true) {
    try {
      const message = await ticketsUtil.formatTicketMessage(
        this.employeeUsecase,
        ticket,
        includeImages
      );

      const [outletChatId, departmentChatId] = await Promise.all([
        this.getOutletChatId(ticket.outlet_id),
        this.getDepartmentChatId(ticket.department_id),
      ]);

      if (includeImages && ticket.images && ticket.images.length > 0) {
        const media = ticket.images.map((item) => ({
          type: "photo",
          media: item.s3_url,
        }));
        for (const chatId of [outletChatId, departmentChatId]) {
          if (!chatId) continue;
          try {
            await telegram.sendImages(chatId, media);
          } catch (err) {
            console.error("Error sending telegram images:", err);
          }
        }
      }

      const options = { reply_markup: { inline_keyboard: [] } };

      if (!ticket.assigned_to) {
        options.reply_markup.inline_keyboard.push([
          {
            text: "📌 Assign",
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

      const body = `✅ ${title}\n\n${message}`;
      await this.send(outletChatId, body, options);
      await this.send(departmentChatId, body, options);
    } catch (err) {
      console.error("Error building ticket notification:", err);
    }
  }

  async notifyStatus(ticket) {
    await this.sendToChats(
      ticket,
      ticketsUtil.formatStatusUpdateMessage(ticket)
    );
  }

  async notifyAssigned(ticket) {
    const label = ticket.assigned_to_telegram_username
      ? "@" + ticket.assigned_to_telegram_username
      : ticket.assigned_to_name || `ID: ${ticket.assigned_to}`;

    await this.sendToChats(
      ticket,
      ticketsUtil.formatAssignedMessage(ticket, label)
    );
  }

  // ------------------------------------------------------- image passthrough

  createImage(ticketId, s3Url) {
    return this.ticketRepo.createImage(ticketId, s3Url);
  }

  getImagesByTicketId(ticketId) {
    return this.ticketRepo.getImagesByTicketId(ticketId);
  }

  deleteImage(imageId) {
    return this.ticketRepo.deleteImage(imageId);
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
