const test = require("node:test");
const assert = require("node:assert/strict");

const { BiteshipClient } = require("../src/services/biteship-client");

function createClient() {
  return new BiteshipClient({
    baseUrl: "https://api.biteship.com",
    apiKey: "biteship_test_xxx",
    couriers: ["jne"],
    timeoutMs: 1000,
    maxRetries: 0,
    retryDelayMs: 10,
    logger: {
      warn() {},
      error() {}
    }
  });
}

test("normalizes duration from shipment_duration_range", () => {
  const client = createClient();
  const result = client._normalizeRate({
    courier_name: "JNE",
    courier_code: "jne",
    courier_service_name: "Reguler",
    courier_service_code: "reg",
    price: 10000,
    shipment_duration_range: "1 - 2",
    shipment_duration_unit: "days"
  });

  assert.equal(result.minDay, 1);
  assert.equal(result.maxDay, 2);
});

test("normalizes duration from direct min_day/max_day", () => {
  const client = createClient();
  const result = client._normalizeRate({
    courier_name: "JNE",
    courier_code: "jne",
    courier_service_name: "Reguler",
    courier_service_code: "reg",
    shipping_fee: 12500,
    min_day: 2,
    max_day: 3
  });

  assert.equal(result.price, 12500);
  assert.equal(result.minDay, 2);
  assert.equal(result.maxDay, 3);
});

test("normalizes hour-based duration to fractional day", () => {
  const client = createClient();
  const result = client._normalizeRate({
    courier_name: "GOJEK",
    courier_code: "gojek",
    courier_service_name: "Instant",
    courier_service_code: "instant",
    price: 21000,
    shipment_duration_range: "1 - 2",
    shipment_duration_unit: "hours"
  });

  assert.equal(result.minDay, 1 / 24);
  assert.equal(result.maxDay, 2 / 24);
});
