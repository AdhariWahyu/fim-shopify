# Shopify Multivendor Dynamic Shipping (Webkul + Biteship)

Backend custom untuk Shopify CarrierService agar ongkir checkout **dinamis per seller origin** tanpa membuat Shopify location baru per seller.

## Masalah yang diselesaikan
- Shopify location merchant dibatasi (mis. 200 di Plus).
- Webkul shipping bawaan terbatas ke 1 shipping profile/location.
- Marketplace multi-seller butuh ongkir real-time berdasarkan lokasi seller + lokasi buyer.

Solusi ini menghitung ongkir di callback CarrierService menggunakan:
1. Mapping item -> seller dari Webkul API
2. Origin seller dari Webkul location/seller profile
3. Rate real-time dari Biteship API
4. Agregasi multi-origin ke format `rates[]` Shopify checkout
5. Payload Biteship mendukung mode `postal_code`, `mix`, dan `coordinates` (jika lat/long tersedia)

## Arsitektur ringkas
1. Shopify checkout memanggil `POST /webhooks/shopify/carrier-service`
2. Service ini membaca item cart
3. Ambil seller per item via Webkul API
4. Ambil origin postcode seller
5. Call Biteship `/v1/rates/couriers` per seller group
6. Agregasi hasil menjadi shipping option final untuk checkout

Tambahan:
- Cache variant/seller/rate untuk performa
- Auto refresh Webkul access token
- Auto retry backoff saat API Webkul/Biteship rate-limit (429)
- Endpoint Flow untuk sinkron origin seller tanpa `locationAdd`

## Struktur endpoint
- `GET /health`
- `POST /webhooks/shopify/carrier-service`
- `POST /webhooks/shopify/flow/seller-origin`
- `POST /webhooks/shopify/flow/create-biteship-order` (trigger dari Shopify Flow)
- `POST /webhooks/shopify/orders/paid` (opsional auto create order Biteship)
- `GET /admin/seller-origins`
- `POST /admin/seller-origins`
- `GET /admin/dashboard` (simple UI)
- `GET /admin/orders/pending`
- `GET /admin/orders/:orderId/plan`
- `POST /admin/orders/:orderId/create-biteship`
- `GET /admin/order-sync`
- `GET /admin/order-sync/:orderId`
- `GET /admin/rate-logs`
- `GET /admin/rate-logs/:logId`
- `POST /debug/quote`
- `GET /debug/cache`

## 1) Setup

```bash
cp .env.example .env
npm install
```

Isi `.env` minimal:
- `WEBKUL_ACCESS_TOKEN`
- `WEBKUL_REFRESH_TOKEN`
- `BITESHIP_API_KEY`
- `PUBLIC_CALLBACK_URL`

Auth Shopify untuk `register:carrier` ada 2 opsi:
- Recommended (otomatis, tanpa copy token manual): isi `SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET`
- Legacy: isi `SHOPIFY_ADMIN_ACCESS_TOKEN`

Untuk fitur create order + fulfillment sync, wajib isi:
- `SHOPIFY_SHOP_DOMAIN`
- `SHOPIFY_ADMIN_ACCESS_TOKEN` **atau** (`SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET`)

## 2) Jalankan server

```bash
npm run dev
# atau
npm start
```

## 3) Register CarrierService ke Shopify

```bash
npm run register:carrier
```

Script akan:
- Coba GraphQL `carrierServiceCreate/carrierServiceUpdate`
- Fallback ke REST jika GraphQL tidak tersedia pada store
- Otomatis generate access token jika `SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET` diisi

## 4) Konfigurasi Shopify / Webkul

### A. Ganti flow yang saat ini membuat Shopify location
Flow Anda saat ini: metaobject seller -> `locationAdd`.

Ganti menjadi **2 workflow** agar saat create dan update seller, origin ikut sinkron:

1. Workflow 1 (create):
   - Trigger: `Metaobject entry created` (definition: `sellers`)
   - Action: **Send HTTP Request** ke:
     - `POST https://<domain-anda>/webhooks/shopify/flow/seller-origin`
     - Header opsional: `x-flow-token: <FLOW_WEBHOOK_TOKEN>`
     - Body contoh: lihat [docs/flow-seller-origin-payload.json](docs/flow-seller-origin-payload.json)

2. Workflow 2 (update):
   - Trigger: `Metaobject entry updated` (definition: `sellers`)
   - Action: **Send HTTP Request** ke endpoint yang sama:
     - `POST https://<domain-anda>/webhooks/shopify/flow/seller-origin`
     - Header opsional: `x-flow-token: <FLOW_WEBHOOK_TOKEN>`
     - Body: pakai payload yang sama dengan workflow 1

Catatan penting:
- Jangan pakai `{{metaobject.id}}` karena untuk trigger ini sering tidak tersedia dan akan error validasi Flow (`"id" is invalid`).
- Jika field seller ID Webkul tersedia di metaobject (mis. `sellerId`), boleh ditambahkan:
  - `"seller_id": "{{metaobject.sellerId}}"`
- Jika seller ID tidak tersedia, backend akan auto-resolve seller ID dari kombinasi `storeName/contact/email`.

Dengan ini, data origin seller disimpan di service custom, bukan menambah Shopify location.

### B. Shipping di checkout
Pastikan checkout memakai CarrierService custom yang didaftarkan script di atas.

## 5) Test cepat

### Health
```bash
curl -s http://localhost:3000/health | jq
```

### Simulasi quote checkout
```bash
curl -s -X POST http://localhost:3000/debug/quote \
  -H 'Content-Type: application/json' \
  -H 'x-admin-key: <ADMIN_API_KEY_jika_diisi>' \
  -d '{
    "rate": {
      "destination": {"postal_code": "40111", "country": "ID"},
      "currency": "IDR",
      "items": [
        {"name": "Item A", "variant_id": 1111111111, "quantity": 1, "grams": 300, "price": 15000000, "requires_shipping": true},
        {"name": "Item B", "variant_id": 2222222222, "quantity": 2, "grams": 500, "price": 20000000, "requires_shipping": true}
      ]
    }
  }' | jq
```

## 6) Dashboard create order Biteship

1. Buka `GET /admin/dashboard`
2. Isi `ADMIN_API_KEY` (jika diaktifkan)
3. Klik `Reload Orders`
4. Klik `Preview Plan` untuk lihat mapping:
   - order line item -> seller
   - origin postcode seller
   - destination postcode buyer
   - courier selection (dari service checkout atau cheapest requote)
5. Klik `Create Biteship`

Opsi:
- `Auto fulfill Shopify`: jika aktif, setelah create order Biteship sukses maka service membuat fulfillment Shopify via Admin API.
- `Notify customer`: kirim notifikasi fulfillment ke buyer (jika auto fulfill aktif).
- `Force create`: paksa create ulang walau order pernah tersinkron.

API langsung (tanpa dashboard):
```bash
curl -s -X POST http://localhost:3000/admin/orders/<ORDER_ID>/create-biteship \
  -H 'Content-Type: application/json' \
  -H 'x-admin-key: <ADMIN_API_KEY_jika_diisi>' \
  -d '{"autoFulfill":true,"notifyCustomer":false}'
```

## 7) Observability postcode/rate

Untuk audit detail asal-tujuan ongkir:
- Cek `GET /admin/rate-logs` untuk list quote terbaru.
- Cek `GET /admin/rate-logs/:logId` untuk detail per quote.
- Log berisi:
  - destination postcode buyer
  - origin postcode per seller group
  - seller id
  - rates yang dikirim ke checkout
  - item yang di-skip (jika ada)

## 8) Auto create via webhook (opsional)

Aktifkan env:
- `BITESHIP_ORDER_AUTO_CREATE_ON_PAID=true`
- `BITESHIP_ORDER_AUTO_FULFILL_ON_CREATE=true|false`

Lalu daftarkan webhook Shopify `orders/paid` ke endpoint:
- `POST https://<domain-anda>/webhooks/shopify/orders/paid`

Jika flag auto create `false`, endpoint tetap merespons `202 skipped` (aman untuk staging).

Alternatif tanpa subscription webhook app:
- Shopify Flow trigger `Order paid`
- Action `Send HTTP request` ke:
  - `POST https://<domain-anda>/webhooks/shopify/flow/create-biteship-order`
  - Header opsional: `x-flow-token: <FLOW_WEBHOOK_TOKEN>`
  - Body contoh:
    ```json
    {
      "order_id": "{{order.id}}"
    }
    ```

## Catatan implementasi penting
- `total_price` response Shopify dikirim dalam subunit (x100), termasuk IDR.
- Jika tidak ada service courier yang sama antar semua seller, sistem kirim fallback 1 rate `BSH_MULTI_CHEAPEST`.
- Create order di Biteship **tidak otomatis** mengubah fulfillment status Shopify, kecuali opsi `autoFulfill` diaktifkan (dashboard/API/env auto webhook).
- Jika `SHOPIFY_USE_BACKUP_ON_ERROR=true`, endpoint akan return 5xx saat error agar Shopify fallback ke backup rates.
- Jika `false`, endpoint return `rates: []` untuk mencegah checkout hard-fail.
- Header auth Biteship menggunakan `Authorization: <API_KEY>` (sesuai collection), termasuk key mode testing (`biteship_test...`).
- Parser Biteship mendukung 2 format ETA: `min_day/max_day` dan `shipment_duration_range`/`duration`.
- ETA dengan unit `hours`/`minutes` dari Biteship otomatis dikonversi agar `min_delivery_date/max_delivery_date` Shopify tetap tepat.
- Item payload ke Biteship otomatis menyertakan dimensi (`length/width/height`) jika tersedia dari Webkul variant.

## Security
- Aktifkan `SHOPIFY_API_SECRET` untuk verifikasi HMAC callback Shopify.
- Gunakan `FLOW_WEBHOOK_TOKEN` untuk endpoint flow seller origin.
- Gunakan `ADMIN_API_KEY` untuk endpoint debug/admin.

## Deploy production
- Deploy sebagai service HTTPS publik (Railway/Fly/Render/K8s/VPS).
- Pastikan timeout server >= 15 detik.
- Set scaling minimal 1 instance always-on.
- Simpan file runtime di volume persisten untuk token store:
  - `WEBKUL_TOKEN_STORE_PATH`
  - `SELLER_ORIGIN_STORE_PATH`
  - `RATE_LOG_STORE_PATH`
  - `ORDER_SYNC_STORE_PATH`

## Referensi
- Shopify Carrier Service API docs
- Webkul MultiVendor API docs
- Biteship Rates + Orders API docs
