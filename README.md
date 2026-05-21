# Shopify Auto-Sort Service — Kurulum Rehberi

## Nasıl Çalışır?

```
Ürün oluşturuldu / güncellendi
        ↓
Shopify Flow tetiklenir
        ↓
Bu servise POST /sort isteği gönderilir
        ↓
color_primary, color_secondary, damaged okunur
        ↓
İlgili renk collection'larında sıralama uygulanır:
  1. Ana renk + sağlam   (en üste)
  2. Ana renk + bozuk
  3. İkinci renk + sağlam
  4. İkinci renk + bozuk (en alta)
```

---

## ADIM 1 — Render.com'da Servis Kur (Ücretsiz)

1. https://render.com adresine gidin ve ücretsiz hesap açın
2. **New → Web Service** seçin
3. **"Deploy from GitHub"** seçin
   - Bu klasörü GitHub'a yükleyin (veya zip ile deploy edin)
4. Ayarlar:
   - **Name:** shopify-sort-service
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
5. **Environment Variables** bölümüne şunları ekleyin:

| Key | Value |
|-----|-------|
| `SHOP_DOMAIN` | `tky1en-di.myshopify.com` |
| `ACCESS_TOKEN` | Shopify Admin API token'ınız |
| `WEBHOOK_SECRET` | Kendiniz belirleyin (örn: `rugs2026secret`) |

6. **Create Web Service** — Deploy tamamlanınca bir URL alırsınız:
   `https://shopify-sort-service.onrender.com`

---

## ADIM 2 — Shopify Admin API Token Al

1. Shopify Admin → **Settings → Apps and sales channels**
2. **Develop apps** → **Create an app** → İsim: `Sort Service`
3. **Configure Admin API scopes** → şunları işaretleyin:
   - ✅ `read_products`
   - ✅ `write_products`
   - ✅ `read_collections`
   - ✅ `write_collections`
4. **Install app** → **Admin API access token** kopyalayın
5. Bu token'ı Render'daki `ACCESS_TOKEN` env variable'ına yapıştırın

---

## ADIM 3 — Shopify Flow Kur

1. Shopify Admin → **Apps → Flow**
2. **Create workflow** → **Blank workflow**
3. **Trigger** olarak seçin: **Product created** VE ayrı bir workflow için **Product updated**
4. **Action** ekleyin: **Send HTTP request**
5. Ayarlar:
   - **URL:** `https://shopify-sort-service.onrender.com/sort`
   - **Method:** POST
   - **Headers:**
     - `Content-Type: application/json`
     - `x-webhook-secret: rugs2026secret` ← WEBHOOK_SECRET ile aynı olmalı
   - **Body:**
     ```json
     {
       "product_id": "{{ product.id }}"
     }
     ```
6. **Save** ve workflow'u **Turn on** yapın
7. **Product created** için de aynı workflow'u tekrarlayın

---

## ADIM 4 — Tüm Mevcut Ürünleri Sırala (İlk Çalıştırma)

Servis kurulduktan sonra mevcut tüm ürünleri sıralamak için:

```bash
curl -X POST https://shopify-sort-service.onrender.com/sort-all \
  -H "x-webhook-secret: rugs2026secret"
```

Ya da tarayıcıdan Postman ile de yapabilirsiniz.

---

## CSV'de Metafield Kullanımı

Shopify CSV'ye şu kolon başlıklarını ekleyin:

```
Metafield: custom.color_primary [single_line_text_field]
Metafield: custom.color_secondary [single_line_text_field]  
Metafield: custom.damaged [boolean]
```

### Örnek CSV satırı:
```csv
"Vintage Red Turkish Rug","Turkish rug,Wool","Red","Yellow","false"
"Old Blue Runner","Runner rugs,Hemp","Blue","","false"
"Damaged Green Rug","Turkish rug,Cotton","Green","Red","true"
```

### Renk değerleri (küçük veya büyük harf — fark etmez):
`Red` / `red` / `RED` → hepsi çalışır

---

## Servis Sağlık Kontrolü

```
GET https://shopify-sort-service.onrender.com/health
```

Yanıt: `{ "status": "ok", "shop": "tky1en-di.myshopify.com" }`

---

## Sıralama Mantığı Özeti

Her renk collection'ı için (örn: Red Rugs):

| Grup | Koşul | Sıra |
|------|-------|------|
| G1 | `color_primary = red` AND `damaged = false` | En üst |
| G2 | `color_primary = red` AND `damaged = true`  | 2. sıra |
| G3 | `color_secondary = red` AND `damaged = false` | 3. sıra |
| G4 | `color_secondary = red` AND `damaged = true`  | En alt |

