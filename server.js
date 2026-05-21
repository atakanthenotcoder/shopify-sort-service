/**
 * Shopify Auto-Sort Service
 * 
 * Shopify Flow tarafından tetiklenir.
 * Ürün güncellendiğinde/oluşturulduğunda çalışır.
 * color_primary, color_secondary, damaged metafield'larını okur.
 * İlgili renk collection'larında 4 kademeli sıralama uygular.
 *
 * Sıralama mantığı (her renk collection'ı için):
 *   1. color_primary = X  AND damaged = false  → pozisyon 0-999
 *   2. color_primary = X  AND damaged = true   → pozisyon 1000-1999
 *   3. color_secondary = X AND damaged = false  → pozisyon 2000-2999
 *   4. color_secondary = X AND damaged = true   → pozisyon 3000-3999
 */

const express = require('express');
const app = express();
app.use(express.json());

// ─── AYARLAR (Environment Variables) ────────────────────────────────────────
const SHOP_DOMAIN  = process.env.SHOP_DOMAIN;   // tky1en-di.myshopify.com
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;   // Shopify Admin API token
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'your-secret-key'; // Flow doğrulama
const PORT = process.env.PORT || 3000;
const API_VERSION = '2025-01';

// Renk → Collection GID eşleştirmesi
const COLOR_COLLECTIONS = {
  'red':    'gid://shopify/Collection/517502239042',
  'white':  'gid://shopify/Collection/517502075202',
  'brown':  'gid://shopify/Collection/517502107970',
  'gray':   'gid://shopify/Collection/517502140738',
  'beige':  'gid://shopify/Collection/517502173506',
  'orange': 'gid://shopify/Collection/517502206274',
  'pink':   'gid://shopify/Collection/517502271810',
  'yellow': 'gid://shopify/Collection/517502304578',
  'green':  'gid://shopify/Collection/517502337346',
  'blue':   'gid://shopify/Collection/517502402882',
};

// ─── GRAPHQL YARDIMCISI ──────────────────────────────────────────────────────
async function gql(query, variables = {}) {
  const url = `https://${SHOP_DOMAIN}/admin/api/${API_VERSION}/graphql.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    throw new Error(`GraphQL Error: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function normalizeColor(val) {
  if (!val) return null;
  return val.trim().toLowerCase();
}

// ─── ÜRÜN METAFIELDLARını ÇEK ───────────────────────────────────────────────
async function getProductMetafields(productId) {
  const data = await gql(`
    query GetProduct($id: ID!) {
      product(id: $id) {
        id
        title
        colorPrimary: metafield(namespace: "custom", key: "color_primary") {
          value
        }
        colorSecondary: metafield(namespace: "custom", key: "color_secondary") {
          value
        }
        damaged: metafield(namespace: "custom", key: "damaged") {
          value
        }
      }
    }
  `, { id: productId });

  const p = data.product;
  return {
    id: p.id,
    title: p.title,
    colorPrimary:   normalizeColor(p.colorPrimary?.value),
    colorSecondary: normalizeColor(p.colorSecondary?.value),
    damaged: p.damaged?.value === 'true',
  };
}

// ─── COLLECTIONDAKİ TÜM ÜRÜNLERİ ÇEK ──────────────────────────────────────
async function getCollectionProducts(collectionId) {
  const products = [];
  let cursor = null;
  let hasNext = true;

  while (hasNext) {
    const data = await gql(`
      query GetColProducts($id: ID!, $cursor: String) {
        collection(id: $id) {
          products(first: 50, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                id
                colorPrimary: metafield(namespace: "custom", key: "color_primary") {
                  value
                }
                colorSecondary: metafield(namespace: "custom", key: "color_secondary") {
                  value
                }
                damaged: metafield(namespace: "custom", key: "damaged") {
                  value
                }
              }
            }
          }
        }
      }
    `, { id: collectionId, cursor });

    const page = data.collection?.products;
    if (!page) break;

    for (const edge of page.edges) {
      const node = edge.node;
      products.push({
        id: node.id,
        colorPrimary:   normalizeColor(node.colorPrimary?.value),
        colorSecondary: normalizeColor(node.colorSecondary?.value),
        damaged: node.damaged?.value === 'true',
      });
    }

    hasNext = page.pageInfo.hasNextPage;
    cursor  = page.pageInfo.endCursor;
    await sleep(300);
  }

  return products;
}

// ─── COLLECTION'I MANUAL MODA AL ────────────────────────────────────────────
async function setManualSort(collectionId) {
  await gql(`
    mutation SetManual($id: ID!) {
      collectionUpdate(input: { id: $id, sortOrder: MANUAL }) {
        collection { id sortOrder }
        userErrors { field message }
      }
    }
  `, { id: collectionId });
  await sleep(300);
}

// ─── POZİSYONLARI ATAYEN FONKSİYON ─────────────────────────────────────────
async function reorderCollection(collectionId, colorKey, products) {
  // 4 gruba ayır
  const g1 = []; // primary + !damaged
  const g2 = []; // primary + damaged
  const g3 = []; // secondary + !damaged
  const g4 = []; // secondary + damaged

  for (const p of products) {
    const isPrimary   = p.colorPrimary   === colorKey;
    const isSecondary = p.colorSecondary === colorKey;
    const dmg = p.damaged;

    if      (isPrimary   && !dmg) g1.push(p.id);
    else if (isPrimary   &&  dmg) g2.push(p.id);
    else if (isSecondary && !dmg) g3.push(p.id);
    else if (isSecondary &&  dmg) g4.push(p.id);
  }

  const ordered = [...g1, ...g2, ...g3, ...g4];
  if (ordered.length === 0) return { g1: 0, g2: 0, g3: 0, g4: 0, total: 0 };

  const moves = ordered.map((id, idx) => ({ id, newPosition: String(idx) }));

  // 50'şer chunk halinde gönder
  const CHUNK = 50;
  for (let i = 0; i < moves.length; i += CHUNK) {
    const chunk = moves.slice(i, i + CHUNK);
    await gql(`
      mutation Reorder($id: ID!, $moves: [MoveInput!]!) {
        collectionReorderProducts(id: $id, moves: $moves) {
          job { id }
          userErrors { field message }
        }
      }
    `, { id: collectionId, moves: chunk });
    await sleep(300);
  }

  return { g1: g1.length, g2: g2.length, g3: g3.length, g4: g4.length, total: ordered.length };
}

// ─── ANA SIRALAMA FONKSİYONU ─────────────────────────────────────────────────
async function sortAffectedCollections(product) {
  const affectedColors = new Set();
  if (product.colorPrimary   && COLOR_COLLECTIONS[product.colorPrimary])   affectedColors.add(product.colorPrimary);
  if (product.colorSecondary && COLOR_COLLECTIONS[product.colorSecondary]) affectedColors.add(product.colorSecondary);

  const results = {};

  for (const color of affectedColors) {
    const collectionId = COLOR_COLLECTIONS[color];
    console.log(`  → ${color} collection sıralanıyor...`);

    try {
      // Collection'daki tüm ürünleri çek
      const colProducts = await getCollectionProducts(collectionId);

      // Manual moda al
      await setManualSort(collectionId);

      // Sırala
      const stats = await reorderCollection(collectionId, color, colProducts);
      results[color] = { success: true, ...stats };

      console.log(`  ✅ ${color}: G1=${stats.g1} G2=${stats.g2} G3=${stats.g3} G4=${stats.g4}`);
    } catch (err) {
      results[color] = { success: false, error: err.message };
      console.error(`  ❌ ${color} hatası:`, err.message);
    }

    await sleep(500);
  }

  return results;
}

// ─── WEBHOOK ENDPOINT (Shopify Flow buraya POST atar) ────────────────────────
app.post('/sort', async (req, res) => {
  // Basit token doğrulama
  const authHeader = req.headers['x-webhook-secret'];
  if (authHeader !== WEBHOOK_SECRET) {
    console.warn('⛔ Yetkisiz istek reddedildi');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const body = req.body;
  console.log('\n📨 Webhook alındı:', JSON.stringify(body));

  // Shopify Flow'dan gelen product ID
  // Flow'da şu şekilde gönderilir: { "product_id": "gid://shopify/Product/123" }
  const rawId = body.product_id || body.id;
  if (!rawId) {
    return res.status(400).json({ error: 'product_id eksik' });
  }

  // GID formatına çevir
  const productId = rawId.startsWith('gid://') 
    ? rawId 
    : `gid://shopify/Product/${rawId}`;

  console.log(`🔍 Ürün işleniyor: ${productId}`);

  // Async işle — Flow'a hemen 200 dön, arka planda çalış
  res.status(200).json({ status: 'processing', productId });

  try {
    // Ürün metafield'larını çek
    const product = await getProductMetafields(productId);
    console.log(`  Ürün: "${product.title}"`);
    console.log(`  Primary: ${product.colorPrimary}, Secondary: ${product.colorSecondary}, Damaged: ${product.damaged}`);

    if (!product.colorPrimary && !product.colorSecondary) {
      console.log('  ⚠️  Renk metafield\'ı yok, atlanıyor');
      return;
    }

    const results = await sortAffectedCollections(product);
    console.log('✅ Tamamlandı:', JSON.stringify(results));

  } catch (err) {
    console.error('❌ Hata:', err.message);
  }
});

// ─── TÜM COLLECTIONLARı YENIDEN SIRALA (tam toplu çalıştırma) ───────────────
app.post('/sort-all', async (req, res) => {
  const authHeader = req.headers['x-webhook-secret'];
  if (authHeader !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log('\n🔄 Tüm collection\'lar yeniden sıralanıyor...');
  res.status(200).json({ status: 'processing all collections' });

  try {
    for (const [color, collectionId] of Object.entries(COLOR_COLLECTIONS)) {
      console.log(`\n🎨 ${color} işleniyor...`);
      const products = await getCollectionProducts(collectionId);
      await setManualSort(collectionId);
      const stats = await reorderCollection(collectionId, color, products);
      console.log(`  ✅ G1=${stats.g1} G2=${stats.g2} G3=${stats.g3} G4=${stats.g4}`);
      await sleep(1000);
    }
    console.log('\n🎉 Tüm collection\'lar tamamlandı!');
  } catch (err) {
    console.error('❌ Hata:', err.message);
  }
});

// Sağlık kontrolü
app.get('/health', (req, res) => {
  res.json({ status: 'ok', shop: SHOP_DOMAIN });
});

app.listen(PORT, () => {
  console.log(`🚀 Shopify Sort Service çalışıyor: port ${PORT}`);
  console.log(`   Shop: ${SHOP_DOMAIN}`);
  console.log(`   Endpoint: POST /sort`);
  console.log(`   Toplu:    POST /sort-all`);
});
