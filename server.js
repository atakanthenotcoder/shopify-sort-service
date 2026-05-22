const express = require('express');
const crypto  = require('crypto');
const app     = express();

const SHOP_DOMAIN            = process.env.SHOP_DOMAIN;
const CLIENT_ID              = process.env.CLIENT_ID;
const CLIENT_SECRET          = process.env.CLIENT_SECRET;
const WEBHOOK_SECRET         = process.env.WEBHOOK_SECRET || 'rugs2026secret';
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const PORT                   = process.env.PORT || 3000;
const API_VERSION            = '2025-01';

// Renk collection handle'lari - bunlar 4 kademeli siralanir
const COLOR_HANDLES = [
  'red-rugs', 'white-rugs', 'brown-rugs', 'gray-rugs', 'beige-rugs',
  'orange-rugs', 'pink-rugs', 'yellow-rugs', 'green-rugs', 'blue-rugs'
];

// Renk handle -> metafield deger eslesimi
const HANDLE_TO_COLOR = {
  'red-rugs': 'red', 'white-rugs': 'white', 'brown-rugs': 'brown',
  'gray-rugs': 'gray', 'beige-rugs': 'beige', 'orange-rugs': 'orange',
  'pink-rugs': 'pink', 'yellow-rugs': 'yellow', 'green-rugs': 'green',
  'blue-rugs': 'blue'
};

app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiry) return cachedToken;
  console.log('Getting new access token...');
  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');
  params.append('client_id', CLIENT_ID);
  params.append('client_secret', CLIENT_SECRET);
  const res = await fetch('https://' + SHOP_DOMAIN + '/admin/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const json = await res.json();
  if (!json.access_token) throw new Error('Token alinamadi: ' + JSON.stringify(json));
  cachedToken = json.access_token;
  tokenExpiry = now + ((json.expires_in || 86400) - 300) * 1000;
  console.log('Token OK: ' + cachedToken.substring(0, 10) + '...');
  return cachedToken;
}

async function gql(query, variables = {}) {
  const token = await getAccessToken();
  const res = await fetch('https://' + SHOP_DOMAIN + '/admin/api/' + API_VERSION + '/graphql.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401) { cachedToken = null; tokenExpiry = 0; }
    throw new Error('HTTP ' + res.status + ': ' + text);
  }
  const json = JSON.parse(text);
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const normalizeColor = val => val ? val.trim().toLowerCase() : null;

// Tum collection'lari cek (dinamik)
async function fetchAllCollections() {
  const collections = [];
  let cursor = null, hasNext = true;
  while (hasNext) {
    const data = await gql(`
      query($cursor: String) {
        collections(first: 50, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          edges { node { id title handle } }
        }
      }
    `, { cursor });
    const page = data.collections;
    for (const e of page.edges) collections.push(e.node);
    hasNext = page.pageInfo.hasNextPage;
    cursor  = page.pageInfo.endCursor;
    await sleep(200);
  }
  return collections;
}

// Collection'daki urunleri cek
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

async function applyMoves(collectionId, moves) {
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
}

// Renk collection - 4 kademeli siralama
async function sortColorCollection(colorKey, collectionId) {
  const products = await getCollectionProducts(collectionId);
  if (!products.length) return { empty: true };
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
  if (!ordered.length) return { g1:0, g2:0, g3:0, g4:0 };
  await setManualSort(collectionId);
  await applyMoves(collectionId, ordered.map((id, idx) => ({ id, newPosition: String(idx) })));
  return { g1: g1.length, g2: g2.length, g3: g3.length, g4: g4.length };
}

// Diger collection - saglamlar uste, damaged assagida
async function sortOtherCollection(collectionId) {
  const products = await getCollectionProducts(collectionId);
  if (!products.length) return { empty: true };
  const good    = products.filter(p => !p.damaged).map(p => p.id);
  const damaged = products.filter(p =>  p.damaged).map(p => p.id);
  const ordered = [...good, ...damaged];
  await setManualSort(collectionId);
  await applyMoves(collectionId, ordered.map((id, idx) => ({ id, newPosition: String(idx) })));
  return { good: good.length, damaged: damaged.length };
}

// Tum collection'lari sirala (dinamik)
async function sortAllCollections() {
  console.log('Fetching all collections...');
  const collections = await fetchAllCollections();
  console.log('Found ' + collections.length + ' collections');

  for (const col of collections) {
    try {
      if (COLOR_HANDLES.includes(col.handle)) {
        // Renk collection - 4 kademeli
        const colorKey = HANDLE_TO_COLOR[col.handle];
        console.log('COLOR ' + col.handle + ' (' + colorKey + ')');
        const stats = await sortColorCollection(colorKey, col.id);
        if (stats.empty) { console.log('  (empty)'); }
        else console.log('  G1=' + stats.g1 + ' G2=' + stats.g2 + ' G3=' + stats.g3 + ' G4=' + stats.g4);
      } else {
        // Diger collection - damaged assagida
        console.log('OTHER ' + col.handle);
        const stats = await sortOtherCollection(col.id);
        if (stats.empty) { console.log('  (empty)'); }
        else console.log('  Good=' + stats.good + ' Damaged=' + stats.damaged);
      }
    } catch (err) {
      console.error('Error ' + col.handle + ': ' + err.message);
    }
    await sleep(800);
  }
  console.log('=== All done! ===');
}

// Tek urun icin ilgili collection'lari sirala
async function processProduct(productId) {
  const data = await gql(`
    query($id: ID!) {
      product(id: $id) {
        id title
        colorPrimary:   metafield(namespace:"custom", key:"color_primary")   { value }
        colorSecondary: metafield(namespace:"custom", key:"color_secondary")  { value }
        damaged:        metafield(namespace:"custom", key:"damaged")          { value }
        collections(first: 50) {
          edges { node { id handle } }
        }
      }
    }
  `, { id: productId });

  const p = data.product;
  const colorPrimary   = normalizeColor(p.colorPrimary?.value);
  const colorSecondary = normalizeColor(p.colorSecondary?.value);
  console.log('Product: ' + p.title + ' | primary:' + colorPrimary + ' secondary:' + colorSecondary + ' damaged:' + (p.damaged?.value === 'true'));

  // Urundeki tum collection'lari sirala
  for (const e of p.collections.edges) {
    const col = e.node;
    try {
      if (COLOR_HANDLES.includes(col.handle)) {
        const colorKey = HANDLE_TO_COLOR[col.handle];
        console.log('COLOR ' + col.handle);
        const stats = await sortColorCollection(colorKey, col.id);
        console.log('  G1=' + stats.g1 + ' G2=' + stats.g2 + ' G3=' + stats.g3 + ' G4=' + stats.g4);
      } else {
        console.log('OTHER ' + col.handle);
        const stats = await sortOtherCollection(col.id);
        console.log('  Good=' + stats.good + ' Damaged=' + stats.damaged);
      }
    } catch (err) {
      console.error('Error ' + col.handle + ': ' + err.message);
    }
    await sleep(500);
  }
}

app.post('/sort', async (req, res) => {
  if (req.headers['x-webhook-secret'] !== WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const rawId = req.body.product_id || req.body.id;
  if (!rawId) return res.status(400).json({ error: 'product_id missing' });
  const productId = rawId.startsWith('gid://') ? rawId : 'gid://shopify/Product/' + rawId;
  res.status(200).json({ status: 'processing', productId });
  processProduct(productId).catch(err => console.error('Error:', err.message));
});

app.post('/webhook', async (req, res) => {
  if (SHOPIFY_WEBHOOK_SECRET) {
    const hmac   = req.headers['x-shopify-hmac-sha256'];
    const digest = crypto.createHmac('sha256', SHOPIFY_WEBHOOK_SECRET).update(req.body).digest('base64');
    if (digest !== hmac) return res.status(401).json({ error: 'Invalid signature' });
  }
  let data;
  try { data = JSON.parse(req.body.toString()); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  const numericId = data.id;
  if (!numericId) return res.status(400).json({ error: 'id missing' });
  const productId = 'gid://shopify/Product/' + numericId;
  res.status(200).json({ status: 'processing', productId });
  processProduct(productId).catch(err => console.error('Error:', err.message));
});

app.post('/sort-all', async (req, res) => {
  if (req.headers['x-webhook-secret'] !== WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  res.status(200).json({ status: 'processing all' });
  sortAllCollections().catch(err => console.error('Error:', err.message));
});

app.get('/run', async (req, res) => {
  if (req.query.secret !== WEBHOOK_SECRET) return res.status(401).send('Unauthorized');
  res.send('Sort started! Check Render logs.');
  sortAllCollections().catch(err => console.error('Error:', err.message));
});

app.get('/test-token', async (req, res) => {
  if (req.query.secret !== WEBHOOK_SECRET) return res.status(401).send('Unauthorized');
  try {
    const token = await getAccessToken();
    const data = await gql('{ shop { name myshopifyDomain } }');
    res.json({ success: true, shop: data.shop, token_prefix: token.substring(0, 15) });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', shop: SHOP_DOMAIN, version: '5.0-dynamic' });
});

app.listen(PORT, () => {
  console.log('Sort Service v5.0 (dynamic) running on port ' + PORT);
  console.log('Shop: ' + SHOP_DOMAIN);
});
