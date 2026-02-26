const { normalizePostalCode, truthy } = require("../utils/location");

function toFiniteNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function toPositiveInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function stripEmpty(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => stripEmpty(entry))
      .filter((entry) => entry !== undefined);
  }

  if (value && typeof value === "object") {
    const next = {};
    for (const [key, entry] of Object.entries(value)) {
      const cleaned = stripEmpty(entry);
      if (cleaned === undefined) {
        continue;
      }

      next[key] = cleaned;
    }

    return Object.keys(next).length > 0 ? next : undefined;
  }

  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  return value;
}

class OrderSyncService {
  constructor(options) {
    this.config = options.config;
    this.logger = options.logger;
    this.webkulClient = options.webkulClient;
    this.biteshipClient = options.biteshipClient;
    this.shopifyAdminClient = options.shopifyAdminClient;
    this.variantCache = options.variantCache;
    this.sellerCache = options.sellerCache;
    this.sellerOriginStore = options.sellerOriginStore;
    this.orderSyncStore = options.orderSyncStore;
  }

  _normalizeVariantId(item) {
    const variantId = item?.variant_id ?? item?.variantId;
    if (variantId === undefined || variantId === null || variantId === "") {
      return "";
    }

    return String(variantId);
  }

  _extractFulfillableQty(item) {
    const fulfillable = toPositiveInt(item?.fulfillable_quantity, 0);
    if (fulfillable > 0) {
      return fulfillable;
    }

    return toPositiveInt(item?.quantity, 0);
  }

  _isShippableLineItem(item) {
    if (!item) {
      return false;
    }

    if (item.requires_shipping === undefined || item.requires_shipping === null) {
      return this._extractFulfillableQty(item) > 0;
    }

    return truthy(item.requires_shipping) && this._extractFulfillableQty(item) > 0;
  }

  _parseCourierFromServiceCode(code) {
    const normalizedCode = String(code || "").trim().toUpperCase();
    if (!normalizedCode.startsWith("BSH_")) {
      return null;
    }

    if (normalizedCode === "BSH_MULTI_CHEAPEST") {
      return {
        isMixedFallback: true,
        courierCompany: "",
        courierType: ""
      };
    }

    const withoutPrefix = normalizedCode.slice(4);
    const separatorIndex = withoutPrefix.indexOf("_");
    if (separatorIndex < 1 || separatorIndex >= withoutPrefix.length - 1) {
      return null;
    }

    return {
      isMixedFallback: false,
      courierCompany: withoutPrefix.slice(0, separatorIndex).toLowerCase(),
      courierType: withoutPrefix.slice(separatorIndex + 1).toLowerCase()
    };
  }

  _resolveShippingSelection(order, override = {}) {
    const overrideCourierCompany = String(override.courierCompany || "").trim();
    const overrideCourierType = String(override.courierType || "").trim();

    if (overrideCourierCompany && overrideCourierType) {
      return {
        source: "manual_override",
        title: "Manual override",
        serviceCode: "",
        courierCompany: overrideCourierCompany.toLowerCase(),
        courierType: overrideCourierType.toLowerCase(),
        isMixedFallback: false
      };
    }

    const shippingLines = Array.isArray(order?.shipping_lines)
      ? order.shipping_lines
      : [];

    for (const line of shippingLines) {
      const rawCode = line?.code || line?.source || line?.carrier_identifier || "";
      const parsed = this._parseCourierFromServiceCode(rawCode);
      if (!parsed) {
        continue;
      }

      return {
        source: "shopify_shipping_line",
        title: line?.title || "",
        serviceCode: String(rawCode),
        courierCompany: parsed.courierCompany,
        courierType: parsed.courierType,
        isMixedFallback: parsed.isMixedFallback
      };
    }

    return {
      source: "none",
      title: "",
      serviceCode: "",
      courierCompany: "",
      courierType: "",
      isMixedFallback: false
    };
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

        this.logger.warn("Using default origin postal code for order sync", {
          sellerId: sellerKey,
          fallbackPostalCode,
          error: error.message
        });

        return fallback;
      }

      throw error;
    }
  }

  async _resolveSellerIdentity(sellerId, origin) {
    const fallbackName = origin?.storeName || `Seller ${sellerId}`;
    const fallbackPhone = origin?.contact || "";
    const fallbackEmail = origin?.sellerEmail || "";

    if (fallbackName && fallbackPhone) {
      return {
        name: fallbackName,
        phone: fallbackPhone,
        email: fallbackEmail
      };
    }

    try {
      const seller = await this.webkulClient.getSellerById(sellerId);
      return {
        name: origin?.storeName || seller?.sp_store_name || fallbackName,
        phone: origin?.contact || seller?.contact || fallbackPhone,
        email: origin?.sellerEmail || seller?.email || fallbackEmail
      };
    } catch (error) {
      this.logger.warn("Failed to resolve seller identity for Biteship order", {
        sellerId,
        error: error.message
      });

      return {
        name: fallbackName,
        phone: fallbackPhone,
        email: fallbackEmail
      };
    }
  }

  _buildBiteshipItem(lineItem, variantMapping) {
    const quantity = this._extractFulfillableQty(lineItem);
    const grams =
      Math.max(0, toPositiveInt(lineItem?.grams, 0)) ||
      Math.max(0, toPositiveInt(variantMapping?.variantWeight, 0)) ||
      this.config.shipping.defaultItemWeightGrams;

    const unitValue = Math.max(1, Math.round(Number(lineItem?.price || 0) || 0));

    const payload = {
      name: lineItem?.name || lineItem?.title || lineItem?.sku || "Product",
      description: lineItem?.sku || lineItem?.vendor || "",
      value: unitValue,
      quantity,
      weight: grams,
      length: Number(variantMapping?.lengthCm || 0) || undefined,
      width: Number(variantMapping?.widthCm || 0) || undefined,
      height: Number(variantMapping?.heightCm || 0) || undefined
    };

    return stripEmpty(payload);
  }

  _buildAddress(address) {
    const parts = [
      address?.address1,
      address?.address2,
      address?.district,
      address?.city,
      address?.province,
      address?.country
    ]
      .map((entry) => String(entry || "").trim())
      .filter(Boolean);

    return parts.join(", ");
  }

  _extractDestination(order) {
    const shippingAddress = order?.shipping_address || {};
    const postalCode = normalizePostalCode(
      shippingAddress.zip || shippingAddress.postal_code,
      { length: this.config.shipping.postalCodeLength }
    );

    const phone =
      shippingAddress.phone ||
      order?.phone ||
      order?.customer?.phone ||
      order?.billing_address?.phone ||
      "";

    return {
      name:
        shippingAddress.name ||
        [shippingAddress.first_name, shippingAddress.last_name]
          .filter(Boolean)
          .join(" ")
          .trim() ||
        order?.customer?.first_name ||
        "Customer",
      phone: String(phone || "").trim(),
      email:
        order?.contact_email ||
        order?.email ||
        order?.customer?.email ||
        "",
      postalCode,
      address: this._buildAddress(shippingAddress),
      latitude: toFiniteNumber(shippingAddress.latitude),
      longitude: toFiniteNumber(shippingAddress.longitude),
      city: shippingAddress.city || "",
      province: shippingAddress.province || "",
      country: shippingAddress.country_code || shippingAddress.country || "ID"
    };
  }

  async _resolveCheapestCourier({ group, destination }) {
    const rates = await this.biteshipClient.getRates({
      originPostalCode: group.origin?.postalCode || "",
      destinationPostalCode: destination.postalCode,
      originLatitude: toFiniteNumber(group.origin?.latitude),
      originLongitude: toFiniteNumber(group.origin?.longitude),
      destinationLatitude: toFiniteNumber(destination.latitude),
      destinationLongitude: toFiniteNumber(destination.longitude),
      items: group.items,
      couriers: this.config.biteship.couriers.join(",")
    });

    const sorted = rates.slice().sort((a, b) => a.price - b.price);
    const cheapest = sorted[0] || null;

    if (!cheapest) {
      throw new Error(
        `No available Biteship rate for seller ${group.sellerId} (origin ${group.origin?.postalCode || "-"}, destination ${destination.postalCode || "-"})`
      );
    }

    return {
      courierCompany: String(cheapest.courierCode || "").toLowerCase(),
      courierType: String(cheapest.serviceCode || "").toLowerCase(),
      source: "cheapest_requote",
      previewPrice: Number(cheapest.price || 0)
    };
  }

  async _buildPlan(order, options = {}) {
    const destination = this._extractDestination(order);
    if (!destination.postalCode) {
      throw new Error("Order destination postal code is required");
    }

    const sourceLineItems = Array.isArray(order?.line_items) ? order.line_items : [];
    const shippableLineItems = sourceLineItems.filter((item) =>
      this._isShippableLineItem(item)
    );

    if (shippableLineItems.length === 0) {
      throw new Error("Order has no shippable fulfillable line items");
    }

    const uniqueVariantIds = [
      ...new Set(
        shippableLineItems
          .map((item) => this._normalizeVariantId(item))
          .filter(Boolean)
      )
    ];

    if (uniqueVariantIds.length === 0) {
      throw new Error("Order line items do not contain variant IDs");
    }

    const variantMappings = new Map();
    for (const variantId of uniqueVariantIds) {
      const mapping = await this._getVariantMapping(variantId);
      variantMappings.set(variantId, mapping);
    }

    const groupsBySeller = new Map();
    const skippedItems = [];

    for (const lineItem of shippableLineItems) {
      const variantId = this._normalizeVariantId(lineItem);
      const mapping = variantMappings.get(variantId);

      if (!mapping?.sellerId) {
        skippedItems.push({
          lineItemId: String(lineItem?.id || ""),
          variantId,
          reason: "variant_mapping_not_found"
        });
        continue;
      }

      const sellerId = String(mapping.sellerId);

      if (!groupsBySeller.has(sellerId)) {
        const origin = await this._getSellerOrigin(sellerId);
        groupsBySeller.set(sellerId, {
          sellerId,
          origin,
          items: [],
          lineItems: []
        });
      }

      const group = groupsBySeller.get(sellerId);
      group.items.push(this._buildBiteshipItem(lineItem, mapping));
      group.lineItems.push({
        lineItemId: String(lineItem.id || ""),
        variantId,
        quantity: this._extractFulfillableQty(lineItem),
        title: lineItem.title || lineItem.name || "",
        sku: lineItem.sku || ""
      });
    }

    const selectedShipping = this._resolveShippingSelection(order, options);
    const groups = [];

    for (const group of groupsBySeller.values()) {
      if (!group.origin?.postalCode) {
        skippedItems.push({
          sellerId: group.sellerId,
          reason: "seller_origin_not_found"
        });
        continue;
      }

      const sellerIdentity = await this._resolveSellerIdentity(
        group.sellerId,
        group.origin
      );

      let courierSelection = null;

      if (selectedShipping.courierCompany && selectedShipping.courierType) {
        courierSelection = {
          courierCompany: selectedShipping.courierCompany,
          courierType: selectedShipping.courierType,
          source: selectedShipping.source,
          previewPrice: 0
        };
      } else {
        courierSelection = await this._resolveCheapestCourier({
          group,
          destination
        });
      }

      groups.push({
        sellerId: group.sellerId,
        origin: group.origin,
        sellerIdentity,
        items: group.items,
        lineItems: group.lineItems,
        shippingServiceCode: selectedShipping.serviceCode || "",
        courierSelection
      });
    }

    if (groups.length === 0) {
      throw new Error("No valid seller group found for this order");
    }

    return {
      order: {
        id: String(order.id),
        name: order.name || "",
        currency: order.currency || "IDR",
        financialStatus: order.financial_status || "",
        fulfillmentStatus: order.fulfillment_status || "",
        createdAt: order.created_at || null,
        totalPrice: order.total_price || "0"
      },
      destination,
      selectedShipping,
      sellerGroups: groups,
      skippedItems
    };
  }

  _extractBiteshipOrderSummary(createResponse) {
    const payload =
      createResponse?.order ||
      createResponse?.data ||
      createResponse?.shipment ||
      createResponse ||
      {};

    const orderId =
      payload.id ||
      payload.order_id ||
      payload.shipment_id ||
      payload.courier?.tracking_id ||
      "";

    const trackingNumber =
      payload.waybill_id ||
      payload.waybill ||
      payload.courier?.waybill_id ||
      payload.courier?.waybill ||
      payload.tracking_id ||
      payload.trackingId ||
      "";

    const status =
      payload.status ||
      payload.courier?.status ||
      payload.courier?.tracking_status ||
      "created";

    return {
      biteshipOrderId: String(orderId || ""),
      trackingNumber: String(trackingNumber || ""),
      status: String(status || "created")
    };
  }

  _buildFulfillmentAllocator(fulfillmentOrders) {
    const byLineItem = new Map();

    for (const fulfillmentOrder of fulfillmentOrders) {
      const fulfillmentOrderId = String(fulfillmentOrder.id || "");
      const lineItems = Array.isArray(fulfillmentOrder.line_items)
        ? fulfillmentOrder.line_items
        : [];

      for (const lineItem of lineItems) {
        const lineItemId = String(lineItem.line_item_id || "");
        if (!lineItemId) {
          continue;
        }

        if (!byLineItem.has(lineItemId)) {
          byLineItem.set(lineItemId, []);
        }

        byLineItem.get(lineItemId).push({
          fulfillmentOrderId,
          fulfillmentOrderLineItemId: String(lineItem.id || ""),
          remainingQty: toPositiveInt(
            lineItem.fulfillable_quantity,
            toPositiveInt(lineItem.quantity, 0)
          )
        });
      }
    }

    return {
      allocate: (requestedLineItems) => {
        const grouped = new Map();
        const unallocated = [];

        for (const requested of requestedLineItems) {
          const lineItemId = String(requested.lineItemId || "");
          let remaining = toPositiveInt(requested.quantity, 0);
          if (!lineItemId || remaining <= 0) {
            continue;
          }

          const candidates = byLineItem.get(lineItemId) || [];

          for (const candidate of candidates) {
            if (remaining <= 0) {
              break;
            }

            const takeQty = Math.min(remaining, candidate.remainingQty);
            if (takeQty <= 0) {
              continue;
            }

            candidate.remainingQty -= takeQty;
            remaining -= takeQty;

            if (!grouped.has(candidate.fulfillmentOrderId)) {
              grouped.set(candidate.fulfillmentOrderId, []);
            }

            grouped.get(candidate.fulfillmentOrderId).push({
              id: candidate.fulfillmentOrderLineItemId,
              quantity: takeQty
            });
          }

          if (remaining > 0) {
            unallocated.push({ lineItemId, quantity: remaining });
          }
        }

        const lineItemsByFulfillmentOrder = Array.from(grouped.entries()).map(
          ([fulfillmentOrderId, fulfillmentOrderLineItems]) => ({
            fulfillment_order_id: fulfillmentOrderId,
            fulfillment_order_line_items: fulfillmentOrderLineItems
          })
        );

        return {
          lineItemsByFulfillmentOrder,
          unallocated
        };
      }
    };
  }

  _toTrackingCompanyLabel(courierCompany) {
    const value = String(courierCompany || "").trim().toUpperCase();
    return value || "Biteship";
  }

  async _createShopifyFulfillment({
    allocator,
    sellerGroup,
    shipment,
    notifyCustomer
  }) {
    const allocation = allocator.allocate(sellerGroup.lineItems);

    if (allocation.unallocated.length > 0) {
      this.logger.warn("Some order line items could not be allocated for fulfillment", {
        sellerId: sellerGroup.sellerId,
        unallocated: allocation.unallocated
      });
    }

    if (allocation.lineItemsByFulfillmentOrder.length === 0) {
      return null;
    }

    const trackingNumber = shipment.trackingNumber || shipment.biteshipOrderId;
    const payload = {
      notify_customer: Boolean(notifyCustomer),
      line_items_by_fulfillment_order: allocation.lineItemsByFulfillmentOrder,
      tracking_info: trackingNumber
        ? {
            company: this._toTrackingCompanyLabel(shipment.courierCompany),
            number: trackingNumber
          }
        : undefined,
      message: `Created from Biteship order ${shipment.biteshipOrderId || "(pending)"}`
    };

    const fulfillment = await this.shopifyAdminClient.createFulfillment(
      stripEmpty(payload)
    );

    return {
      fulfillmentId: String(fulfillment.id || ""),
      status: fulfillment.status || "success"
    };
  }

  _buildOrderPayload({ order, destination, group, source }) {
    const origin = group.origin || {};
    const sellerIdentity = group.sellerIdentity || {};

    const originAddress = this._buildAddress({
      address1: origin.address1,
      city: origin.city,
      province: origin.state,
      country: origin.country
    });

    const payload = {
      shipper_contact_name: sellerIdentity.name,
      shipper_contact_phone: sellerIdentity.phone,
      shipper_contact_email: sellerIdentity.email,
      shipper_organization: sellerIdentity.name,
      origin_contact_name: sellerIdentity.name,
      origin_contact_phone: sellerIdentity.phone,
      origin_address: originAddress,
      origin_note: `seller_id:${group.sellerId}`,
      origin_postal_code: origin.postalCode,
      destination_contact_name: destination.name,
      destination_contact_phone: destination.phone,
      destination_contact_email: destination.email,
      destination_address: destination.address,
      destination_note: `${destination.city || ""} ${destination.province || ""}`.trim(),
      destination_postal_code: destination.postalCode,
      courier_company: group.courierSelection.courierCompany,
      courier_type: group.courierSelection.courierType,
      delivery_type: this.config.order.defaultDeliveryType,
      order_note: `Shopify ${order.name} | seller ${group.sellerId}`,
      metadata: {
        source,
        shopify_order_id: String(order.id),
        shopify_order_name: order.name || "",
        shopify_order_currency: order.currency || "IDR",
        seller_id: String(group.sellerId),
        shipping_service_code: group.shippingServiceCode || ""
      },
      items: group.items
    };

    const cleaned = stripEmpty(payload);

    if (!cleaned.origin_contact_phone) {
      throw new Error(`Origin contact phone missing for seller ${group.sellerId}`);
    }

    if (!cleaned.destination_contact_phone) {
      throw new Error(`Destination phone missing for order ${order.id}`);
    }

    if (!cleaned.origin_address) {
      throw new Error(`Origin address missing for seller ${group.sellerId}`);
    }

    if (!cleaned.destination_address) {
      throw new Error(`Destination address missing for order ${order.id}`);
    }

    if (!cleaned.origin_postal_code || !cleaned.destination_postal_code) {
      throw new Error(
        `Origin/Destination postal code is required (seller ${group.sellerId})`
      );
    }

    return cleaned;
  }

  async inspectOrder(orderId, options = {}) {
    if (!this.shopifyAdminClient.isConfigured()) {
      throw new Error(
        "Shopify Admin API is not configured. Set SHOPIFY_SHOP_DOMAIN + token/client credentials"
      );
    }

    const order = await this.shopifyAdminClient.getOrder(orderId);
    const plan = await this._buildPlan(order, options);
    const syncRecord = this.orderSyncStore.get(order.id);

    return {
      order: plan.order,
      selectedShipping: plan.selectedShipping,
      destination: plan.destination,
      sellerGroups: plan.sellerGroups.map((group) => ({
        sellerId: group.sellerId,
        origin: group.origin,
        sellerIdentity: group.sellerIdentity,
        itemCount: group.items.length,
        lineItems: group.lineItems,
        courierSelection: group.courierSelection
      })),
      skippedItems: plan.skippedItems,
      syncRecord
    };
  }

  async listPendingOrders({ limit } = {}) {
    if (!this.shopifyAdminClient.isConfigured()) {
      throw new Error(
        "Shopify Admin API is not configured. Set SHOPIFY_SHOP_DOMAIN + token/client credentials"
      );
    }

    const rows = await this.shopifyAdminClient.listOrders({
      limit: limit || this.config.order.maxDashboardOrders,
      status: "open",
      fulfillmentStatus: "unfulfilled",
      financialStatus: "paid"
    });

    return rows.map((order) => {
      const shippingLine = Array.isArray(order.shipping_lines)
        ? order.shipping_lines[0] || null
        : null;
      const syncRecord = this.orderSyncStore.get(order.id);

      return {
        id: String(order.id),
        name: order.name || "",
        createdAt: order.created_at || null,
        totalPrice: order.total_price || "0",
        currency: order.currency || "IDR",
        financialStatus: order.financial_status || "",
        fulfillmentStatus: order.fulfillment_status || "",
        shippingServiceTitle: shippingLine?.title || "",
        shippingServiceCode: shippingLine?.code || "",
        lineItemCount: Array.isArray(order.line_items) ? order.line_items.length : 0,
        destinationPostalCode: normalizePostalCode(order?.shipping_address?.zip, {
          length: this.config.shipping.postalCodeLength
        }),
        syncStatus: syncRecord?.status || "not_synced",
        updatedAt: syncRecord?.updatedAt || null
      };
    });
  }

  async createBiteshipOrdersFromOrder(orderId, options = {}) {
    if (!this.shopifyAdminClient.isConfigured()) {
      throw new Error(
        "Shopify Admin API is not configured. Set SHOPIFY_SHOP_DOMAIN + token/client credentials"
      );
    }

    const autoFulfill =
      options.autoFulfill !== undefined
        ? Boolean(options.autoFulfill)
        : this.config.order.autoFulfillOnCreate;

    const notifyCustomer =
      options.notifyCustomer !== undefined
        ? Boolean(options.notifyCustomer)
        : this.config.order.notifyCustomerOnFulfill;

    const force = Boolean(options.force);
    const source = options.source || "admin_dashboard";

    const order = await this.shopifyAdminClient.getOrder(orderId);
    const syncKey = String(order.id);
    const existingRecord = this.orderSyncStore.get(syncKey);

    if (!force && existingRecord?.status === "completed") {
      return {
        ok: true,
        skipped: true,
        reason: "already_completed",
        record: existingRecord
      };
    }

    const plan = await this._buildPlan(order, options);

    const nextRecord = {
      orderId: syncKey,
      orderName: order.name || "",
      source,
      autoFulfill,
      status: "processing",
      destinationPostalCode: plan.destination.postalCode,
      selectedShipping: plan.selectedShipping,
      skippedItems: plan.skippedItems,
      shipments: [],
      lastError: null
    };

    this.orderSyncStore.saveRecord(nextRecord);

    let allocator = null;
    if (autoFulfill) {
      const fulfillmentOrders = await this.shopifyAdminClient.getFulfillmentOrders(syncKey);
      allocator = this._buildFulfillmentAllocator(fulfillmentOrders);
    }

    let hasFailure = false;

    for (const group of plan.sellerGroups) {
      const previousShipment = existingRecord?.shipments?.find(
        (entry) => String(entry.sellerId) === String(group.sellerId)
      );

      if (!force && previousShipment?.status === "created") {
        nextRecord.shipments.push(previousShipment);
        continue;
      }

      try {
        const requestPayload = this._buildOrderPayload({
          order,
          destination: plan.destination,
          group,
          source
        });

        const createResponse = await this.biteshipClient.createOrder(requestPayload);
        const parsedShipment = this._extractBiteshipOrderSummary(createResponse);

        const shipment = {
          sellerId: group.sellerId,
          originPostalCode: group.origin?.postalCode || "",
          destinationPostalCode: plan.destination.postalCode,
          courierCompany: group.courierSelection.courierCompany,
          courierType: group.courierSelection.courierType,
          biteshipOrderId: parsedShipment.biteshipOrderId,
          trackingNumber: parsedShipment.trackingNumber,
          status: "created",
          responseStatus: parsedShipment.status,
          lineItems: group.lineItems,
          requestedAt: new Date().toISOString()
        };

        if (autoFulfill && allocator) {
          const fulfillmentResult = await this._createShopifyFulfillment({
            allocator,
            sellerGroup: group,
            shipment,
            notifyCustomer
          });

          if (fulfillmentResult) {
            shipment.shopifyFulfillmentId = fulfillmentResult.fulfillmentId;
            shipment.shopifyFulfillmentStatus = fulfillmentResult.status;
          }
        }

        nextRecord.shipments.push(shipment);

        this.logger.info("Biteship order created from Shopify order", {
          shopifyOrderId: syncKey,
          sellerId: group.sellerId,
          biteshipOrderId: shipment.biteshipOrderId,
          courierCompany: shipment.courierCompany,
          courierType: shipment.courierType,
          autoFulfill,
          shopifyFulfillmentId: shipment.shopifyFulfillmentId || ""
        });
      } catch (error) {
        hasFailure = true;

        const failedShipment = {
          sellerId: group.sellerId,
          originPostalCode: group.origin?.postalCode || "",
          destinationPostalCode: plan.destination.postalCode,
          courierCompany: group.courierSelection.courierCompany,
          courierType: group.courierSelection.courierType,
          status: "failed",
          error: error.message,
          details: error.details || null,
          lineItems: group.lineItems,
          requestedAt: new Date().toISOString()
        };

        nextRecord.shipments.push(failedShipment);

        this.logger.error("Failed to create Biteship order from Shopify order", {
          shopifyOrderId: syncKey,
          sellerId: group.sellerId,
          error: error.message,
          details: error.details || null
        });
      }
    }

    nextRecord.status = hasFailure ? "partial_failed" : "completed";
    nextRecord.lastError = hasFailure ? "One or more seller shipments failed" : null;

    const savedRecord = this.orderSyncStore.saveRecord(nextRecord);

    return {
      ok: !hasFailure,
      skipped: false,
      record: savedRecord
    };
  }
}

module.exports = {
  OrderSyncService
};
