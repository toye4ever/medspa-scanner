/**
 * LocalEdge — Cloudflare Worker API Gateway
 * ─────────────────────────────────────────────────
 * Required secrets (wrangler secret put <NAME>):
 *   PLACES_KEY  — Google Places + Geocoding API key
 *   GEMINI_KEY  — Google Gemini API key
 *   STRIPE_KEY  — Stripe secret key (sk_live_... or sk_test_...)
 *
 * Routes:
 *   GET  /ping
 *   GET  /geocode   ?city=
 *   GET  /places    ?lat=&lng=&radius=&keyword=
 *   GET  /details   ?place_id=
 *   POST /gemini    {model?,contents,...}
 *   POST /stripe/create-link  {amount,name,description,mode:'full'|'deposit',installments?:2|3|4}
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
const err  = (m, s = 400) => json({ error: m }, s);

async function stripePost(path, params, key) {
  const r = await fetch('https://api.stripe.com/v1' + path, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  return r.json();
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url  = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '') || '/';
    const p    = url.searchParams;

    // /ping
    if (path === '/ping') {
      return json({
        ok: true, worker: 'localedge',
        placesKey: env.PLACES_KEY ? '✓ set' : '✗ missing',
        geminiKey: env.GEMINI_KEY ? '✓ set' : '✗ missing',
        stripeKey: env.STRIPE_KEY ? '✓ set' : '✗ missing',
      });
    }

    try {

      // /geocode
      if (path === '/geocode') {
        const city = p.get('city');
        if (!city) return err('Missing ?city');
        if (!env.PLACES_KEY) return err('PLACES_KEY not set', 500);
        const r = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(city)}&key=${env.PLACES_KEY}`);
        return json(await r.json());
      }

      // /places
      if (path === '/places') {
        const lat = p.get('lat'), lng = p.get('lng');
        if (!lat || !lng) return err('Missing lat/lng');
        if (!env.PLACES_KEY) return err('PLACES_KEY not set', 500);
        const radius = p.get('radius') || '10000';
        const kw = p.get('keyword') || '';
        let apiUrl = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=${radius}&key=${env.PLACES_KEY}`;
        apiUrl += kw ? `&keyword=${encodeURIComponent(kw)}` : `&type=establishment`;
        const r = await fetch(apiUrl);
        return json(await r.json());
      }

      // /details
      if (path === '/details') {
        const pid = p.get('place_id');
        if (!pid) return err('Missing place_id');
        if (!env.PLACES_KEY) return err('PLACES_KEY not set', 500);
        const fields = 'name,formatted_phone_number,website,rating,user_ratings_total,formatted_address,reviews';
        const r = await fetch(`https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(pid)}&fields=${fields}&key=${env.PLACES_KEY}`);
        return json(await r.json());
      }

      // /gemini
      if (path === '/gemini') {
        if (request.method !== 'POST') return err('POST required', 405);
        if (!env.GEMINI_KEY) return err('GEMINI_KEY not set', 500);
        const body = await request.json();
        const model = body.model || 'gemini-2.0-flash';
        const { model: _m, ...fwd } = body;
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_KEY}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fwd),
        });
        const d = await r.json();
        return json(d, r.ok ? 200 : r.status);
      }

      // /stripe/create-link
      if (path === '/stripe/create-link') {
        if (request.method !== 'POST') return err('POST required', 405);
        if (!env.STRIPE_KEY) return err('STRIPE_KEY not set. Run: wrangler secret put STRIPE_KEY', 500);

        const body = await request.json();
        const { amount, name, description = '', mode = 'full', installments = 2, currency = 'usd', success_url = '' } = body;

        if (!amount || amount < 50) return err('amount must be at least 50 (cents)');
        if (!name) return err('name is required');

        // For deposit mode split the amount
        const chargeAmount = mode === 'deposit'
          ? Math.round(amount / installments)
          : amount;

        const productName = mode === 'deposit'
          ? `${name} — Deposit (1 of ${installments} payments)`
          : name;

        const productDesc = mode === 'deposit'
          ? `${description ? description + '. ' : ''}Remaining ${installments - 1} payment(s) of $${(chargeAmount / 100).toFixed(2)} will be invoiced separately.`
          : description;

        // 1. Create a one-time price
        const priceParams = {
          'unit_amount': String(chargeAmount),
          'currency': currency,
          'product_data[name]': productName,
        };
        if (productDesc) priceParams['product_data[description]'] = productDesc;

        const price = await stripePost('/prices', priceParams, env.STRIPE_KEY);
        if (price.error) return err(price.error.message || JSON.stringify(price.error), 400);

        // 2. Create payment link
        const linkParams = {
          'line_items[0][price]': price.id,
          'line_items[0][quantity]': '1',
          'after_completion[type]': 'redirect',
        };
        if (success_url) linkParams['after_completion[redirect][url]'] = success_url;

        const link = await stripePost('/payment_links', linkParams, env.STRIPE_KEY);
        if (link.error) return err(link.error.message || JSON.stringify(link.error), 400);

        return json({
          url: link.url,
          id: link.id,
          amount: chargeAmount,
          mode,
          installments: mode === 'deposit' ? installments : 1,
        });
      }

      return err(`Unknown route: ${path}`, 404);

    } catch (e) {
      return err('Worker error: ' + e.message, 500);
    }
  },
};
