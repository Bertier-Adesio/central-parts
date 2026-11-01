// Fonction Edge « listes » : dépôt des listes de stock par lien personnel, sans connexion WeChat (ADR 0021).
// Appelée par la page https://central.parts/depot/lien/ ; déployée sans vérification de jeton Supabase
// (--no-verify-jwt) : chaque appel porte le jeton du lien personnel, vérifié par la base (empreinte SHA-256).
//
//   GET  /listes/me          → vendeur du lien et état de ses offres (en ligne, à reconfirmer, seuil)
//   POST /listes/upload-url  {file_name} → lien de dépôt signé ; le fichier remplace toujours la liste précédente
//   GET  /listes/imports     → 20 derniers dépôts du vendeur et leur rapport (lignes rejetées avec leur code)
//
// Le vendeur ne voit jamais que ses propres données. Le jeton n'est jamais écrit dans les journaux.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { storagePath } from '../_shared/depot.js';

const ORIGINS = (Deno.env.get('LISTES_ORIGINS') || 'https://central.parts').split(',');

Deno.serve(async (req) => {
  const origin = req.headers.get('origin') || '';
  const cors: Record<string, string> = {
    'Access-Control-Allow-Origin': ORIGINS.includes(origin) ? origin : ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    Vary: 'Origin',
  };
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });
  const path = new URL(req.url).pathname;

  try {
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: who } = token ? await db.rpc('depot_link_identity', { p_token: token }) : { data: null };
    if (!who) return json({ error: 'link_invalid' }, 401);
    const org: string = who.org_id;

    if (req.method === 'GET' && path.endsWith('/me')) {
      const { data: status } = await db.rpc('seller_offer_status', { p_org: org });
      return json({ name: who.name, currency: who.currency, ttl_days: who.ttl_days, status });
    }

    if (req.method === 'POST' && path.endsWith('/upload-url')) {
      const { file_name } = await req.json().catch(() => ({}));
      const key = storagePath(org, file_name, { complete: true });
      if (!key) return json({ error: 'format' }, 422);
      const { data, error } = await db.storage.from('stock-imports').createSignedUploadUrl(key);
      if (error) return json({ error: 'storage' }, 500);
      return json({ signed_url: data.signedUrl, path: key, max_bytes: 52428800 });
    }

    if (req.method === 'GET' && path.endsWith('/imports')) {
      const { data, error } = await db.from('stock_imports')
        .select('id, file_name, status, rows_total, created, updated, rejected, withdrawn, error, report, received_at, processed_at')
        .eq('org_id', org).order('received_at', { ascending: false }).limit(20);
      if (error) return json({ error: 'database' }, 500);
      return json(data.map((i) => ({ ...i, report: { rejected: (i.report?.rejected || []).slice(0, 200) } })));
    }

    return json({ error: 'not_found' }, 404);
  } catch {
    return json({ error: 'server' }, 500);
  }
});
