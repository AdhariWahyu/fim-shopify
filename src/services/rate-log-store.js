const fs = require("node:fs");
const crypto = require("node:crypto");

class RateLogStore {
  constructor(filePath, logger, options = {}) {
    this.filePath = filePath;
    this.logger = logger;
    this.maxEntries = Number.isInteger(options.maxEntries)
      ? options.maxEntries
      : 500;
    this.entries = [];
    this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) {
        this.entries = [];
        return;
      }

      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      this.entries = Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      this.logger.warn("Failed to load rate log store, using empty logs", {
        filePath: this.filePath,
        error: error.message
      });
      this.entries = [];
    }
  }

  save() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.entries, null, 2), "utf8");
    } catch (error) {
      this.logger.error("Failed to persist rate log store", {
        filePath: this.filePath,
        error: error.message
      });
    }
  }

  append(entry) {
    if (!entry || typeof entry !== "object") {
      return null;
    }

    const id =
      entry.id ||
      entry.quoteId ||
      `quote_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;

    const logEntry = {
      id,
      createdAt: new Date().toISOString(),
      ...entry
    };

    this.entries.push(logEntry);

    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(this.entries.length - this.maxEntries);
    }

    this.save();
    return logEntry;
  }

  list(limit = 50) {
    const normalizedLimit = Math.max(1, Number.parseInt(limit, 10) || 50);
    const copy = this.entries.slice();
    copy.reverse();
    return copy.slice(0, normalizedLimit);
  }

  get(id) {
    if (!id) {
      return null;
    }

    return this.entries.find((entry) => String(entry.id) === String(id)) || null;
  }

  size() {
    return this.entries.length;
  }
}

module.exports = {
  RateLogStore
};
