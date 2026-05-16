// SANDBOX MODE — swap for production credentials before going live
//
// RAILWAY DEPLOYMENT:
// 1. Push this file (and package.json, public/) to a GitHub repo
// 2. Connect repo to Railway.app — New Project → Deploy from GitHub
// 3. Set environment variables in Railway dashboard (Variables tab)
// 4. Railway auto-deploys on every push to main/master
//
// ENVIRONMENT VARIABLES REQUIRED:
// SQUARE_ACCESS_TOKEN  — your Square access token (sandbox or production)
// SQUARE_LOCATION_ID   — LXX26HNBNHTJF (or your production location ID)
// SQUARE_ENVIRONMENT   — "sandbox" or "production"
// ADMIN_PASSWORD       — password for admin.html dashboard
// PORT                 — set automatically by Railway, do not set manually
//
// BEFORE GOING LIVE:
// 1. Set all environment variables in Railway dashboard
// 2. Update CORS origin from * to your actual Railway domain
// 3. Switch SQUARE_ENVIRONMENT to "production"
// 4. Replace SQUARE_ACCESS_TOKEN with your production token
// 5. Test full payment flow in sandbox before switching credentials

require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const { SquareClient, SquareEnvironment, SquareError } = require('square');
const { v4: uuidv4 } = require('uuid');
const fs         = require('fs');
const path       = require('path');

const app = express();
app.use(express.json());

// CORS — update origin to your Railway domain before going live
app.use(cors({ origin: '*' })); // TODO: restrict to your domain before launch

// ── Square client ──────────────────────────────────────────────────────────────
const square = new SquareClient({
  token: process.env.SQUARE_ACCESS_TOKEN,
  environment: process.env.SQUARE_ENVIRONMENT === 'production'
    ? SquareEnvironment.Production
    : SquareEnvironment.Sandbox,
});

// ── In-memory orders + CSV persistence ────────────────────────────────────────
let orders = [];
const CSV_PATH = path.join(__dirname, 'orders.csv');
const CSV_HEADER = 'Order ID,Timestamp (AEST),Name,Email,Size,Street Address,Suburb,State,Postcode,Country,Item Price AUD,Shipping AUD,Total AUD,Price Tier,Square Payment ID\n';

// ── Contacts persistence ───────────────────────────────────────────────────────
let contacts = [];
const CONTACTS_CSV_PATH   = path.join(__dirname, 'contacts.csv');
const CONTACTS_CSV_HEADER = 'Contact ID,Timestamp (AEST),Name,Email,Subject,Message\n';

function escapeCsv(val) {
  const s = String(val == null ? '' : val);
  return (s.includes(',') || s.includes('"') || s.includes('\n'))
    ? '"' + s.replace(/"/g, '""') + '"'
    : s;
}

function parseCSVLine(line) {
  const result = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (inQ && line[i+1] === '"') { cur += '"'; i++; } else { inQ = !inQ; } }
    else if (c === ',' && !inQ) { result.push(cur); cur = ''; }
    else cur += c;
  }
  result.push(cur);
  return result;
}

function loadOrders() {
  if (!fs.existsSync(CSV_PATH)) { fs.writeFileSync(CSV_PATH, CSV_HEADER); return; }
  try {
    const lines = fs.readFileSync(CSV_PATH, 'utf8').trim().split('\n').slice(1);
    orders = lines.filter(l => l.trim()).map(line => {
      const [orderId, timestamp, name, email, size, streetAddress, suburb, state, postcode,
             country, itemPriceAUD, shippingAUD, totalAUD, priceTier, squarePaymentId] = parseCSVLine(line);
      return { orderId, timestamp, name, email, size, streetAddress, suburb, state,
               postcode, country, itemPriceAUD, shippingAUD, totalAUD, priceTier, squarePaymentId };
    });
    console.log(`Loaded ${orders.length} existing orders from orders.csv`);
  } catch (e) { console.error('Failed to load orders.csv:', e.message); }
}

function loadContacts() {
  if (!fs.existsSync(CONTACTS_CSV_PATH)) { fs.writeFileSync(CONTACTS_CSV_PATH, CONTACTS_CSV_HEADER); return; }
  try {
    const lines = fs.readFileSync(CONTACTS_CSV_PATH, 'utf8').trim().split('\n').slice(1);
    contacts = lines.filter(l => l.trim()).map(line => {
      const [contactId, timestamp, name, email, subject, message] = parseCSVLine(line);
      return { contactId, timestamp, name, email, subject, message };
    });
    console.log(`Loaded ${contacts.length} existing contacts from contacts.csv`);
  } catch (e) { console.error('Failed to load contacts.csv:', e.message); }
}

function appendContactCSV(contact) {
  const row = [
    contact.contactId, contact.timestamp, contact.name, contact.email,
    contact.subject, contact.message
  ].map(escapeCsv).join(',') + '\n';
  fs.appendFileSync(CONTACTS_CSV_PATH, row);
}

function appendCSV(order) {
  const row = [
    order.orderId, order.timestamp, order.name, order.email, order.size,
    order.streetAddress, order.suburb, order.state, order.postcode, order.country,
    order.itemPriceAUD, order.shippingAUD, order.totalAUD, order.priceTier, order.squarePaymentId
  ].map(escapeCsv).join(',') + '\n';
  fs.appendFileSync(CSV_PATH, row);
}

function toAEST(date) {
  const d = new Date(date.getTime() + 10 * 60 * 60 * 1000);
  return d.toISOString().replace('Z', '+10:00');
}

// ── Pricing & validation ───────────────────────────────────────────────────────
const EARLY_BIRD_END  = new Date('2026-05-22T13:59:59Z');
const CAMPAIGN_END    = new Date('2026-05-28T13:59:59Z');
const ITEM_EARLY      = 4495;
const ITEM_STANDARD   = 5495;

// Country values must match the dropdown values in index.html exactly
const SHIPPING = {
  'Australia':    { early: 1000, standard: 1295 },
  'New Zealand':  { early: 2295, standard: 2295 },
  'Asia Pacific': { early: 2695, standard: 2695 },
  'USA / Canada': { early: 3295, standard: 3295 },
  'UK / Europe':  { early: 3695, standard: 3695 },
  'Rest of World':{ early: 4195, standard: 4195 },
};

// ── POST /api/payment ──────────────────────────────────────────────────────────
app.post('/api/payment', async (req, res) => {
  const { sourceId, amountCents, currency, name, email, size,
          streetAddress, suburb, state, postcode, country, priceTier } = req.body;

  if (!sourceId || !name || !email || !size || !country) {
    return res.status(400).json({ success: false, error: 'Missing required fields.' });
  }

  const now = new Date();
  if (now > CAMPAIGN_END) {
    return res.status(400).json({ success: false, error: 'This campaign has closed.' });
  }

  const isEB       = now <= EARLY_BIRD_END;
  const itemCents  = isEB ? ITEM_EARLY : ITEM_STANDARD;
  const rates      = SHIPPING[country];
  if (!rates) {
    return res.status(400).json({ success: false, error: 'Invalid shipping region.' });
  }
  const shipCents  = isEB ? rates.early : rates.standard;
  const expected   = itemCents + shipCents;

  if (typeof amountCents !== 'number' || amountCents !== expected) {
    return res.status(400).json({ success: false, error: 'Payment amount mismatch.' });
  }

  if (orders.length >= 150) {
    return res.status(400).json({ success: false, error: 'Campaign is sold out.' });
  }

  try {
    const response = await square.payments.create({
      sourceId,
      idempotencyKey: uuidv4(),
      amountMoney: { amount: BigInt(amountCents), currency: 'AUD' },
      locationId: process.env.SQUARE_LOCATION_ID,
      buyerEmailAddress: email || undefined,
      billingAddress: {
        addressLine1: streetAddress,
        locality: suburb,
        administrativeDistrictLevel1: state,
        postalCode: postcode,
        country: 'AU',
      },
      note: `Nix Nightshade | ${size} | ${isEB ? 'early-bird' : 'standard'} | ${name}`,
      referenceId: `nix-${Date.now()}`,
    });

    const orderId = uuidv4();
    const order = {
      orderId,
      timestamp:      toAEST(new Date()),
      name, email, size, streetAddress, suburb, state, postcode, country,
      itemPriceAUD:   (itemCents / 100).toFixed(2),
      shippingAUD:    (shipCents / 100).toFixed(2),
      totalAUD:       (expected  / 100).toFixed(2),
      priceTier:      isEB ? 'early-bird' : 'standard',
      squarePaymentId: response.payment.id,
    };

    orders.push(order);
    appendCSV(order);

    console.log(`OK ${orderId} | ${name} | ${size} | ${order.priceTier} | $${order.totalAUD}`);
    return res.json({ success: true, orderId, squarePaymentId: response.payment.id });

  } catch (err) {
    if (err instanceof SquareError) {
      const errs   = err.body?.errors || [];
      const detail = errs.length ? errs[0].detail : 'Payment declined. Please try another card.';
      console.error('Square error', err.statusCode, errs);
      return res.status(402).json({ success: false, error: detail });
    }
    console.error('Unexpected error:', err);
    return res.status(500).json({ success: false, error: 'An unexpected error occurred.' });
  }
});

// ── GET /api/orders/count — public ────────────────────────────────────────────
app.get('/api/orders/count', (_req, res) => {
  res.json({ count: orders.length });
});

// ── GET /api/admin/orders — protected ─────────────────────────────────────────
app.get('/api/admin/orders', (req, res) => {
  const adminPw = process.env.ADMIN_PASSWORD || 'nixexport2026';
  if (req.headers.authorization !== `Bearer ${adminPw}`) {
    return res.status(401).json({ error: 'Unauthorised.' });
  }
  res.json({ orders, count: orders.length });
});

// ── POST /api/contact — public ────────────────────────────────────────────────
app.post('/api/contact', (req, res) => {
  const { name, email, subject, message } = req.body;

  if (!name?.trim() || !email?.trim() || !message?.trim()) {
    return res.status(400).json({ success: false, error: 'Name, email and message are required.' });
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return res.status(400).json({ success: false, error: 'Please provide a valid email address.' });
  }

  const contact = {
    contactId: uuidv4(),
    timestamp: toAEST(new Date()),
    name:      name.trim(),
    email:     email.trim(),
    subject:   (subject || 'General').trim(),
    message:   message.trim(),
  };

  contacts.push(contact);
  appendContactCSV(contact);

  console.log(`Contact: ${contact.contactId} | ${contact.name} | ${contact.subject}`);
  res.json({ success: true, contactId: contact.contactId });
});

// ── GET /api/admin/contacts — protected ───────────────────────────────────────
app.get('/api/admin/contacts', (req, res) => {
  const adminPw = process.env.ADMIN_PASSWORD || 'nixexport2026';
  if (req.headers.authorization !== `Bearer ${adminPw}`) {
    return res.status(401).json({ error: 'Unauthorised.' });
  }
  res.json({ contacts, count: contacts.length });
});

// ── Static files + health ──────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ status: 'ok', orders: orders.length, contacts: contacts.length }));

// ── Start ──────────────────────────────────────────────────────────────────────
loadOrders();
loadContacts();
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const env = process.env.SQUARE_ENVIRONMENT || 'sandbox';
  console.log(`Nix Nightshade server on :${PORT} [${env}] — ${orders.length} orders loaded`);
});
