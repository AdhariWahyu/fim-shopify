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

class BiteshipClient {
  constructor(options) {
    this.apiKey = options.apiKey;
    this.couriers = options.couriers;
    this.timeoutMs = options.timeoutMs;
    this.maxRetries = Number.isInteger(options.maxRetries)
      ? options.maxRetries
      : 3;
    this.retryDelayMs = Number.isInteger(options.retryDelayMs)
      ? options.retryDelayMs
      : 300;
    this.logger = options.logger;

    this.http = axios.create({
      baseURL: options.baseUrl,
      timeout: this.timeoutMs,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: this.apiKey
      }
    });
  }

  _normalizeRate(item) {
    const { minDay, maxDay } = this._extractDurationDays(item);

    return {
      courierName: item.courier_name || item.courierName || "Unknown",
      courierCode: (item.courier_code || item.courierCode || "unknown").toLowerCase(),
      serviceName: item.courier_service_name || item.courierServiceName || "Service",
      serviceCode: (item.courier_service_code || item.courierServiceCode || "service").toLowerCase(),
      type: item.type || "",
      price: Number(item.price || item.shipping_fee || 0),
      minDay,
      maxDay,
      description: item.description || item.shipment_duration_range || ""
    };
  }

  _extractDurationDays(item) {
    const directMin = Number(item.min_day || item.minDay || 0);
    const directMax = Number(item.max_day || item.maxDay || 0);
    if (directMin > 0 || directMax > 0) {
      return {
        minDay: directMin > 0 ? directMin : directMax,
        maxDay: directMax > 0 ? directMax : directMin
      };
    }

    const unitFactor = this._durationUnitFactor(item);
    const durationRange = String(
      item.shipment_duration_range || item.duration || ""
    ).trim();

    if (!durationRange) {
      return { minDay: 0, maxDay: 0 };
    }

    const numbers = durationRange.match(/\d+/g);
    if (!numbers || numbers.length === 0) {
      return { minDay: 0, maxDay: 0 };
    }

    if (numbers.length === 1) {
      const day = Number(numbers[0]) || 0;
      return { minDay: day * unitFactor, maxDay: day * unitFactor };
    }

    const minDay = Number(numbers[0]) || 0;
    const maxDay = Number(numbers[1]) || 0;

    return {
      minDay: minDay * unitFactor,
      maxDay: (maxDay || minDay) * unitFactor
    };
  }

  _durationUnitFactor(item) {
    const fromField = String(item.shipment_duration_unit || "").toLowerCase();
    const fromDuration = String(item.duration || "").toLowerCase();
    const unit = fromField || fromDuration;

    if (unit.includes("hour")) {
      return 1 / 24;
    }
    if (unit.includes("minute")) {
      return 1 / (24 * 60);
    }
    return 1;
  }

  async getRates(
    {
      originPostalCode,
      destinationPostalCode,
      originLatitude,
      originLongitude,
      destinationLatitude,
      destinationLongitude,
      items,
      couriers
    },
    attempt = 0
  ) {
    const payload = {
      couriers: couriers || this.couriers.join(","),
      items
    };

    if (originPostalCode) {
      payload.origin_postal_code = originPostalCode;
    }
    if (destinationPostalCode) {
      payload.destination_postal_code = destinationPostalCode;
    }
    if (originLatitude !== undefined && originLatitude !== null && originLatitude !== "") {
      payload.origin_latitude = originLatitude;
    }
    if (originLongitude !== undefined && originLongitude !== null && originLongitude !== "") {
      payload.origin_longitude = originLongitude;
    }
    if (
      destinationLatitude !== undefined &&
      destinationLatitude !== null &&
      destinationLatitude !== ""
    ) {
      payload.destination_latitude = destinationLatitude;
    }
    if (
      destinationLongitude !== undefined &&
      destinationLongitude !== null &&
      destinationLongitude !== ""
    ) {
      payload.destination_longitude = destinationLongitude;
    }

    try {
      const response = await this.http.post("/v1/rates/couriers", payload);
      const data = response.data || {};
      const pricing = Array.isArray(data.pricing)
        ? data.pricing
        : Array.isArray(data.rates)
          ? data.rates
          : [];

      return pricing
        .map((item) => this._normalizeRate(item))
        .filter((rate) => rate.price > 0);
    } catch (error) {
      const status = error.response?.status;
      const responseData = error.response?.data;
      const retryAfterHeader = error.response?.headers?.["retry-after"];

      if (
        (status === 429 || status === 408 || status >= 500) &&
        attempt < this.maxRetries
      ) {
        const retryAfterMs =
          parseRetryAfterMs(retryAfterHeader) ||
          this.retryDelayMs * 2 ** attempt;

        this.logger.warn("Retrying Biteship rate request", {
          status,
          attempt,
          retryAfterMs
        });

        await sleep(retryAfterMs);
        return this.getRates(
          {
            originPostalCode,
            destinationPostalCode,
            originLatitude,
            originLongitude,
            destinationLatitude,
            destinationLongitude,
            items,
            couriers
          },
          attempt + 1
        );
      }

      this.logger.error("Biteship rate request failed", {
        status,
        responseData,
        payload
      });

      const wrappedError = new Error("Biteship rate request failed");
      wrappedError.details = {
        status,
        responseData,
        payload
      };
      throw wrappedError;
    }
  }
}

module.exports = {
  BiteshipClient
};
