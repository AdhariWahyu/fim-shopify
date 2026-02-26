# Shopify Multivendor Dynamic Shipping (Webkul + Biteship)

Backend custom untuk Shopify CarrierService agar ongkir checkout dinamis per seller origin (Webkul) dan sekaligus bisa create order ke Biteship dari order Shopify.

## Fitur utama
- Carrier calculated shipping: Shopify checkout -> Webkul mapping seller -> Biteship rates.
- Multi-seller aggregation: gabung rate antar seller origin.
- Sinkron origin seller via Shopify Flow (`metaobject sellers`).
- Dashboard internal untuk create order Biteship per seller dari order Shopify.
- Opsional auto-fulfill Shopify setelah create order Biteship sukses.
- Observability: simpan rate logs (origin/destination postcode, seller groups, hasil rate).
- Auto-register carrier service saat startup/deploy (idempotent).

## Endpoint
- `GET /health`
- `POST /webhooks/shopify/carrier-service`
- `POST /webhooks/shopify/flow/seller-origin`
- `POST /webhooks/shopify/flow/create-biteship-order`
- `POST /webhooks/shopify/orders/paid`
- `GET /admin/dashboard`
- `GET /admin/orders/pending`
- `GET /admin/orders/:orderId/plan`
- `POST /admin/orders/:orderId/create-biteship`
- `GET /admin/order-sync`
- `GET /admin/order-sync/:orderId`
- `GET /admin/rate-logs`
- `GET /admin/rate-logs/:logId`
- `GET /admin/seller-origins`
- `POST /admin/seller-origins`
- `POST /debug/quote`
- `GET /debug/cache`

## Setup
```bash
cp .env.example .env
npm install
npm start
```

Minimal env wajib:
- `WEBKUL_ACCESS_TOKEN`
- `WEBKUL_REFRESH_TOKEN`
- `BITESHIP_API_KEY`
- `PUBLIC_CALLBACK_URL`
- `SHOPIFY_SHOP_DOMAIN`
- Auth Shopify Admin: `SHOPIFY_ADMIN_ACCESS_TOKEN` **atau** (`SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET`)

## Register CarrierService
### Otomatis (disarankan)
Secara default, saat server startup/deploy sistem akan auto-register carrier service:
- `AUTO_REGISTER_CARRIER_ON_STARTUP=true`

Jika gagal register dan Anda ingin startup tetap lanjut:
- `FAIL_STARTUP_ON_CARRIER_REGISTER_ERROR=false`

### Manual
```bash
npm run register:carrier
```

## Shopify Flow yang dipakai
### 1) Sinkron origin seller
- Trigger: `Metaobject entry created` (definition: `sellers`)
- Trigger tambahan (disarankan): `Metaobject entry updated`
- Action: HTTP POST `https://<domain>/webhooks/shopify/flow/seller-origin`
- Header opsional: `x-flow-token: <FLOW_WEBHOOK_TOKEN>`
- Body contoh: `docs/flow-seller-origin-payload.json`

### 2) Trigger create order Biteship dari order paid (opsional)
- Trigger: `Order paid`
- Action: HTTP POST `https://<domain>/webhooks/shopify/flow/create-biteship-order`
- Header opsional: `x-flow-token: <FLOW_WEBHOOK_TOKEN>`
- Body:
```json
{
  "order_id": "{{order.id}}"
}
```

## Dashboard create order
Buka:
- `GET /admin/dashboard`

Flow di dashboard:
1. Reload orders (paid + unfulfilled).
2. Preview plan per order (seller groups, origin/destination, courier).
3. Create Biteship order per seller.
4. Opsional centang `Auto fulfill Shopify`.

Catatan:
- Create order Biteship tidak otomatis membuat Shopify fulfilled, kecuali `autoFulfill` aktif.

## Cek log
### Rate logs (validasi postcode/rates)
```bash
curl -s "https://<domain>/admin/rate-logs?limit=20" -H "x-admin-key: <ADMIN_API_KEY>" | jq
```

### Order sync logs (hasil create order)
```bash
curl -s "https://<domain>/admin/order-sync?limit=20" -H "x-admin-key: <ADMIN_API_KEY>" | jq
```

## Environment penting
Lihat lengkap di `.env.example`. Variabel yang sering dipakai:
- `SHOPIFY_SHOP_DOMAIN`
- `SHOPIFY_API_VERSION`
- `SHOPIFY_CARRIER_SERVICE_NAME`
- `PUBLIC_CALLBACK_URL`
- `SHOPIFY_ADMIN_ACCESS_TOKEN` atau `SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET`
- `BITESHIP_ORDER_FEATURE_ENABLED`
- `BITESHIP_ORDER_AUTO_CREATE_ON_PAID`
- `BITESHIP_ORDER_AUTO_FULFILL_ON_CREATE`
- `SHOPIFY_NOTIFY_CUSTOMER_ON_FULFILLMENT`
- `ADMIN_API_KEY` (opsional)
- `FLOW_WEBHOOK_TOKEN` (opsional)
- `AUTO_REGISTER_CARRIER_ON_STARTUP`
- `FAIL_STARTUP_ON_CARRIER_REGISTER_ERROR`

## Security
- Aktifkan `SHOPIFY_API_SECRET` untuk verifikasi HMAC webhook Shopify.
- Gunakan `FLOW_WEBHOOK_TOKEN` untuk endpoint Flow.
- Gunakan `ADMIN_API_KEY` untuk endpoint admin/debug.
