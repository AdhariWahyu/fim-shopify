const crypto = require("node:crypto");
const express = require("express");

const { MemoryCache } = require("./services/memory-cache");
const { SellerOriginStore } = require("./services/seller-origin-store");
const { WebkulClient } = require("./services/webkul-client");
const { BiteshipClient } = require("./services/biteship-client");
const { ShippingService } = require("./services/shipping-service");
const { normalizePostalCode } = require("./utils/location");

function safeCompareBase64(left, right) {
  const leftBuffer = Buffer.from(left || "", "utf8");
  const rightBuffer = Buffer.from(right || "", "utf8");

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyShopifyHmac(rawBodyBuffer, providedHmac, secret) {
  if (!secret) {
    return true;
  }

  if (!providedHmac) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBodyBuffer)
    .digest("base64");

  return safeCompareBase64(expected, providedHmac);
}

function buildFlowPayload(body, postalCodeLength) {
  const sellerId =
    body?.seller_id ||
    body?.sellerId ||
    body?.id ||
    body?.metaobject?.seller_id ||
    body?.metaobject?.sellerId ||
    body?.metaobject?.webkulSellerId ||
    body?.metaobject?.system?.id;

  const postalCode = normalizePostalCode(
    body?.postal_code ||
      body?.postalCode ||
      body?.zipcode ||
      body?.zip ||
      body?.metaobject?.postalCode ||
      body?.metaobject?.zipcode ||
      body?.metaobject?.zip ||
      body?.metaobject?.postal_code,
    { length: postalCodeLength }
  );

  return {
    sellerId: sellerId ? String(sellerId) : "",
    sellerEmail:
      body?.sellerEmail ||
      body?.email ||
      body?.metaobject?.sellerEmail ||
      body?.metaobject?.email ||
      "",
    contact:
      body?.contact ||
      body?.phone ||
      body?.metaobject?.contact ||
      body?.metaobject?.phone ||
      "",
    storeName:
      body?.spStoreName ||
      body?.storeName ||
      body?.metaobject?.spStoreName ||
      body?.metaobject?.storeName ||
      "",
    storeNameHandle:
      body?.storeNameHandle ||
      body?.metaobject?.storeNameHandle ||
      body?.metaobject?.store_name_handle ||
      "",
    shopDomain:
      body?.spShopName ||
      body?.shopDomain ||
      body?.metaobject?.spShopName ||
      body?.metaobject?.shopDomain ||
      "",
    postalCode,
    city: body?.city || body?.metaobject?.city || "",
    state:
      body?.state ||
      body?.province ||
      body?.metaobject?.state ||
      body?.metaobject?.province ||
      "",
    country: body?.country || body?.countryCode || body?.metaobject?.country || "ID",
    address1:
      body?.address1 ||
      body?.store_address ||
      body?.storeAddress ||
      body?.metaobject?.storeAddress ||
      body?.metaobject?.store_address ||
      "",
    latitude: body?.latitude || body?.metaobject?.latitude || "",
    longitude: body?.longitude || body?.metaobject?.longitude || "",
    source: "flow_webhook"
  };
}

function createApp({ config, logger }) {
  const app = express();
  app.disable("x-powered-by");

  app.use(
    express.json({
      limit: "1mb",
      verify(req, res, buffer) {
        req.rawBody = buffer;
      }
    })
  );

  const variantCache = new MemoryCache({
    ttlSeconds: config.cache.variantTtlSeconds,
    maxEntries: config.cache.maxEntries
  });

  const sellerCache = new MemoryCache({
    ttlSeconds: config.cache.sellerTtlSeconds,
    maxEntries: config.cache.maxEntries
  });

  const rateCache = new MemoryCache({
    ttlSeconds: config.cache.rateTtlSeconds,
    maxEntries: config.cache.maxEntries
  });

  const sellerOriginStore = new SellerOriginStore(
    config.store.sellerOriginStorePath,
    logger
  );

  const webkulClient = new WebkulClient({
    ...config.webkul,
    postalCodeLength: config.shipping.postalCodeLength,
    logger
  });

  const biteshipClient = new BiteshipClient({
    ...config.biteship,
    logger
  });

  const shippingService = new ShippingService({
    config,
    logger,
    webkulClient,
    biteshipClient,
    variantCache,
    sellerCache,
    rateCache,
    sellerOriginStore
  });

  function adminAuthorized(req) {
    if (!config.auth.adminApiKey) {
      return true;
    }

    const adminKey = req.get("x-admin-key") || "";
    return adminKey === config.auth.adminApiKey;
  }

  function flowAuthorized(req) {
    if (!config.auth.flowWebhookToken) {
      return true;
    }

    const token = req.get("x-flow-token") || req.query.token || "";
    return token === config.auth.flowWebhookToken;
  }

  async function ensureSellerId(payload) {
    if (payload.sellerId) {
      return payload;
    }

    try {
      const resolvedSellerId = await webkulClient.resolveSellerIdByHints(payload);
      if (resolvedSellerId) {
        payload.sellerId = String(resolvedSellerId);
      }
    } catch (error) {
      logger.warn("Failed to resolve seller ID from Flow hints", {
        error: error.message,
        hints: {
          storeName: payload.storeName,
          storeNameHandle: payload.storeNameHandle,
          contact: payload.contact,
          sellerEmail: payload.sellerEmail
        }
      });
    }

    return payload;
  }

  app.get("/health", (req, res) => {
    res.json({
      ok: true,
      service: "shopify-webkul-biteship-ccs",
      time: new Date().toISOString(),
      cache: {
        variant: variantCache.size(),
        seller: sellerCache.size(),
        rate: rateCache.size()
      }
    });
  });

  app.post("/webhooks/shopify/carrier-service", async (req, res) => {
    const providedHmac = req.get("x-shopify-hmac-sha256");
    const verified = verifyShopifyHmac(
      req.rawBody || Buffer.from(""),
      providedHmac,
      config.shopify.apiSecret
    );

    if (!verified) {
      logger.warn("Rejected carrier-service callback due to invalid HMAC");
      return res.status(401).json({ error: "invalid_hmac" });
    }

    const start = Date.now();

    try {
      const rateRequest = req.body?.rate || req.body;
      const result = await shippingService.calculate(rateRequest);

      logger.info("Carrier-service callback processed", {
        tookMs: Date.now() - start,
        rateCount: result.rates.length,
        debug: result.debug
      });

      return res.status(200).json({ rates: result.rates });
    } catch (error) {
      logger.error("Carrier-service callback failed", {
        tookMs: Date.now() - start,
        error: error.message,
        details: error.details
      });

      if (config.shopify.useBackupOnError) {
        return res.status(500).json({ error: "carrier_service_failed" });
      }

      return res.status(200).json({ rates: [] });
    }
  });

  app.post("/webhooks/shopify/flow/seller-origin", async (req, res) => {
    if (!flowAuthorized(req)) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const payload = buildFlowPayload(req.body || {}, config.shipping.postalCodeLength);
    await ensureSellerId(payload);

    if (!payload.sellerId || !payload.postalCode) {
      return res.status(422).json({
        error: "sellerId and postalCode are required",
        acceptedFields: {
          sellerId: [
            "seller_id",
            "sellerId",
            "metaobject.sellerId",
            "metaobject.webkulSellerId"
          ],
          postalCode: [
            "postal_code",
            "postalCode",
            "zipcode",
            "metaobject.zipcode"
          ],
          sellerHints: [
            "storeName / metaobject.spStoreName",
            "storeNameHandle / metaobject.storeNameHandle",
            "email / metaobject.email",
            "contact / metaobject.contact"
          ]
        }
      });
    }

    sellerOriginStore.upsert(payload);
    sellerCache.set(payload.sellerId, payload, config.cache.sellerTtlSeconds);

    return res.status(200).json({
      ok: true,
      data: payload
    });
  });

  app.get("/admin/seller-origins", (req, res) => {
    if (!adminAuthorized(req)) {
      return res.status(401).json({ error: "unauthorized" });
    }

    return res.json({
      data: sellerOriginStore.all()
    });
  });

  app.post("/admin/seller-origins", async (req, res) => {
    if (!adminAuthorized(req)) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const payload = buildFlowPayload(req.body || {}, config.shipping.postalCodeLength);
    await ensureSellerId(payload);

    if (!payload.sellerId || !payload.postalCode) {
      return res.status(422).json({
        error: "sellerId and postalCode are required"
      });
    }

    payload.source = "admin_api";
    sellerOriginStore.upsert(payload);
    sellerCache.set(payload.sellerId, payload, config.cache.sellerTtlSeconds);

    return res.json({ ok: true, data: payload });
  });

  app.post("/debug/quote", async (req, res) => {
    if (!adminAuthorized(req)) {
      return res.status(401).json({ error: "unauthorized" });
    }

    try {
      const rateRequest = req.body?.rate || req.body;
      const result = await shippingService.calculate(rateRequest);
      return res.json(result);
    } catch (error) {
      return res.status(500).json({
        error: error.message,
        details: error.details || null
      });
    }
  });

  app.get("/debug/cache", (req, res) => {
    if (!adminAuthorized(req)) {
      return res.status(401).json({ error: "unauthorized" });
    }

    return res.json({
      cache: {
        variant: variantCache.size(),
        seller: sellerCache.size(),
        rate: rateCache.size()
      }
    });
  });

  app.use((req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  return app;
}

module.exports = {
  createApp
};
