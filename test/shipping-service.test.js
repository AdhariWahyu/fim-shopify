const test = require("node:test");
const assert = require("node:assert/strict");

const { ShippingService } = require("../src/services/shipping-service");
const { MemoryCache } = require("../src/services/memory-cache");

function createBaseConfig() {
  return {
    shopify: {
      phoneRequired: true
    },
    biteship: {
      couriers: ["jne", "sicepat", "jnt"]
    },
    shipping: {
      postalCodeLength: 5,
      defaultItemWeightGrams: 1000,
      serviceNamePrefix: "Marketplace",
      handlingFeeIdr: 0,
      freeThresholdIdr: 0,
      maxRates: 5,
      currency: "IDR",
      defaultOriginPostalCode: ""
    },
    cache: {
      variantTtlSeconds: 3600,
      sellerTtlSeconds: 3600,
      rateTtlSeconds: 300
    }
  };
}

function createService({ biteshipGetRates }) {
  const config = createBaseConfig();

  const webkulClient = {
    async resolveVariantToSeller(variantId) {
      if (String(variantId) === "1001") {
        return {
          shopifyVariantId: "1001",
          sellerId: "501"
        };
      }

      return {
        shopifyVariantId: "1002",
        sellerId: "502"
      };
    },
    async resolveSellerOrigin(sellerId) {
      if (String(sellerId) === "501") {
        return {
          sellerId: "501",
          postalCode: "10110"
        };
      }

      return {
        sellerId: "502",
        postalCode: "60291"
      };
    }
  };

  const biteshipClient = {
    getRates: biteshipGetRates
  };

  const noOpLogger = {
    debug() {},
    info() {},
    warn() {},
    error() {}
  };

  return new ShippingService({
    config,
    logger: noOpLogger,
    webkulClient,
    biteshipClient,
    variantCache: new MemoryCache({ ttlSeconds: 3600, maxEntries: 100 }),
    sellerCache: new MemoryCache({ ttlSeconds: 3600, maxEntries: 100 }),
    rateCache: new MemoryCache({ ttlSeconds: 300, maxEntries: 100 }),
    sellerOriginStore: {
      get() {
        return null;
      },
      upsert() {}
    }
  });
}

test("aggregates common courier services across seller groups", async () => {
  const service = createService({
    async biteshipGetRates({ originPostalCode }) {
      if (originPostalCode === "10110") {
        return [
          {
            courierName: "JNE",
            courierCode: "jne",
            serviceName: "REG",
            serviceCode: "reg",
            price: 22000,
            minDay: 2,
            maxDay: 3
          },
          {
            courierName: "SiCepat",
            courierCode: "sicepat",
            serviceName: "BEST",
            serviceCode: "best",
            price: 19000,
            minDay: 1,
            maxDay: 2
          }
        ];
      }

      return [
        {
          courierName: "JNE",
          courierCode: "jne",
          serviceName: "REG",
          serviceCode: "reg",
          price: 18000,
          minDay: 2,
          maxDay: 4
        },
        {
          courierName: "SiCepat",
          courierCode: "sicepat",
          serviceName: "BEST",
          serviceCode: "best",
          price: 25000,
          minDay: 2,
          maxDay: 2
        }
      ];
    }
  });

  const payload = {
    destination: {
      postal_code: "40111"
    },
    currency: "IDR",
    items: [
      {
        variant_id: 1001,
        quantity: 1,
        grams: 300,
        price: 15000000,
        requires_shipping: true,
        name: "Item 1"
      },
      {
        variant_id: 1002,
        quantity: 1,
        grams: 500,
        price: 20000000,
        requires_shipping: true,
        name: "Item 2"
      }
    ]
  };

  const result = await service.calculate(payload);

  assert.equal(result.rates.length, 2);
  assert.equal(result.rates[0].service_code, "BSH_JNE_REG");
  assert.equal(result.rates[0].total_price, "4000000");
  assert.equal(result.rates[1].service_code, "BSH_SICEPAT_BEST");
  assert.equal(result.rates[1].total_price, "4400000");
});

test("returns fallback mixed-cheapest rate when no common service", async () => {
  const service = createService({
    async biteshipGetRates({ originPostalCode }) {
      if (originPostalCode === "10110") {
        return [
          {
            courierName: "JNE",
            courierCode: "jne",
            serviceName: "REG",
            serviceCode: "reg",
            price: 22000,
            minDay: 2,
            maxDay: 3
          }
        ];
      }

      return [
        {
          courierName: "IDExpress",
          courierCode: "idexpress",
          serviceName: "STD",
          serviceCode: "std",
          price: 15000,
          minDay: 1,
          maxDay: 2
        }
      ];
    }
  });

  const payload = {
    destination: {
      postal_code: "40111"
    },
    currency: "IDR",
    items: [
      {
        variant_id: 1001,
        quantity: 1,
        grams: 300,
        price: 15000000,
        requires_shipping: true,
        name: "Item 1"
      },
      {
        variant_id: 1002,
        quantity: 1,
        grams: 500,
        price: 20000000,
        requires_shipping: true,
        name: "Item 2"
      }
    ]
  };

  const result = await service.calculate(payload);

  assert.equal(result.rates.length, 1);
  assert.equal(result.rates[0].service_code, "BSH_MULTI_CHEAPEST");
  assert.equal(result.rates[0].total_price, "3700000");
});
