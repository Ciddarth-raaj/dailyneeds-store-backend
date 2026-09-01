const ticketsUtil = {};

const priorityEmojis = {
  low: "🟢",
  medium: "🟡",
  high: "🔴",
  urgent: "🚨",
};

/** Keyed by the raw enum value, so no space/underscore juggling is needed. */
const statusEmojis = {
  open: "🟢",
  in_progress: "🟡",
  closed: "🔴",
};

const itemTypeLabels = {
  ticket: { emoji: "🎫", label: "Ticket" },
  task: { emoji: "✅", label: "Task" },
};

const VIDEO_EXTENSIONS = ["mp4", "mov", "m4v", "webm", "avi", "mkv", "3gp"];

/**
 * Attachments are stored as bare S3 urls with no media-type column, so the
 * extension is what tells a clip from a photo.
 */
ticketsUtil.isVideoUrl = (url) => {
  if (!url) return false;
  const path = String(url).split("?")[0].toLowerCase();
  return VIDEO_EXTENSIONS.some((ext) => path.endsWith(`.${ext}`));
};

/** Telegram rejects a media group that labels a video as a photo. */
ticketsUtil.toTelegramMedia = (attachments = []) =>
  attachments.map((item) => ({
    type: ticketsUtil.isVideoUrl(item.s3_url) ? "video" : "photo",
    media: item.s3_url,
  }));

ticketsUtil.escapeMarkdown = (text) => {
  if (!text) return "";
  // Escape special markdown characters for Telegram
  return String(text)
    .replace(/\_/g, "\\_")
    .replace(/\*/g, "\\*")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/\~/g, "\\~")
    .replace(/\`/g, "\\`")
    .replace(/\>/g, "\\>")
    .replace(/\#/g, "\\#")
    .replace(/\+/g, "\\+")
    .replace(/\-/g, "\\-")
    .replace(/\=/g, "\\=")
    .replace(/\|/g, "\\|")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\./g, "\\.")
    .replace(/\!/g, "\\!");
};

/** "Open", "In Progress" — from the stored enum value. */
ticketsUtil.formatStatusLabel = (status) =>
  String(status || "")
    .replace(/_/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");

ticketsUtil.statusEmoji = (status) => statusEmojis[status] || "⚪";
ticketsUtil.priorityEmoji = (priority) =>
  priorityEmojis[String(priority || "").toLowerCase()] || "⚪";

ticketsUtil.itemLabel = (itemType) =>
  itemTypeLabels[itemType] || itemTypeLabels.ticket;

/** DD/MM/YY, or null when there is no date. */
ticketsUtil.formatDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  if (isNaN(date.getTime())) return null;
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = String(date.getFullYear()).slice(-2);
  return `${day}/${month}/${year}`;
};

ticketsUtil.formatDateTime = (value) => {
  if (!value) return null;
  const date = new Date(value);
  if (isNaN(date.getTime())) return null;
  const hours = date.getHours() % 12 || 12;
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const ampm = date.getHours() >= 12 ? "PM" : "AM";
  return `${hours}:${minutes} ${ampm} | ${ticketsUtil.formatDate(value)}`;
};

/** Whole days between the due date and today; negative means overdue. */
ticketsUtil.daysUntilDue = (dueDate) => {
  if (!dueDate) return null;
  const due = new Date(dueDate);
  if (isNaN(due.getTime())) return null;
  const startOfDay = (d) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((startOfDay(due) - startOfDay(new Date())) / 86400000);
};

/** "Overdue by 3 days" / "Due today" / "Due in 2 days" */
ticketsUtil.formatDueLabel = (dueDate) => {
  const days = ticketsUtil.daysUntilDue(dueDate);
  if (days === null) return null;
  if (days < 0) {
    const n = Math.abs(days);
    return `Overdue by ${n} day${n === 1 ? "" : "s"}`;
  }
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  return `Due in ${days} days`;
};

/** Resolves an employee to a @handle, falling back to their name then their id. */
const resolveHandle = async (employeeUsecase, employeeId, fallbackLabel) => {
  if (!employeeId) return fallbackLabel;
  try {
    const rows = await employeeUsecase.getEmployeeById(employeeId);
    if (rows && rows.length > 0) {
      if (rows[0].telegram_username) return "@" + rows[0].telegram_username;
      if (rows[0].employee_name) return rows[0].employee_name;
    }
  } catch (err) {
    console.error("Error fetching employee details:", err);
  }
  return "ID: " + employeeId;
};

ticketsUtil.formatTicketMessage = async (
  employeeUsecase,
  ticket,
  includeImages = false
) => {
  const creatorUsername = await resolveHandle(
    employeeUsecase,
    ticket.created_by,
    "Unknown"
  );
  const assigneeUsername = await resolveHandle(
    employeeUsecase,
    ticket.assigned_to,
    "Not assigned"
  );

  const type = ticketsUtil.itemLabel(ticket.item_type);
  const priority = String(ticket.priority || "").toLowerCase();

  let message =
    `${type.emoji} *${type.label} #${ticket.id}*\n\n` +
    `📝 *Title:* ${ticketsUtil.escapeMarkdown(ticket.title)}\n` +
    `👤 *Created by:* ${ticketsUtil.escapeMarkdown(creatorUsername)}\n` +
    `👥 *Assigned to:* ${ticketsUtil.escapeMarkdown(assigneeUsername)}\n` +
    `🔄 *Status:* ${ticketsUtil.statusEmoji(
      ticket.status
    )} ${ticketsUtil.formatStatusLabel(ticket.status)}\n` +
    `⚡ *Priority:* ${ticketsUtil.priorityEmoji(priority)} ${
      priority.charAt(0).toUpperCase() + priority.slice(1)
    }\n`;

  const dueLabel = ticketsUtil.formatDueLabel(ticket.due_date);
  if (dueLabel) {
    const days = ticketsUtil.daysUntilDue(ticket.due_date);
    message +=
      `${days < 0 ? "⏰" : "🗓"} *Due:* ${ticketsUtil.formatDate(
        ticket.due_date
      )} — ${ticketsUtil.escapeMarkdown(dueLabel)}\n`;
  }

  if (ticket.checklist && ticket.checklist.length > 0) {
    const done = ticket.checklist.filter((item) => item.is_done).length;
    message += `☑️ *Checklist:* ${done}/${ticket.checklist.length} done\n`;
  }

  message += `\nℹ️ *More Info:*\n`;

  message += `🏪 *Outlet:* ${ticketsUtil.escapeMarkdown(
    ticket.outlet_name || "Not assigned"
  )}\n`;

  message += `🏢 *Department:* ${ticketsUtil.escapeMarkdown(
    ticket.department_name || "Not assigned"
  )}\n`;

  const createdAt = ticketsUtil.formatDateTime(ticket.created_at);
  if (createdAt) {
    message += `📅 *Created:* ${createdAt}\n`;
  }

  if (includeImages && ticket.images && ticket.images.length > 0) {
    const videos = ticket.images.filter((item) =>
      ticketsUtil.isVideoUrl(item.s3_url)
    ).length;
    const photos = ticket.images.length - videos;
    const parts = [];
    if (photos > 0) parts.push(`${photos} photo${photos === 1 ? "" : "s"}`);
    if (videos > 0) parts.push(`${videos} video${videos === 1 ? "" : "s"}`);
    message += `📸 *Attachments:* ${parts.join(", ")}\n`;
  }

  message += `\n📄 *Description:*\n${ticketsUtil.escapeMarkdown(
    ticket.description || ""
  )}`;

  return message;
};

ticketsUtil.formatStatusUpdateMessage = (ticket) => {
  const type = ticketsUtil.itemLabel(ticket.item_type);
  return (
    "✅ Status updated successfully!\n\n" +
    `${type.emoji} ${type.label} #${ticket.id}\n` +
    `📝 Title: ${ticketsUtil.escapeMarkdown(ticket.title)}\n` +
    `🔄 New Status: ${ticketsUtil.statusEmoji(
      ticket.status
    )} ${ticketsUtil.formatStatusLabel(ticket.status)}`
  );
};

ticketsUtil.formatAssignedMessage = (ticket, assigneeLabel) => {
  const type = ticketsUtil.itemLabel(ticket.item_type);
  const dueLabel = ticketsUtil.formatDueLabel(ticket.due_date);
  let message =
    `${type.emoji} ${type.label} #${ticket.id} has been assigned to ${assigneeLabel}\n` +
    `📝 ${ticketsUtil.escapeMarkdown(ticket.title)}`;
  if (dueLabel) {
    message += `\n🗓 ${ticketsUtil.escapeMarkdown(dueLabel)}`;
  }
  return message;
};

ticketsUtil.formatCommentMessage = (ticket, authorName, comment) => {
  const type = ticketsUtil.itemLabel(ticket.item_type);
  return (
    `💬 *New comment on ${type.label} #${ticket.id}*\n` +
    `📝 ${ticketsUtil.escapeMarkdown(ticket.title)}\n\n` +
    `*${ticketsUtil.escapeMarkdown(authorName || "Someone")}:* ` +
    `${ticketsUtil.escapeMarkdown(comment)}`
  );
};

/** Groups overdue items by assignee for the daily nudge. */
ticketsUtil.formatOverdueDigest = (items) => {
  const lines = items.slice(0, 20).map((item) => {
    const type = ticketsUtil.itemLabel(item.item_type);
    const days = item.days_overdue;
    return (
      `${type.emoji} *#${item.id}* ${ticketsUtil.escapeMarkdown(item.title)}\n` +
      `   ${ticketsUtil.priorityEmoji(item.priority)} ` +
      `${ticketsUtil.escapeMarkdown(
        item.assigned_to_name || "Unassigned"
      )} — ${days} day${days === 1 ? "" : "s"} overdue`
    );
  });

  let message =
    `⏰ *Overdue work — ${items.length} item${
      items.length === 1 ? "" : "s"
    }*\n\n` + lines.join("\n\n");

  if (items.length > lines.length) {
    message += `\n\n…and ${items.length - lines.length} more.`;
  }

  return message;
};

module.exports = ticketsUtil;
