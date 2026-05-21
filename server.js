/**
 * Shopify Auto-Sort Service v2
 * - Shopify Flow (Product created) → POST /sort  [x-webhook-secret header ile]
 * - Shopify Webhook (Product updated) → POST /webhook [Shopify HMAC doğrulama ile]
 */

const express = require('express');
const crypto  = require('crypto');
const app     = express();

// ─── AYARLAR ────────────────────────────────────────────────────────────────
const SHOP_DOMAIN      = process.env.SHOP_DOMAIN;
const ACCESS_TOKEN     = process.env.ACCESS_TOKEN;
const WEBHOOK_SECRET   = process.env.WEBHOOK_SECRET   || 'rugs2026secret';
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET; // Shopify webhook imza doğrulama
const PORT             = process.env.PORT || 3000;
const API_VERSION      = '2025-01';

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

// ─── RAW BODY (Shopify HMAC doğrulama için gerekli) ─────────────────────────
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ─── GRAPHQL ─────────────────────────────────────────────────────────────────
async function gql(query, variables = {}) {
  const res = await fetch(
    `https://${SHOP_DOMAIN}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': ACCESS_TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    }
  );
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function normalizeColor(val) {
  return val ? val.trim().toLowerCase() : null;
}

// ─── ÜRÜN METAFIELDLARı ──────────────────────────────────────────────────────
async function getProductMetafields(productId) {
  const data = await gql(`
    query GetProduct($id: ID!) {
      product(id: $id) {
        id title
        colorPrimary:   metafield(namespace:"custom", key:"color_primary")   { value }
        colorSecondary: metafield(namespace:"custom", key:"color_secondary")  { value }
        damaged:        metafield(namespace:"custom", key:"damaged")          { value }
      }
    }
  `, { id: productId });

  const p = data.product;
  return {
    id:             p.id,
    title:          p.title,
    colorPrimary:   normalizeColor(p.colorPrimary?.value),
    colorSecondary: normalizeColor(p.colorSecondary?.value),
    damaged:        p.damaged?.value === 'true',
  };
}

// ─── COLLECTIONDAKİ ÜRÜNLER ──────────────────────────────────────────────────
async function getCollectionProducts(collectionId) {
  const products = [];
  let cursor = null, hasNext = true;

  while (hasNext) {
    const data = await gql(`
      query($id: ID!, $cursor: String) {
        collection(id: $id) {
          products(first: 50, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            edges { node {
              id
              colorPrimary:   metafield(namespace:"custom", key:"color_primary")   { value }
              colorSecondary: metafield(namespace:"custom", key:"color_secondary")  { value }
              damaged:        metafield(namespace:"custom", key:"damaged")          { value }
            }}
          }
        }
      }
    `, { id: collectionId, cursor });

    const page = data.collection?.products;
    if (!page) break;
    for (const e of page.edges) {
      const n = e.node;
      products.push({
        id:             n.id,
        colorPrimary:   normalizeColor(n.colorPrimary?.value),
        colorSecondary: normalizeColor(n.colorSecondary?.value),
        damaged:        n.damaged?.value === 'true',
      });
    }
    hasNext = page.pageInfo.hasNextPage;
    cursor  = page.pageInfo.endCursor;
    await sleep(300);
  }
  return products;
}

// ─── SIRALAMA ────────────────────────────────────────────────────────────────
async function setManualSort(collectionId) {
  await gql(`
    mutation($id: ID!) {
      collectionUpdate(input: { id: $id, sortOrder: MANUAL }) {
        userErrors { field message }
      }
    }
  `, { id: collectionId });
  await sleep(300);
}

async function reorderCollection(collectionId, colorKey, products) {
  const g1 = [], g2 = [], g3 = [], g4 = [];

  for (const p of products) {
    const pri = p.colorPrimary   === colorKey;
    const sec = p.colorSecondary === colorKey;
    const dmg = p.damaged;
    if      (pri && !dmg) g1.push(p.id);
    else if (pri &&  dmg) g2.push(p.id);
    else if (sec && !dmg) g3.push(p.id);
    else if (sec &&  dmg) g4.push(p.id);
  }

  const ordered = [...g1, ...g2, ...g3, ...g4];
  if (!ordered.length) return { g1:0, g2:0, g3:0, g4:0, total:0 };

  const moves = ordered.map((id, idx) => ({ id, newPosition: String(idx) }));
  for (let i = 0; i < moves.length; i += 50) {
    await gql(`
      mutation($id: ID!, $moves: [MoveInput!]!) {
        collectionReorderProducts(id: $id, moves: $moves) {
          userErrors { field message }
        }
      }
    `, { id: collectionId, moves: moves.slice(i, i + 50) });
    await sleep(300);
  }
  return { g1: g1.length, g2: g2.length, g3: g3.length, g4: g4.length, total: ordered.length };
}

async function processProduct(productId) {
  const product = await getProductMetafields(productId);
  console.log(`  📦 "${product.title}" | primary:${product.colorPrimary} secondary:${product.colorSecondary} damaged:${product.damaged}`);

  const colors = new Set();
  if (product.colorPrimary   && COLOR_COLLECTIONS[product.colorPrimary])   colors.add(product.colorPrimary);
  if (product.colorSecondary && COLOR_COLLECTIONS[product.colorSecondary]) colors.add(product.colorSecondary);

  if (!colors.size) {
    console.log('  ⚠️  Renk metafield\'ı yok, atlanıyor');
    return;
  }

  for (const color of colors) {
    const collId = COLOR_COLLECTIONS[color];
    const colProducts = await getCollectionProducts(collId);
    await setManualSort(collId);
    const stats = await reorderCollection(collId, color, colProducts);
    console.log(`  ✅ ${color}: G1=${stats.g1} G2=${stats.g2} G3=${stats.g3} G4=${stats.g4}`);
    await sleep(500);
  }
}

// ─── ENDPOINT 1: Shopify Flow → POST /sort ───────────────────────────────────
// Header: x-webhook-secret
app.post('/sort', async (req, res) => {
  if (req.headers['x-webhook-secret'] !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const rawId = req.body.product_id || req.body.id;
  if (!rawId) return res.status(400).json({ error: 'product_id eksik' });

  const productId = rawId.startsWith('gid://') ? rawId : `gid://shopify/Product/${rawId}`;
  console.log(`\n📨 Flow webhook | product: ${productId}`);

  res.status(200).json({ status: 'processing', productId });
  processProduct(productId).catch(err => console.error('❌', err.message));
});

// ─── ENDPOINT 2: Shopify Native Webhook → POST /webhook ──────────────────────
// Shopify HMAC imzası ile doğrulama
app.post('/webhook', async (req, res) => {
  // HMAC doğrulama
  if (SHOPIFY_WEBHOOK_SECRET) {
    const hmac      = req.headers['x-shopify-hmac-sha256'];
    const body      = req.body; // raw buffer
    const digest    = crypto
      .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
      .update(body)
      .digest('base64');

    if (digest !== hmac) {
      console.warn('⛔ Geçersiz Shopify webhook imzası');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  let data;
  try {
    data = JSON.parse(req.body.toString());
  } catch {
    return res.status(400).json({ error: 'Geçersiz JSON' });
  }

  // Shopify native webhook'ta id sayısal gelir
  const numericId = data.id;
  if (!numericId) return res.status(400).json({ error: 'id eksik' });

  const productId = `gid://shopify/Product/${numericId}`;
  console.log(`\n📨 Native webhook | product: ${productId}`);

  res.status(200).json({ status: 'processing', productId });
  processProduct(productId).catch(err => console.error('❌', err.message));
});

// ─── ENDPOINT 3: Tüm collection'ları yeniden sırala → POST /sort-all ─────────
app.post('/sort-all', async (req, res) => {
  if (req.headers['x-webhook-secret'] !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log('\n🔄 Tüm collection\'lar yeniden sıralanıyor...');
  res.status(200).json({ status: 'processing all' });

  for (const [color, collId] of Object.entries(COLOR_COLLECTIONS)) {
    try {
      console.log(`\n🎨 ${color}...`);
      const products = await getCollectionProducts(collId);
      await setManualSort(collId);
      const stats = await reorderCollection(collId, color, products);
      console.log(`  ✅ G1=${stats.g1} G2=${stats.g2} G3=${stats.g3} G4=${stats.g4}`);
    } catch (err) {
      console.error(`  ❌ ${color}:`, err.message);
    }
    await sleep(1000);
  }
  console.log('\n🎉 Tüm collection\'lar tamamlandı!');
});

// ─── SAĞLIK KONTROLÜ ─────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', shop: SHOP_DOMAIN, version: '2.0' });
});

app.listen(PORT, () => {
  console.log(`🚀 Sort Service v2 çalışıyor | port ${PORT}`);
});
