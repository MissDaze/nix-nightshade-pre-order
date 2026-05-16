// SANDBOX MODE — swap credentials and set SQUARE_ENVIRONMENT=production before going live
require('dotenv').config();

const express = require('express');
const { SquareClient, SquareEnvironment, SquareError } = require('square');
const { randomUUID } = require('crypto');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Square client ──────────────────────────────────────────────────────────────
const square = new SquareClient({
  token: process.env.SQUARE_ACCESS_TOKEN,
  environment: process.env.SQUARE_ENVIRONMENT === 'production'
    ? SquareEnvironment.Production
    : SquareEnvironment.Sandbox,
});

// ── POST /process-payment ──────────────────────────────────────────────────────
app.post('/process-payment', async (req, res) => {
  const {
    sourceId,
    amountCents,
    currency,
    name,
    email,
    size,
    streetAddress,
    suburb,
    state,
    postcode,
    country,
    priceTier,
  } = req.body;

  if (!sourceId || !amountCents || !currency) {
    return res.status(400).json({ success: false, error: 'Missing required payment fields.' });
  }

  if (typeof amountCents !== 'number' || amountCents < 100) {
    return res.status(400).json({ success: false, error: 'Invalid payment amount.' });
  }

  // Guard against tampered amounts — early-bird=5495, standard=6790 cents AUD
  const validAmounts = [5495, 6790];
  if (!validAmounts.includes(amountCents)) {
    return res.status(400).json({ success: false, error: 'Unexpected payment amount.' });
  }

  try {
    const response = await square.payments.create({
      sourceId,
      idempotencyKey: randomUUID(),
      amountMoney: {
        amount: amountCents,
        currency,
      },
      locationId: process.env.SQUARE_LOCATION_ID,
      buyerEmailAddress: email || undefined,
      billingAddress: {
        addressLine1: streetAddress,
        locality: suburb,
        administrativeDistrictLevel1: state,
        postalCode: postcode,
        country: 'AU',
      },
      shippingAddress: {
        addressLine1: streetAddress,
        locality: suburb,
        administrativeDistrictLevel1: state,
        postalCode: postcode,
        country: 'AU',
      },
      note: `Nix Nightshade | Size: ${size} | Tier: ${priceTier} | ${name}`,
      referenceId: `nix-${Date.now()}`,
    });

    console.log(`Payment OK: ${response.payment.id} | ${name} | Size ${size} | ${priceTier} | ${amountCents}c AUD`);

    return res.json({
      success: true,
      paymentId: response.payment.id,
    });

  } catch (err) {
    if (err instanceof SquareError) {
      const errors = err.body?.errors || [];
      const detail = errors.length > 0
        ? errors[0].detail
        : 'Payment declined. Please try again or use a different card.';
      console.error('Square error:', err.statusCode, errors);
      return res.status(402).json({ success: false, error: detail });
    }

    console.error('Unexpected error:', err);
    return res.status(500).json({ success: false, error: 'An unexpected error occurred. Please try again.' });
  }
});

// ── Health check ───────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── Catch-all → serve index.html ──────────────────────────────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const env = process.env.SQUARE_ENVIRONMENT || 'sandbox';
  console.log(`Nix Nightshade server on port ${PORT} [${env}]`);
});
