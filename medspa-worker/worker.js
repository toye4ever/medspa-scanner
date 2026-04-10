/**
 * Med Spa Scanner — Cloudflare Worker API Gateway
 * ─────────────────────────────────────────────────
 * Handles all API calls server-side so no keys ever reach the browser.
 *
 * Required secrets (set via: wrangler secret put <NAME>):
 *   PLACES_KEY  — Google Places + Geocoding API key
 *   GEMINI_KEY  — Google Gemini API key
 *
 * Routes:
 *   GET  /geocode   ?city=Silver+Spring+MD
 *   GET  /places    ?lat=38.99&lng=-77.02&radius=10000&keyword=med+spa
 *   GET  /details   ?place_id=ChIJ...
 *   POST /gemini    body: Gemini generateContent payload
 *   GET  /ping      health check — returns {"ok":true,"worker":"medspa-scanner"}
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Requested-With',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function err(msg, status = 400) {
  return json({ error: msg }, status);
}

export default {
  async fetch(request, env) {
    // ── Preflight ──────────────────────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url   = new URL(request.url);
    const path  = url.pathname.replace(/\/$/, '') || '/';
    const p     = url.searchParams;

    // ── /ping — health check ──────────────────────────────────────────────────
    if (path === '/ping') {
      return json({
        ok: true,
        worker: 'medspa-scanner',
        placesKey: env.PLACES_KEY ? '✓ set' : '✗ missing',
        geminiKey: env.GEMINI_KEY ? '✓ set' : '✗ missing',
      });
    }

    // ── Guard: secrets must be configured ─────────────────────────────────────
    if (!env.PLACES_KEY && (path === '/geocode' || path === '/places' || path === '/details')) {
      return err('PLACES_KEY secret is not set. Run: wrangler secret put PLACES_KEY', 500);
    }
    if (!env.GEMINI_KEY && path === '/gemini') {
      return err('GEMINI_KEY secret is not set. Run: wrangler secret put GEMINI_KEY', 500);
    }

    try {

      // ── /geocode ─────────────────────────────────────────────────────────────
      if (path === '/geocode') {
        const city = p.get('city');
        if (!city) return err('Missing ?city parameter');

        const apiUrl = `https://maps.googleapis.com/maps/api/geocode/json`
          + `?address=${encodeURIComponent(city)}&key=${env.PLACES_KEY}`;

        const resp = await fetch(apiUrl);
        const data = await resp.json();
        return json(data);
      }

      // ── /places ──────────────────────────────────────────────────────────────
      if (path === '/places') {
        const lat     = p.get('lat');
        const lng     = p.get('lng');
        const radius  = p.get('radius') || '10000';
        const keyword = p.get('keyword') || '';

        if (!lat || !lng) return err('Missing ?lat and ?lng parameters');

        let apiUrl = `https://maps.googleapis.com/maps/api/place/nearbysearch/json`
          + `?location=${lat},${lng}&radius=${radius}&key=${env.PLACES_KEY}`;

        if (keyword) apiUrl += `&keyword=${encodeURIComponent(keyword)}`;
        else         apiUrl += `&type=establishment`;

        const resp = await fetch(apiUrl);
        const data = await resp.json();
        return json(data);
      }

      // ── /details ─────────────────────────────────────────────────────────────
      if (path === '/details') {
        const placeId = p.get('place_id');
        if (!placeId) return err('Missing ?place_id parameter');

        const fields = 'name,formatted_phone_number,website,rating,user_ratings_total,formatted_address,reviews';
        const apiUrl = `https://maps.googleapis.com/maps/api/place/details/json`
          + `?place_id=${encodeURIComponent(placeId)}&fields=${fields}&key=${env.PLACES_KEY}`;

        const resp = await fetch(apiUrl);
        const data = await resp.json();
        return json(data);
      }

      // ── /gemini ──────────────────────────────────────────────────────────────
      if (path === '/gemini') {
        if (request.method !== 'POST') return err('POST required for /gemini', 405);

        const body = await request.json();
        const model = body.model || 'gemini-2.0-flash';

        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
          + `?key=${env.GEMINI_KEY}`;

        // Remove model from body before forwarding (it's in the URL)
        const { model: _m, ...forwardBody } = body;

        const resp = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(forwardBody),
        });

        const data = await resp.json();
        return json(data);
      }

      // ── 404 ──────────────────────────────────────────────────────────────────
      return err(`Unknown route: ${path}. Available: /ping /geocode /places /details /gemini`, 404);

    } catch (e) {
      return err(`Worker error: ${e.message}`, 500);
    }
  },
};
