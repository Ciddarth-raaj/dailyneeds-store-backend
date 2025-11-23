const ticketsUtil = {};

const priorityEmojis = {
  low: "🟢",
  medium: "🟡",
  high: "🔴",
};

const statusEmojis = {
  open: "🟢",
  closed: "🔴",
  in_progress: "🟡",
  inprogress: "🟡",
};

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

ticketsUtil.formatTicketMessage = async (
  employeeUsecase,
  ticket,
  includeImages = false
) => {
  let creatorDetails = null;
  let assigneeDetails = null;

  // Fetch creator details if created_by is available
  if (ticket.created_by) {
    try {
      const creatorData = await employeeUsecase.getEmployeeById(
        ticket.created_by
      );
      if (creatorData && creatorData.length > 0) {
        creatorDetails = {
          employee_name: creatorData[0].employee_name || null,
          telegram_username: creatorData[0].telegram_username || null,
        };
      }
    } catch (err) {
      // Log error but continue without creator details
      console.error("Error fetching creator details:", err);
    }
  }

  // Fetch assignee details if assigned_to is available
  if (ticket.assigned_to) {
    try {
      const assigneeData = await employeeUsecase.getEmployeeById(
        ticket.assigned_to
      );
      if (assigneeData && assigneeData.length > 0) {
        assigneeDetails = {
          employee_name: assigneeData[0].employee_name || null,
          telegram_username: assigneeData[0].telegram_username || null,
        };
      }
    } catch (err) {
      // Log error but continue without assignee details
      console.error("Error fetching assignee details:", err);
    }
  }

  // Get priority emoji
  const priority = (ticket.priority || "").toLowerCase();
  const priorityEmoji = priorityEmojis[priority] || "⚪";

  // Get status emoji and format status
  const status = (ticket.status || "").replace(/_/g, " ");
  const statusEmoji = statusEmojis[status] || "⚪";
  const formattedStatus = status
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");

  // Format creator info
  let creatorUsername = "Unknown";
  if (creatorDetails && creatorDetails.telegram_username) {
    creatorUsername = "@" + creatorDetails.telegram_username;
  } else if (creatorDetails && creatorDetails.employee_name) {
    creatorUsername = creatorDetails.employee_name;
  } else if (ticket.created_by) {
    creatorUsername = "ID: " + ticket.created_by;
  }

  console.log("CREATOR USERNAME", assigneeDetails);

  // Format assignee info
  let assigneeUsername = "Not assigned";
  if (assigneeDetails && assigneeDetails.telegram_username) {
    assigneeUsername = "@" + assigneeDetails.telegram_username;
  } else if (assigneeDetails && assigneeDetails.employee_name) {
    assigneeUsername = assigneeDetails.employee_name;
  } else if (ticket.assigned_to) {
    assigneeUsername = "ID: " + ticket.assigned_to;
  }

  // Build the message
  let message =
    `🎫 *Ticket #${ticket.id}*\n\n` +
    `📝 *Title:* ${ticketsUtil.escapeMarkdown(ticket.title)}\n` +
    `👤 *Created by:* ${ticketsUtil.escapeMarkdown(creatorUsername)}\n` +
    `👥 *Assigned to:* ${ticketsUtil.escapeMarkdown(assigneeUsername)}\n` +
    `🔄 *Status:* ${statusEmoji} ${formattedStatus}\n` +
    `⚡ *Priority:* ${priorityEmoji} ${
      priority.charAt(0).toUpperCase() + priority.slice(1)
    }\n\n` +
    `ℹ️ *More Info:*\n`;

  // Add outlet info if available
  message += `🏪 *Outlet:* ${ticketsUtil.escapeMarkdown(
    ticket.outlet_name || "Not assigned"
  )}\n`;

  // Add department info
  message += `🏢 *Department:* ${ticketsUtil.escapeMarkdown(
    ticket.department_name || "Not assigned"
  )}\n`;

  // Add creation date if available
  if (ticket.created_at) {
    const date = new Date(ticket.created_at);
    const hours = date.getHours() % 12 || 12;
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const ampm = date.getHours() >= 12 ? "PM" : "AM";
    const day = String(date.getDate()).padStart(2, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const year = String(date.getFullYear()).slice(-2);
    message += `📅 *Created:* ${hours}:${minutes} ${ampm} | ${day}/${month}/${year}\n`;
  }

  // Add image count if requested and available
  if (includeImages && ticket.images.length > 0) {
    message += `📸 *Images:* ${ticket.images.length}\n`;
  }

  // Add description
  message += `\n📄 *Description:*\n${ticketsUtil.escapeMarkdown(
    ticket.description || ""
  )}`;

  return message;
};

ticketsUtil.formatStatusUpdateMessage = (ticket) => {
  // Get status emoji and format status
  const originalStatus = ticket.status || "";
  const statusWithSpaces = originalStatus.replace(/_/g, " ");
  const statusEmoji =
    statusEmojis[originalStatus] ||
    statusEmojis[statusWithSpaces] ||
    statusEmojis[originalStatus.toLowerCase()] ||
    "⚪";
  const formattedStatus = statusWithSpaces
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");

  const message =
    "✅ Status updated successfully!\n\n" +
    `🎫 Ticket #${ticket.id}\n` +
    `📝 Title: ${ticketsUtil.escapeMarkdown(ticket.title)}\n` +
    `🔄 New Status: ${statusEmoji} ${formattedStatus}`;

  return message;
};

module.exports = ticketsUtil;
