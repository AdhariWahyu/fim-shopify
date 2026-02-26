const fs = require("node:fs");

class OrderSyncStore {
  constructor(filePath, logger) {
    this.filePath = filePath;
    this.logger = logger;
    this.data = {};
    this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) {
        this.data = {};
        return;
      }

      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      this.data = parsed && typeof parsed === "object" ? parsed : {};
    } catch (error) {
      this.logger.warn("Failed to load order sync store, using empty store", {
        filePath: this.filePath,
        error: error.message
      });
      this.data = {};
    }
  }

  save() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf8");
    } catch (error) {
      this.logger.error("Failed to persist order sync store", {
        filePath: this.filePath,
        error: error.message
      });
    }
  }

  get(orderId) {
    if (!orderId) {
      return null;
    }

    return this.data[String(orderId)] || null;
  }

  saveRecord(record) {
    if (!record || !record.orderId) {
      return null;
    }

    const orderId = String(record.orderId);
    const now = new Date().toISOString();
    const previous = this.data[orderId] || null;

    const nextValue = {
      orderId,
      createdAt: previous?.createdAt || now,
      updatedAt: now,
      ...previous,
      ...record,
      orderId,
      updatedAt: now
    };

    this.data[orderId] = nextValue;
    this.save();
    return nextValue;
  }

  list(limit = 50) {
    const normalizedLimit = Math.max(1, Number.parseInt(limit, 10) || 50);
    const records = Object.values(this.data)
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));

    return records.slice(0, normalizedLimit);
  }

  size() {
    return Object.keys(this.data).length;
  }
}

module.exports = {
  OrderSyncStore
};
