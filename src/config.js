const path = require("node:path");
const fs = require("node:fs");

require("dotenv").config();

function intFromEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid integer for ${name}: ${value}`);
  }

  return parsed;
}

function numberFromEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return fallback;
  }

  const parsed = Number.parseFloat(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid number for ${name}: ${value}`);
  }

  return parsed;
}

function boolFromEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return fallback;
  }

  return ["1", "true", "yes", "y", "on"].includes(value.toLowerCase());
}

function listFromEnv(name, fallback) {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function resolveRuntimePath(inputPath, fallback) {
  const resolved = inputPath || fallback;
  const absolutePath = path.isAbsolute(resolved)
    ? resolved
    : path.join(process.cwd(), resolved);

  const directory = path.dirname(absolutePath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }

  return absolutePath;
}

const config = {
  env: process.env.NODE_ENV || "development",
  logLevel: process.env.LOG_LEVEL || "info",
  port: intFromEnv("PORT", 3000),
  shopify: {
    apiSecret: process.env.SHOPIFY_API_SECRET || "",
    useBackupOnError: boolFromEnv("SHOPIFY_USE_BACKUP_ON_ERROR", false),
    phoneRequired: boolFromEnv("SHOPIFY_PHONE_REQUIRED", true),
    apiVersion: process.env.SHOPIFY_API_VERSION || "2025-10",
    timeoutMs: intFromEnv("SHOPIFY_TIMEOUT_MS", 15000),
    shopDomain: process.env.SHOPIFY_SHOP_DOMAIN || "",
    adminAccessToken: process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || "",
    clientId: process.env.SHOPIFY_CLIENT_ID || "",
    clientSecret: process.env.SHOPIFY_CLIENT_SECRET || "",
    carrierServiceName:
      process.env.SHOPIFY_CARRIER_SERVICE_NAME ||
      "Marketplace Dynamic Shipping",
    callbackUrl: process.env.PUBLIC_CALLBACK_URL || ""
  },
  webkul: {
    baseUrl: process.env.WEBKUL_BASE_URL || "https://mvmapi.webkul.com",
    accessToken: process.env.WEBKUL_ACCESS_TOKEN || "",
    refreshToken: process.env.WEBKUL_REFRESH_TOKEN || "",
    timeoutMs: intFromEnv("WEBKUL_TIMEOUT_MS", 10000),
    maxRetries: intFromEnv("WEBKUL_MAX_RETRIES", 4),
    retryDelayMs: intFromEnv("WEBKUL_RETRY_DELAY_MS", 400),
    tokenStorePath: resolveRuntimePath(
      process.env.WEBKUL_TOKEN_STORE_PATH,
      "./data/runtime/webkul-tokens.json"
    )
  },
  biteship: {
    baseUrl: process.env.BITESHIP_BASE_URL || "https://api.biteship.com",
    apiKey: process.env.BITESHIP_API_KEY || "",
    couriers: listFromEnv("BITESHIP_COURIERS", ["jne", "sicepat", "jnt"]),
    timeoutMs: intFromEnv("BITESHIP_TIMEOUT_MS", 10000),
    maxRetries: intFromEnv("BITESHIP_MAX_RETRIES", 3),
    retryDelayMs: intFromEnv("BITESHIP_RETRY_DELAY_MS", 300)
  },
  shipping: {
    currency: process.env.SHIPPING_CURRENCY || "IDR",
    serviceNamePrefix:
      process.env.SHIPPING_SERVICE_NAME_PREFIX || "Marketplace",
    maxRates: intFromEnv("SHIPPING_MAX_RATES", 5),
    handlingFeeIdr: numberFromEnv("SHIPPING_HANDLING_FEE_IDR", 0),
    freeThresholdIdr: numberFromEnv("SHIPPING_FREE_THRESHOLD_IDR", 0),
    defaultItemWeightGrams: intFromEnv("SHIPPING_DEFAULT_ITEM_WEIGHT_GRAMS", 1000),
    defaultOriginPostalCode: process.env.DEFAULT_ORIGIN_POSTAL_CODE || "",
    postalCodeLength: intFromEnv("POSTAL_CODE_LENGTH", 5)
  },
  cache: {
    variantTtlSeconds: intFromEnv("VARIANT_CACHE_TTL_SECONDS", 43200),
    sellerTtlSeconds: intFromEnv("SELLER_CACHE_TTL_SECONDS", 43200),
    rateTtlSeconds: intFromEnv("RATE_CACHE_TTL_SECONDS", 840),
    maxEntries: intFromEnv("RATE_CACHE_MAX_ENTRIES", 3000)
  },
  order: {
    enabled: boolFromEnv("BITESHIP_ORDER_FEATURE_ENABLED", true),
    autoCreateOnPaid: boolFromEnv("BITESHIP_ORDER_AUTO_CREATE_ON_PAID", false),
    autoFulfillOnCreate: boolFromEnv("BITESHIP_ORDER_AUTO_FULFILL_ON_CREATE", false),
    notifyCustomerOnFulfill: boolFromEnv(
      "SHOPIFY_NOTIFY_CUSTOMER_ON_FULFILLMENT",
      false
    ),
    maxDashboardOrders: intFromEnv("DASHBOARD_MAX_ORDERS", 25),
    defaultDeliveryType: process.env.BITESHIP_ORDER_DELIVERY_TYPE || "now"
  },
  observability: {
    rateLogMaxEntries: intFromEnv("RATE_LOG_MAX_ENTRIES", 500)
  },
  startup: {
    autoRegisterCarrierService: boolFromEnv(
      "AUTO_REGISTER_CARRIER_ON_STARTUP",
      true
    ),
    failOnCarrierRegisterError: boolFromEnv(
      "FAIL_STARTUP_ON_CARRIER_REGISTER_ERROR",
      false
    )
  },
  auth: {
    flowWebhookToken: process.env.FLOW_WEBHOOK_TOKEN || "",
    adminApiKey: process.env.ADMIN_API_KEY || ""
  },
  store: {
    sellerOriginStorePath: resolveRuntimePath(
      process.env.SELLER_ORIGIN_STORE_PATH,
      "./data/runtime/seller-origins.json"
    ),
    orderSyncStorePath: resolveRuntimePath(
      process.env.ORDER_SYNC_STORE_PATH,
      "./data/runtime/order-sync.json"
    ),
    rateLogStorePath: resolveRuntimePath(
      process.env.RATE_LOG_STORE_PATH,
      "./data/runtime/rate-logs.json"
    )
  }
};

function validateRuntimeConfig() {
  const required = [
    ["WEBKUL_ACCESS_TOKEN", config.webkul.accessToken],
    ["WEBKUL_REFRESH_TOKEN", config.webkul.refreshToken],
    ["BITESHIP_API_KEY", config.biteship.apiKey]
  ];

  const missing = required.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}. See .env.example`
    );
  }
}

module.exports = {
  config,
  validateRuntimeConfig
};
