// Fonction Edge « search » : recherche publique du catalogue pour la page https://central.parts/recherche/ (ADR 0013).
// Déployée sans vérification de jeton Supabase (--no-verify-jwt) : la recherche est publique, limitée à 30 requêtes
// par minute et par adresse IP (compteur en base, adresse jamais gardée en clair).
//
//   GET /search?q=NE555&cur=EUR → { query, currency, results: [{ mpn, manufacturer, source, ship_from, availability, price_from }] }
//
// Le détail réservé aux comptes et à l'API (quantités exactes, paliers, délai, commande) n'est jamais renvoyé ici.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const ORIGINS = (Deno.env.get('SEARCH_ORIGINS') || 'https://central.parts').split(',');

Deno.serve(async (req) => {
  const origin = req.headers.get('origin') || '';
  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': ORIGINS.includes(origin) ? origin : ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Content-Type': 'application/json',
    Vary: 'Origin',
  };
  if (req.method === 'OPTIONS') return new Response(null, { headers });
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers });
  if (req.method !== 'GET') return json({ error: 'method' }, 405);

  const u = new URL(req.url);
  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || req.headers.get('x-real-ip') || '';
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const { data, error } = await db.rpc('public_search', { p_ip: ip, q: u.searchParams.get('q') || '', p_currency: u.searchParams.get('cur') || 'EUR' });
  if (error) {
    if (error.code === '22023') return json({ error: 'too_short' }, 422);
    if (error.code === 'CP429') return json({ error: 'rate_limited' }, 429);
    return json({ error: 'server' }, 500);
  }
  return json(data);
});
