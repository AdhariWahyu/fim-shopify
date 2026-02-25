const crypto = require("node:crypto");

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  const keys = Object.keys(value).sort();
  const pairs = keys.map(
    (key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`
  );
  return `{${pairs.join(",")}}`;
}

function sha256Hex(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

module.exports = {
  stableStringify,
  sha256Hex
};
