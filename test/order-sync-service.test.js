const test = require("node:test");
const assert = require("node:assert/strict");

const { OrderSyncService } = require("../src/services/order-sync-service");
const { MemoryCache } = require("../src/services/memory-cache");

function createService() {
  return new OrderSyncService({
    config: {
      cache: {
        variantTtlSeconds: 3600,
        sellerTtlSeconds: 3600
      },
      shipping: {
        defaultOriginPostalCode: "",
        postalCodeLength: 5,
        defaultItemWeightGrams: 1000
      },
      biteship: {
        couriers: ["jne", "sicepat"]
      },
      order: {
        defaultDeliveryType: "now",
        maxDashboardOrders: 20,
        autoFulfillOnCreate: false,
        notifyCustomerOnFulfill: false
      }
    },
    logger: {
      info() {},
      warn() {},
      error() {}
    },
    webkulClient: {
      async resolveVariantToSeller() {
        return null;
      },
      async resolveSellerOrigin() {
        return null;
      },
      async getSellerById() {
        return null;
      }
    },
    biteshipClient: {
      async getRates() {
        return [];
      },
      async createOrder() {
        return {};
      }
    },
    shopifyAdminClient: {
      isConfigured() {
        return false;
      }
    },
    variantCache: new MemoryCache({ ttlSeconds: 3600, maxEntries: 100 }),
    sellerCache: new MemoryCache({ ttlSeconds: 3600, maxEntries: 100 }),
    sellerOriginStore: {
      get() {
        return null;
      },
      upsert() {}
    },
    orderSyncStore: {
      get() {
        return null;
      },
      saveRecord() {
        return null;
      }
    }
  });
}

test("parses service code for non-mixed Biteship shipping line", () => {
  const service = createService();
  const parsed = service._parseCourierFromServiceCode("BSH_JNE_REG");

  assert.deepEqual(parsed, {
    isMixedFallback: false,
    courierCompany: "jne",
    courierType: "reg"
  });
});

test("parses mixed fallback service code", () => {
  const service = createService();
  const parsed = service._parseCourierFromServiceCode("BSH_MULTI_CHEAPEST");

  assert.deepEqual(parsed, {
    isMixedFallback: true,
    courierCompany: "",
    courierType: ""
  });
});

test("allocates fulfillment quantities across fulfillment orders", () => {
  const service = createService();
  const allocator = service._buildFulfillmentAllocator([
    {
      id: 111,
      line_items: [
        {
          id: 11,
          line_item_id: 1001,
          fulfillable_quantity: 1
        }
      ]
    },
    {
      id: 222,
      line_items: [
        {
          id: 22,
          line_item_id: 1002,
          fulfillable_quantity: 2
        }
      ]
    }
  ]);

  const allocation = allocator.allocate([
    { lineItemId: "1001", quantity: 1 },
    { lineItemId: "1002", quantity: 1 }
  ]);

  assert.equal(allocation.unallocated.length, 0);
  assert.equal(allocation.lineItemsByFulfillmentOrder.length, 2);
});
