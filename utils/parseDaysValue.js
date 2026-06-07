/**
 * Parse day values such as "1d", "10d", "16d" or plain numbers to integer days.
 * @param {unknown} value
 * @returns {number|null}
 */
function parseDaysValue(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  const trimmed = String(value).trim().toLowerCase();
  if (!trimmed) return null;

  const withoutSuffix = trimmed.endsWith("d")
    ? trimmed.slice(0, -1).trim()
    : trimmed;
  const parsed = Number(withoutSuffix);
  return Number.isNaN(parsed) ? null : Math.trunc(parsed);
}

module.exports = {
  parseDaysValue,
};
