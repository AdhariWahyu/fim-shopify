const fs = require("node:fs");
const axios = require("axios");
const { normalizePostalCode, truthy } = require("../utils/location");

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseRetryAfterMs(value) {
  if (!value) {
    return null;
  }

  const asNumber = Number(value);
  if (!Number.isNaN(asNumber)) {
    return Math.max(0, Math.round(asNumber * 1000));
  }

  const asDateMs = Date.parse(value);
  if (!Number.isNaN(asDateMs)) {
    return Math.max(0, asDateMs - Date.now());
  }

  return null;
}

class WebkulClient {
  constructor(options) {
    this.baseUrl = options.baseUrl;
    this.timeoutMs = options.timeoutMs;
    this.maxRetries = Number.isInteger(options.maxRetries)
      ? options.maxRetries
      : 4;
    this.retryDelayMs = Number.isInteger(options.retryDelayMs)
      ? options.retryDelayMs
      : 400;
    this.tokenStorePath = options.tokenStorePath;
    this.postalCodeLength = options.postalCodeLength;
    this.logger = options.logger;

    this.tokens = {
      accessToken: options.accessToken,
      refreshToken: options.refreshToken
    };

    this.refreshInFlight = null;

    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: this.timeoutMs,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      }
    });

    this._loadTokenStore();
  }

  _loadTokenStore() {
    try {
      if (!this.tokenStorePath || !fs.existsSync(this.tokenStorePath)) {
        return;
      }

      const raw = fs.readFileSync(this.tokenStorePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed.accessToken) {
        this.tokens.accessToken = parsed.accessToken;
      }
      if (parsed.refreshToken) {
        this.tokens.refreshToken = parsed.refreshToken;
      }
      this.logger.info("Loaded Webkul token store", {
        path: this.tokenStorePath
      });
    } catch (error) {
      this.logger.warn("Failed to load Webkul token store", {
        path: this.tokenStorePath,
        error: error.message
      });
    }
  }

  _persistTokenStore() {
    if (!this.tokenStorePath) {
      return;
    }

    try {
      const payload = {
        accessToken: this.tokens.accessToken,
        refreshToken: this.tokens.refreshToken,
        updatedAt: new Date().toISOString()
      };
      fs.writeFileSync(this.tokenStorePath, JSON.stringify(payload, null, 2), "utf8");
    } catch (error) {
      this.logger.error("Failed to persist Webkul token store", {
        path: this.tokenStorePath,
        error: error.message
      });
    }
  }

  async _refreshToken() {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    this.refreshInFlight = this.http
      .post("/authorize/token.json", {
        access_token: this.tokens.accessToken,
        refresh_token: this.tokens.refreshToken
      })
      .then((response) => {
        const payload = response.data || {};
        if (!payload.access_token) {
          throw new Error("Webkul token refresh response missing access_token");
        }

        this.tokens.accessToken = payload.access_token;
        if (payload.refresh_token) {
          this.tokens.refreshToken = payload.refresh_token;
        }

        this._persistTokenStore();
        this.logger.info("Webkul token refreshed");
      })
      .catch((error) => {
        const status = error.response?.status;
        const data = error.response?.data;
        this.logger.error("Webkul token refresh failed", {
          status,
          data
        });
        throw error;
      })
      .finally(() => {
        this.refreshInFlight = null;
      });

    return this.refreshInFlight;
  }

  async request({ method, url, params, data }, retry = true, attempt = 0) {
    try {
      const response = await this.http.request({
        method,
        url,
        params,
        data,
        headers: {
          Authorization: `Bearer ${this.tokens.accessToken}`
        }
      });
      return response.data;
    } catch (error) {
      const status = error.response?.status;
      const retryAfterHeader = error.response?.headers?.["retry-after"];
      const shouldRetryWithBackoff =
        (status === 429 || status === 408 || status >= 500) &&
        attempt < this.maxRetries;

      if (status === 401 && retry) {
        await this._refreshToken();
        return this.request({ method, url, params, data }, false, attempt);
      }

      if (shouldRetryWithBackoff) {
        const retryAfterMs =
          parseRetryAfterMs(retryAfterHeader) ||
          this.retryDelayMs * 2 ** attempt;

        this.logger.warn("Retrying Webkul request after throttling/error", {
          method,
          url,
          status,
          attempt,
          retryAfterMs
        });

        await sleep(retryAfterMs);
        return this.request({ method, url, params, data }, retry, attempt + 1);
      }

      const wrappedError = new Error(
        `Webkul request failed: ${method.toUpperCase()} ${url}`
      );
      wrappedError.details = {
        status,
        data: error.response?.data,
        params,
        method,
        url
      };
      throw wrappedError;
    }
  }

  async getVariantByShopifyVariantId(shopifyVariantId) {
    const response = await this.request({
      method: "GET",
      url: `/api/v2/products/variant-by-shopify-id/${shopifyVariantId}.json`
    });

    if (!response.variant) {
      throw new Error(
        `Variant not found for shopify variant id: ${shopifyVariantId}`
      );
    }

    return response.variant;
  }

  async getProductById(productId) {
    const response = await this.request({
      method: "GET",
      url: `/api/v2/products/${productId}.json`
    });

    if (!response.product) {
      throw new Error(`Product not found: ${productId}`);
    }

    return response.product;
  }

  async getSellerById(sellerId) {
    const response = await this.request({
      method: "GET",
      url: `/api/v2/sellers/${sellerId}.json`
    });

    if (!response.seller) {
      throw new Error(`Seller not found: ${sellerId}`);
    }

    return response.seller;
  }

  async getSellerPrimaryLocation(sellerId) {
    let response = null;
    try {
      response = await this.request({
        method: "GET",
        url: `/api/v2/sellers/${sellerId}/locations.json`,
        params: {
          limit: 250,
          filter: JSON.stringify({ primary: "true" })
        }
      });
    } catch (error) {
      const status = error.details?.status;
      if (status !== 404 && status !== 422) {
        throw error;
      }
    }

    const candidates = [];
    this._appendLocationCandidates(candidates, response);

    // Some stores return null for primary filter even when locations exist.
    if (candidates.length === 0) {
      try {
        const allLocationResponse = await this.request({
          method: "GET",
          url: `/api/v2/sellers/${sellerId}/locations.json`,
          params: {
            limit: 250
          }
        });
        this._appendLocationCandidates(candidates, allLocationResponse);
      } catch (error) {
        const status = error.details?.status;
        if (status !== 404 && status !== 422) {
          throw error;
        }
      }
    }

    if (candidates.length === 0) {
      return null;
    }

    const primary = candidates.find((entry) => {
      return (
        truthy(entry.primary) ||
        truthy(entry.seller_default_location) ||
        truthy(entry.is_primary)
      );
    });

    return primary || candidates[0];
  }

  _appendLocationCandidates(candidates, response) {
    if (
      response?.location &&
      typeof response.location === "object" &&
      !Array.isArray(response.location)
    ) {
      candidates.push(response.location);
    }

    if (Array.isArray(response?.location)) {
      candidates.push(...response.location);
    }

    if (Array.isArray(response?.locations)) {
      candidates.push(...response.locations);
    }
  }

  async resolveVariantToSeller(shopifyVariantId) {
    const variant = await this.getVariantByShopifyVariantId(shopifyVariantId);
    const productId = variant.product_id;
    if (!productId) {
      throw new Error(
        `Missing product_id in Webkul variant for shopify variant id ${shopifyVariantId}`
      );
    }

    const product = await this.getProductById(productId);
    if (!product.seller_id) {
      throw new Error(`Missing seller_id in Webkul product ${product.id}`);
    }

    const dimensions = this._parseVariantDimensions(variant.dimension);

    return {
      shopifyVariantId: String(shopifyVariantId),
      webkulVariantId: String(variant.id || ""),
      webkulProductId: String(product.id || productId),
      sellerId: String(product.seller_id),
      variantWeight: this._toNumber(variant.weight),
      lengthCm: dimensions.lengthCm,
      widthCm: dimensions.widthCm,
      heightCm: dimensions.heightCm,
      source: "webkul"
    };
  }

  _toNumber(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
  }

  _parseVariantDimensions(rawDimension) {
    if (!rawDimension) {
      return { lengthCm: 0, widthCm: 0, heightCm: 0 };
    }

    let parsed = rawDimension;
    if (typeof rawDimension === "string") {
      try {
        parsed = JSON.parse(rawDimension);
      } catch (error) {
        parsed = null;
      }
    }

    if (!parsed || typeof parsed !== "object") {
      return { lengthCm: 0, widthCm: 0, heightCm: 0 };
    }

    return {
      lengthCm: this._toNumber(parsed.length),
      widthCm: this._toNumber(parsed.width),
      heightCm: this._toNumber(parsed.height)
    };
  }

  async resolveSellerOrigin(sellerId) {
    const location = await this.getSellerPrimaryLocation(sellerId).catch(() => null);

    if (location) {
      const postalCode = normalizePostalCode(location.zipcode, {
        length: this.postalCodeLength
      });

      if (postalCode) {
        return {
          sellerId: String(sellerId),
          postalCode,
          city: location.city || "",
          state: location.state || "",
          country: location.country || "ID",
          address1: location.address || location.street || "",
          latitude: location.latitude || "",
          longitude: location.longitude || "",
          source: "webkul_location"
        };
      }
    }

    const seller = await this.getSellerById(sellerId);
    const postalCode = normalizePostalCode(seller.zipcode, {
      length: this.postalCodeLength
    });

    if (!postalCode) {
      throw new Error(`Seller ${sellerId} does not have zipcode in Webkul`);
    }

    return {
      sellerId: String(sellerId),
      postalCode,
      city: seller.city || "",
      state: seller.id_state?.iso_code || "",
      country: seller.id_country?.iso_code || "ID",
      address1: seller.store_address || "",
      latitude: "",
      longitude: "",
      source: "webkul_seller"
    };
  }
}

module.exports = {
  WebkulClient
};
