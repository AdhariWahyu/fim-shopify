const axios = require("axios");

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

class ShopifyAdminClient {
  constructor(options) {
    this.shopDomain = options.shopDomain;
    this.apiVersion = options.apiVersion;
    this.timeoutMs = options.timeoutMs;
    this.adminAccessToken = options.adminAccessToken;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.maxRetries = Number.isInteger(options.maxRetries)
      ? options.maxRetries
      : 2;
    this.retryDelayMs = Number.isInteger(options.retryDelayMs)
      ? options.retryDelayMs
      : 300;
    this.logger = options.logger;

    this.tokenCache = {
      value: "",
      expiresAt: 0
    };

    this.http = axios.create({
      baseURL: this.shopDomain
        ? `https://${this.shopDomain}/admin/api/${this.apiVersion}/`
        : "",
      timeout: this.timeoutMs,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      }
    });
  }

  isConfigured() {
    return Boolean(
      this.shopDomain &&
        (this.adminAccessToken || (this.clientId && this.clientSecret))
    );
  }

  async _fetchClientCredentialsToken() {
    const url = `https://${this.shopDomain}/admin/oauth/access_token`;

    const response = await axios.post(
      url,
      new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.clientId,
        client_secret: this.clientSecret
      }).toString(),
      {
        timeout: this.timeoutMs,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        }
      }
    );

    const payload = response.data || {};
    if (!payload.access_token) {
      throw new Error("Shopify client credentials response missing access_token");
    }

    const expiresInSeconds = Number(payload.expires_in || 0);

    this.tokenCache = {
      value: payload.access_token,
      expiresAt:
        Date.now() +
        Math.max(0, expiresInSeconds > 0 ? expiresInSeconds - 60 : 300) * 1000
    };

    return payload.access_token;
  }

  async _resolveAccessToken() {
    if (this.adminAccessToken) {
      return this.adminAccessToken;
    }

    if (this.tokenCache.value && Date.now() < this.tokenCache.expiresAt) {
      return this.tokenCache.value;
    }

    return this._fetchClientCredentialsToken();
  }

  async request({ method, url, params, data }, attempt = 0) {
    if (!this.isConfigured()) {
      throw new Error(
        "Shopify Admin API client is not configured. Set SHOPIFY_SHOP_DOMAIN and admin token/client credentials"
      );
    }

    try {
      const accessToken = await this._resolveAccessToken();

      const response = await this.http.request({
        method,
        url,
        params,
        data,
        headers: {
          "X-Shopify-Access-Token": accessToken
        }
      });

      return response.data;
    } catch (error) {
      const status = error.response?.status;
      const retryAfterHeader = error.response?.headers?.["retry-after"];
      const shouldRetry =
        (status === 429 || status === 408 || status >= 500) &&
        attempt < this.maxRetries;

      if (shouldRetry) {
        const retryAfterMs =
          parseRetryAfterMs(retryAfterHeader) ||
          this.retryDelayMs * 2 ** attempt;

        this.logger.warn("Retrying Shopify Admin API request", {
          method,
          url,
          status,
          attempt,
          retryAfterMs
        });

        await sleep(retryAfterMs);
        return this.request({ method, url, params, data }, attempt + 1);
      }

      const wrappedError = new Error(
        `Shopify Admin request failed: ${method.toUpperCase()} ${url}`
      );
      wrappedError.details = {
        method,
        url,
        status,
        params,
        data,
        responseData: error.response?.data || null
      };
      throw wrappedError;
    }
  }

  async listOrders({
    limit = 20,
    status = "open",
    fulfillmentStatus = "unfulfilled",
    financialStatus = "paid"
  } = {}) {
    const response = await this.request({
      method: "GET",
      url: "orders.json",
      params: {
        limit,
        status,
        fulfillment_status: fulfillmentStatus,
        financial_status: financialStatus,
        order: "created_at desc"
      }
    });

    return Array.isArray(response?.orders) ? response.orders : [];
  }

  async getOrder(orderId) {
    const response = await this.request({
      method: "GET",
      url: `orders/${orderId}.json`
    });

    if (!response?.order) {
      throw new Error(`Shopify order not found: ${orderId}`);
    }

    return response.order;
  }

  async getFulfillmentOrders(orderId) {
    const response = await this.request({
      method: "GET",
      url: `orders/${orderId}/fulfillment_orders.json`
    });

    return Array.isArray(response?.fulfillment_orders)
      ? response.fulfillment_orders
      : [];
  }

  async createFulfillment(payload) {
    const response = await this.request({
      method: "POST",
      url: "fulfillments.json",
      data: {
        fulfillment: payload
      }
    });

    if (!response?.fulfillment) {
      throw new Error("Shopify fulfillment response missing fulfillment object");
    }

    return response.fulfillment;
  }
}

module.exports = {
  ShopifyAdminClient
};
