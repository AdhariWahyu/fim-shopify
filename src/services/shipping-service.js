const crypto = require("node:crypto");
const { fromShopifySubunits, toShopifySubunits } = require("../utils/money");
const { stableStringify, sha256Hex } = require("../utils/hash");
const { normalizePostalCode, truthy } = require("../utils/location");

class ShippingService {
  constructor(options) {
    this.config = options.config;
    this.logger = options.logger;
    this.webkulClient = options.webkulClient;
    this.biteshipClient = options.biteshipClient;
    this.variantCache = options.variantCache;
    this.sellerCache = options.sellerCache;
    this.rateCache = options.rateCache;
    this.sellerOriginStore = options.sellerOriginStore;
  }

  _sanitizeServiceCode(rawCode) {
    return String(rawCode || "RATE")
      .toUpperCase()
      .replace(/[^A-Z0-9_]/g, "_")
      .slice(0, 60);
  }

  _toFiniteNumber(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  _toIsoDateFromNow(days) {
    if (!Number.isFinite(days) || days <= 0) {
      return undefined;
    }

    const ms = Date.now() + days * 24 * 60 * 60 * 1000;
    return new Date(ms).toISOString();
  }

  _isShippable(item) {
    if (item.requires_shipping === undefined || item.requires_shipping === null) {
      return true;
    }

    return truthy(item.requires_shipping);
  }

  _normalizeVariantId(item) {
    const variantId = item.variant_id || item.variantId;
    if (variantId === undefined || variantId === null || variantId === "") {
      return "";
    }

    return String(variantId);
  }

  _buildRateCacheKey(rateRequest) {
    const destinationPostalCode = normalizePostalCode(
      rateRequest?.destination?.postal_code ||
        rateRequest?.destination?.zip ||
        rateRequest?.destination?.postalCode,
      { length: this.config.shipping.postalCodeLength }
    );
    const destinationLatitude = this._toFiniteNumber(
      rateRequest?.destination?.latitude
    );
    const destinationLongitude = this._toFiniteNumber(
      rateRequest?.destination?.longitude
    );

    const items = Array.isArray(rateRequest?.items)
      ? rateRequest.items.map((item) => ({
          variant_id: this._normalizeVariantId(item),
          quantity: Number.parseInt(item.quantity || 1, 10) || 1,
          grams: Number.parseInt(item.grams || 0, 10) || 0,
          price: Number.parseInt(item.price || 0, 10) || 0,
          requires_shipping: truthy(item.requires_shipping)
        }))
      : [];

    items.sort((a, b) => {
      return String(a.variant_id).localeCompare(String(b.variant_id));
    });

    const payload = {
      destinationPostalCode,
      destinationLatitude,
      destinationLongitude,
      currency: rateRequest?.currency || this.config.shipping.currency,
      couriers: this.config.biteship.couriers,
      items
    };

    return sha256Hex(stableStringify(payload));
  }

  async _getVariantMapping(shopifyVariantId) {
    const cacheKey = String(shopifyVariantId);
    const cached = this.variantCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const resolved = await this.webkulClient.resolveVariantToSeller(shopifyVariantId);
    this.variantCache.set(cacheKey, resolved, this.config.cache.variantTtlSeconds);
    return resolved;
  }

  async _getSellerOrigin(sellerId) {
    const sellerKey = String(sellerId);

    const persisted = this.sellerOriginStore.get(sellerKey);
    if (persisted?.postalCode) {
      return persisted;
    }

    const cached = this.sellerCache.get(sellerKey);
    if (cached?.postalCode) {
      return cached;
    }

    try {
      const resolved = await this.webkulClient.resolveSellerOrigin(sellerKey);
      this.sellerCache.set(sellerKey, resolved, this.config.cache.sellerTtlSeconds);
      this.sellerOriginStore.upsert(resolved);
      return resolved;
    } catch (error) {
      const fallbackPostalCode = normalizePostalCode(
        this.config.shipping.defaultOriginPostalCode,
        { length: this.config.shipping.postalCodeLength }
      );

      if (fallbackPostalCode) {
        const fallback = {
          sellerId: sellerKey,
          postalCode: fallbackPostalCode,
          city: "",
          state: "",
          country: "ID",
          address1: "",
          source: "default_origin"
        };
        this.logger.warn("Using default origin postal code for seller", {
          sellerId: sellerKey,
          fallbackPostalCode,
          error: error.message
        });
        return fallback;
      }

      throw error;
    }
  }

  _buildBiteshipItem(item, variantMapping) {
    const quantity = Math.max(1, Number.parseInt(item.quantity || 1, 10) || 1);
    const grams =
      Math.max(0, Number.parseInt(item.grams || 0, 10)) ||
      Math.max(0, Number.parseInt(variantMapping?.variantWeight || 0, 10)) ||
      this.config.shipping.defaultItemWeightGrams;
    const priceMajor = Math.max(1, Math.round(fromShopifySubunits(item.price)));

    const payload = {
      name: item.name || item.sku || "Product",
      value: priceMajor,
      weight: grams,
      quantity
    };

    const length = Math.max(
      0,
      Number(item.length || variantMapping?.lengthCm || 0)
    );
    const width = Math.max(0, Number(item.width || variantMapping?.widthCm || 0));
    const height = Math.max(
      0,
      Number(item.height || variantMapping?.heightCm || 0)
    );

    if (length > 0) {
      payload.length = length;
    }
    if (width > 0) {
      payload.width = width;
    }
    if (height > 0) {
      payload.height = height;
    }

    if (item.description) {
      payload.description = String(item.description);
    }

    return payload;
  }

  _rateKey(rate) {
    return `${rate.courierCode}__${rate.serviceCode}`;
  }

  _toShopifyRate(rate, currency, sellerGroupCount, isFallback) {
    const serviceName = isFallback
      ? `${this.config.shipping.serviceNamePrefix} Multi Seller (Cheapest)`
      : `${this.config.shipping.serviceNamePrefix} ${rate.courierName} ${rate.serviceName}`;

    const serviceCode = isFallback
      ? "BSH_MULTI_CHEAPEST"
      : this._sanitizeServiceCode(`BSH_${rate.courierCode}_${rate.serviceCode}`);

    const payload = {
      service_name: serviceName,
      service_code: serviceCode,
      total_price: String(toShopifySubunits(rate.totalPriceIdr)),
      currency,
      description: isFallback
        ? `Cheapest mixed courier (${sellerGroupCount} origin seller)`
        : `Biteship ${rate.courierName} ${rate.serviceName} (${sellerGroupCount} origin seller)`,
      phone_required: this.config.shopify.phoneRequired
    };

    const minDeliveryDate = this._toIsoDateFromNow(rate.minDay);
    const maxDeliveryDate = this._toIsoDateFromNow(rate.maxDay);

    if (minDeliveryDate) {
      payload.min_delivery_date = minDeliveryDate;
    }
    if (maxDeliveryDate) {
      payload.max_delivery_date = maxDeliveryDate;
    }

    return payload;
  }

  _aggregate(groupRates, subtotalIdr) {
    const normalizedGroups = groupRates.map((group) => {
      const deduped = new Map();
      for (const rate of group.rates) {
        const key = this._rateKey(rate);
        const existing = deduped.get(key);
        if (!existing || rate.price < existing.price) {
          deduped.set(key, rate);
        }
      }

      return {
        sellerId: group.sellerId,
        originPostalCode: group.originPostalCode,
        byKey: deduped,
        cheapest: Array.from(deduped.values()).sort((a, b) => a.price - b.price)[0] || null
      };
    });

    let commonKeys = null;
    for (const group of normalizedGroups) {
      const keys = new Set(group.byKey.keys());
      if (commonKeys === null) {
        commonKeys = keys;
        continue;
      }

      commonKeys = new Set([...commonKeys].filter((key) => keys.has(key)));
    }

    const handlingFee = Math.max(0, this.config.shipping.handlingFeeIdr || 0);
    const freeThreshold = Math.max(0, this.config.shipping.freeThresholdIdr || 0);

    const aggregated = [];
    const commonKeysList = commonKeys ? [...commonKeys] : [];

    for (const key of commonKeysList) {
      let totalPrice = 0;
      let courierName = "Biteship";
      let serviceName = "Regular";
      let courierCode = "biteship";
      let serviceCode = "regular";
      let minDay = 0;
      let maxDay = 0;

      for (const group of normalizedGroups) {
        const rate = group.byKey.get(key);
        totalPrice += rate.price;
        courierName = rate.courierName || courierName;
        serviceName = rate.serviceName || serviceName;
        courierCode = rate.courierCode || courierCode;
        serviceCode = rate.serviceCode || serviceCode;

        minDay = Math.max(minDay, rate.minDay || 0);
        maxDay = Math.max(maxDay, rate.maxDay || 0);
      }

      totalPrice += handlingFee;

      if (freeThreshold > 0 && subtotalIdr >= freeThreshold) {
        totalPrice = 0;
      }

      aggregated.push({
        courierName,
        serviceName,
        courierCode,
        serviceCode,
        totalPriceIdr: totalPrice,
        minDay,
        maxDay,
        fallback: false
      });
    }

    if (aggregated.length > 0) {
      return aggregated;
    }

    if (normalizedGroups.some((group) => !group.cheapest)) {
      return [];
    }

    let mixedTotal = 0;
    let minDay = 0;
    let maxDay = 0;

    for (const group of normalizedGroups) {
      mixedTotal += group.cheapest.price;
      minDay = Math.max(minDay, group.cheapest.minDay || 0);
      maxDay = Math.max(maxDay, group.cheapest.maxDay || 0);
    }

    mixedTotal += handlingFee;

    if (freeThreshold > 0 && subtotalIdr >= freeThreshold) {
      mixedTotal = 0;
    }

    return [
      {
        courierName: "Mixed",
        serviceName: "Cheapest",
        courierCode: "mixed",
        serviceCode: "cheapest",
        totalPriceIdr: mixedTotal,
        minDay,
        maxDay,
        fallback: true
      }
    ];
  }

  async calculate(rateRequest) {
    const quoteId = `qt_${crypto.randomBytes(5).toString("hex")}`;

    if (!rateRequest || typeof rateRequest !== "object") {
      return {
        rates: [],
        debug: {
          quoteId,
          reason: "invalid_payload"
        }
      };
    }

    const items = Array.isArray(rateRequest.items) ? rateRequest.items : [];
    const shippableItems = items.filter((item) => this._isShippable(item));

    if (shippableItems.length === 0) {
      return {
        rates: [],
        debug: {
          quoteId,
          reason: "no_shippable_items"
        }
      };
    }

    const destinationPostalCode = normalizePostalCode(
      rateRequest?.destination?.postal_code ||
        rateRequest?.destination?.zip ||
        rateRequest?.destination?.postalCode,
      { length: this.config.shipping.postalCodeLength }
    );
    const destinationLatitude = this._toFiniteNumber(
      rateRequest?.destination?.latitude
    );
    const destinationLongitude = this._toFiniteNumber(
      rateRequest?.destination?.longitude
    );
    const hasDestinationCoordinates =
      destinationLatitude !== null && destinationLongitude !== null;

    if (!destinationPostalCode && !hasDestinationCoordinates) {
      return {
        rates: [],
        debug: {
          quoteId,
          reason: "missing_destination_location"
        }
      };
    }

    this.logger.info("Calculating carrier quote", {
      quoteId,
      destinationPostalCode,
      destinationLatitude,
      destinationLongitude,
      itemCount: shippableItems.length
    });

    const rateCacheKey = this._buildRateCacheKey(rateRequest);
    const cachedRates = this.rateCache.get(rateCacheKey);
    if (cachedRates) {
      return {
        rates: cachedRates,
        debug: {
          quoteId,
          source: "rate_cache"
        }
      };
    }

    const uniqueVariantIds = [...new Set(shippableItems.map((item) => this._normalizeVariantId(item)).filter(Boolean))];

    if (uniqueVariantIds.length === 0) {
      return {
        rates: [],
        debug: {
          quoteId,
          reason: "missing_variant_ids"
        }
      };
    }

    const variantMappings = new Map();
    for (const variantId of uniqueVariantIds) {
      const mapping = await this._getVariantMapping(variantId);
      variantMappings.set(variantId, mapping);
    }

    const uniqueSellerIds = [...new Set(Array.from(variantMappings.values()).map((entry) => entry.sellerId))];
    const sellerOrigins = new Map();

    for (const sellerId of uniqueSellerIds) {
      const origin = await this._getSellerOrigin(sellerId);
      sellerOrigins.set(sellerId, origin);
    }

    const groupsBySeller = new Map();
    const skippedItems = [];

    for (const item of shippableItems) {
      const variantId = this._normalizeVariantId(item);
      const mapping = variantMappings.get(variantId);

      if (!mapping) {
        skippedItems.push({ variantId, reason: "variant_mapping_not_found" });
        continue;
      }

      const sellerId = mapping.sellerId;
      const origin = sellerOrigins.get(sellerId);
      const originLatitude = this._toFiniteNumber(origin?.latitude);
      const originLongitude = this._toFiniteNumber(origin?.longitude);
      const hasOriginCoordinates =
        originLatitude !== null && originLongitude !== null;

      if (!origin?.postalCode && !hasOriginCoordinates) {
        skippedItems.push({
          variantId,
          sellerId,
          reason: "seller_origin_not_found"
        });
        continue;
      }

      if (!groupsBySeller.has(sellerId)) {
        groupsBySeller.set(sellerId, {
          sellerId,
          originPostalCode: origin.postalCode,
          originLatitude,
          originLongitude,
          items: []
        });
      }

      groupsBySeller
        .get(sellerId)
        .items.push(this._buildBiteshipItem(item, mapping));
    }

    const sellerGroups = Array.from(groupsBySeller.values());

    if (sellerGroups.length === 0) {
      return {
        rates: [],
        debug: {
          quoteId,
          reason: "no_valid_seller_groups",
          skippedItems
        }
      };
    }

    const biteshipResults = await Promise.all(
      sellerGroups.map(async (group) => {
        this.logger.debug("Requesting Biteship rates for seller group", {
          quoteId,
          sellerId: group.sellerId,
          originPostalCode: group.originPostalCode,
          destinationPostalCode,
          itemCount: group.items.length
        });

        const rates = await this.biteshipClient.getRates({
          originPostalCode: group.originPostalCode,
          destinationPostalCode,
          originLatitude: this._toFiniteNumber(group.originLatitude),
          originLongitude: this._toFiniteNumber(group.originLongitude),
          destinationLatitude,
          destinationLongitude,
          items: group.items
        });

        return {
          sellerId: group.sellerId,
          originPostalCode: group.originPostalCode,
          rates
        };
      })
    );

    const subtotalIdr = shippableItems.reduce((acc, item) => {
      const quantity = Math.max(1, Number.parseInt(item.quantity || 1, 10) || 1);
      return acc + fromShopifySubunits(item.price) * quantity;
    }, 0);

    const aggregatedRates = this._aggregate(biteshipResults, subtotalIdr)
      .sort((a, b) => a.totalPriceIdr - b.totalPriceIdr)
      .slice(0, this.config.shipping.maxRates);

    const currency = rateRequest.currency || this.config.shipping.currency;
    const shopifyRates = aggregatedRates.map((rate) =>
      this._toShopifyRate(rate, currency, sellerGroups.length, rate.fallback)
    );

    this.logger.info("Carrier quote calculated", {
      quoteId,
      destinationPostalCode,
      sellerGroupCount: sellerGroups.length,
      returnedRateCount: shopifyRates.length,
      skippedItemCount: skippedItems.length
    });

    this.rateCache.set(
      rateCacheKey,
      shopifyRates,
      this.config.cache.rateTtlSeconds
    );

    return {
      rates: shopifyRates,
      debug: {
        quoteId,
        destinationPostalCode,
        destinationLatitude,
        destinationLongitude,
        subtotalIdr,
        sellerGroups: sellerGroups.map((group) => ({
          sellerId: group.sellerId,
          originPostalCode: group.originPostalCode,
          originLatitude: group.originLatitude || null,
          originLongitude: group.originLongitude || null,
          itemCount: group.items.length
        })),
        skippedItems
      }
    };
  }
}

module.exports = {
  ShippingService
};
