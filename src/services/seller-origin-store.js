const fs = require("node:fs");

class SellerOriginStore {
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
      this.logger.warn("Failed to load seller origin store, using empty store", {
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
      this.logger.error("Failed to persist seller origin store", {
        filePath: this.filePath,
        error: error.message
      });
    }
  }

  upsert(origin) {
    if (!origin || !origin.sellerId) {
      return;
    }

    const sellerId = String(origin.sellerId);
    const nextValue = {
      sellerId,
      postalCode: origin.postalCode || "",
      city: origin.city || "",
      state: origin.state || "",
      country: origin.country || "ID",
      address1: origin.address1 || "",
      contact: origin.contact || "",
      sellerEmail: origin.sellerEmail || "",
      storeName: origin.storeName || "",
      storeNameHandle: origin.storeNameHandle || "",
      shopDomain: origin.shopDomain || "",
      latitude: origin.latitude || "",
      longitude: origin.longitude || "",
      source: origin.source || "manual",
      updatedAt: new Date().toISOString()
    };

    this.data[sellerId] = nextValue;
    this.save();
  }

  get(sellerId) {
    if (!sellerId) {
      return null;
    }

    return this.data[String(sellerId)] || null;
  }

  all() {
    return Object.values(this.data);
  }
}

module.exports = {
  SellerOriginStore
};
