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

// Renk collection'lari - 4 kademeli siralama
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

// Diger collection'lar - sadece damaged/saglamda siralama
const OTHER_COLLECTIONS = {
  // Region
  'turkish':      'gid://shopify/Collection/517502435650',
  'persian':      'gid://shopify/Collection/517502468418',
  'oushak':       'gid://shopify/Collection/517502501186',
  // Type
  'oversized':    'gid://shopify/Collection/517502566722',
  'area':         'gid://shopify/Collection/517502599490',
  'runner':       'gid://shopify/Collection/517502632258',
  'doormat':      'gid://shopify/Collection/517502665026',
  'round':        'gid://shopify/Collection/517502697794',
  // Material
  'wool':         'gid://shopify/Collection/517502730562',
  'hemp':         'gid://shopify/Collection/517502763330',
  'goathair':     'gid://shopify/Collection/517502828866',
  'cotton':       'gid://shopify/Collection/517502894402',
  // Pattern
  'maximalist':   'gid://shopify/Collection/517502959938',
  'minimalist':   'gid://shopify/Collection/517503025474',
  'floral':       'gid://shopify/Collection/517503058242',
  'geometric':    'gid://shopify/Collection/517503091010',
  'southwestern': 'gid://shopify/Collection/517503123778',
  'striped':      'gid://shopify/Collection/517503156546',
  'patchwork':    'gid://shopify/Collection/517503189314',
  'distressed':   'gid://shopify/Collection/517503222082',
  'overdyed':     'gid://shopify/Collection/517503254850',
  'solid':        'gid://shopify/Collection/517503287618',
  'medallion':    'gid://shopify/Collection/517503320386',
  // Pile
  'flatweave':    'gid://shopify/Collection/517503353154',
  'lowpile':      'gid://shopify/Collection/517503385922',
  'mediumpile':   'gid://shopify/Collection/517503418690',
  'shaggy':       'gid://shopify/Collection/517503451458',
  // Style
  'farmhouse':    'gid://shopify/Collection/517503484226',
  'bohemian':     'gid://shopify/Collection/517503516994',
  'rustic':       'gid://shopify/Collection/517503549762',
  'traditional':  'gid://shopify/Collection/517503582530',
  'modern':       'gid://shopify/Collection/517503615298',
  // Special
  'oneofakind':   'gid://shopify/Collection/517503648066',
  'washable':     'gid://shopify/Collection/517503680834',
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
  console.log('Token obtained: ' + cachedToken.substring(0, 10) + '...');
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
  if (!products.length) return { skip: true };

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
  const moves = ordered.map((id, idx) => ({ id, newPosition: String(ordered.length - 1 - idx) }));
  await applyMoves(collectionId, moves);
  return { g1: g1.length, g2: g2.length, g3: g3.length, g4: g4.length };
}

// Diger collection - sadece damaged/saglamda siralama
async function sortOtherCollection(collectionId) {
  const products = await getCollectionProducts(collectionId);
  if (!products.length) return { skip: true };

  const good    = products.filter(p => !p.damaged).map(p => p.id);
  const damaged = products.filter(p =>  p.damaged).map(p => p.id);
  const ordered = [...good, ...damaged];

  await setManualSort(collectionId);
  const moves = ordered.map((id, idx) => ({ id, newPosition: String(ordered.length - 1 - idx) }));
  await applyMoves(collectionId, moves);
  return { good: good.length, damaged: damaged.length };
}

async function sortAllCollections() {
  console.log('--- Sorting COLOR collections ---');
  for (const [color, collId] of Object.entries(COLOR_COLLECTIONS)) {
    try {
      console.log('Color: ' + color);
      const stats = await sortColorCollection(color, collId);
      if (stats.skip) { console.log('  (empty)'); continue; }
      console.log('  G1=' + stats.g1 + ' G2=' + stats.g2 + ' G3=' + stats.g3 + ' G4=' + stats.g4);
    } catch (err) { console.error('  Error: ' + err.message); }
    await sleep(800);
  }

  console.log('--- Sorting OTHER collections ---');
  for (const [name, collId] of Object.entries(OTHER_COLLECTIONS)) {
    try {
      console.log('Other: ' + name);
      const stats = await sortOtherCollection(collId);
      if (stats.skip) { console.log('  (empty)'); continue; }
      console.log('  Good=' + stats.good + ' Damaged=' + stats.damaged);
    } catch (err) { console.error('  Error: ' + err.message); }
    await sleep(800);
  }

  console.log('=== All done! ===');
}

async function processProduct(productId) {
  const data = await gql(`
    query($id: ID!) {
      product(id: $id) {
        id title
        colorPrimary:   metafield(namespace:"custom", key:"color_primary")   { value }
        colorSecondary: metafield(namespace:"custom", key:"color_secondary")  { value }
        damaged:        metafield(namespace:"custom", key:"damaged")          { value }
      }
    }
  `, { id: productId });
  const p = data.product;
  const product = {
    colorPrimary:   normalizeColor(p.colorPrimary?.value),
    colorSecondary: normalizeColor(p.colorSecondary?.value),
    damaged:        p.damaged?.value === 'true',
  };
  console.log('Product: ' + p.title + ' | primary:' + product.colorPrimary + ' secondary:' + product.colorSecondary + ' damaged:' + product.damaged);

  // Renk collectionlarini sirala
  const colors = new Set();
  if (product.colorPrimary   && COLOR_COLLECTIONS[product.colorPrimary])   colors.add(product.colorPrimary);
  if (product.colorSecondary && COLOR_COLLECTIONS[product.colorSecondary]) colors.add(product.colorSecondary);
  for (const color of colors) {
    await sortColorCollection(color, COLOR_COLLECTIONS[color]);
    await sleep(500);
  }

  // Diger tum collectionlari sirala
  for (const [name, collId] of Object.entries(OTHER_COLLECTIONS)) {
    try {
      await sortOtherCollection(collId);
    } catch (err) { console.error('Error ' + name + ': ' + err.message); }
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
  res.json({ status: 'ok', shop: SHOP_DOMAIN, version: '4.0' });
});

app.listen(PORT, () => {
  console.log('Sort Service v4.0 running on port ' + PORT);
  console.log('Shop: ' + SHOP_DOMAIN);
});
