function normalizePostalCode(rawValue, options = {}) {
  const value = String(rawValue || "").trim();
  if (!value) {
    return "";
  }

  const length = Number.isInteger(options.length) ? options.length : 0;
  const digits = value.replace(/[^\d]/g, "");

  if (digits) {
    if (length > 0 && digits.length >= length) {
      return digits.slice(0, length);
    }
    return digits;
  }

  const compact = value.replace(/\s+/g, "").toUpperCase();
  if (length > 0 && compact.length >= length) {
    return compact.slice(0, length);
  }

  return compact;
}

function truthy(input) {
  if (typeof input === "boolean") {
    return input;
  }

  const value = String(input || "").toLowerCase().trim();
  return ["1", "true", "yes", "y", "on"].includes(value);
}

module.exports = {
  normalizePostalCode,
  truthy
};
