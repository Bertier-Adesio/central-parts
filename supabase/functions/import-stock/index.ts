// Fonction Edge « import-stock » : transforme un fichier de stock déposé en lots.
//
// Appel : POST /functions/v1/import-stock {"import_id": "IMP-0100"}
//   - par un webhook de base de données sur l'insertion dans public.stock_imports (Database Webhooks) ;
//   - ou à la main, pour relancer un import.
// La fonction utilise la clé service_role fournie par Supabase à l'exécution : jamais de clé dans le code.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import * as XLSX from 'npm:xlsx@0.18.5';
import { decode, mapRows, parseCSV } from './parse.js';

const BATCH = 2000; // lignes par appel à apply_stock_import_batch

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST attendu' }, 405);
  const body = await req.json().catch(() => ({}));
  // Webhook : { type: 'INSERT', record: {...} } ; appel direct : { import_id }
  const id: string | undefined = body.import_id || body.record?.id;
  if (!id) return json({ error: 'import_id requis' }, 422);

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });
  const { data: imp, error } = await db.from('stock_imports').select('*').eq('id', id).single();
  if (error || !imp) return json({ error: 'Import inconnu' }, 404);
  if (imp.status !== 'received') return json({ id, status: imp.status, skipped: true });

  try {
    const file = await db.storage.from('stock-imports').download(imp.storage_path);
    if (file.error) throw new Error('Fichier illisible : ' + file.error.message);
    const buf = new Uint8Array(await file.data.arrayBuffer());

    let table: string[][];
    if (imp.format === 'csv') {
      table = parseCSV(decode(buf));
    } else {
      const wb = XLSX.read(buf, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      table = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' }) as string[][];
    }

    const parsed = mapRows(table);
    if (parsed.error) throw new Error(parsed.error);

    // Envoi par paquets ; les lignes rejetées à la lecture partent avec le premier paquet.
    for (let i = 0; i === 0 || i < parsed.rows.length; i += BATCH) {
      const { error: e } = await db.rpc('apply_stock_import_batch', {
        p_import: id,
        p_rows: parsed.rows.slice(i, i + BATCH),
        p_rejected: i === 0 ? parsed.rejected : [],
      });
      if (e) throw new Error(e.message);
    }
    const { data: done, error: e2 } = await db.rpc('finish_stock_import', { p_import: id });
    if (e2) throw new Error(e2.message);
    return json(done);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.rpc('finish_stock_import', { p_import: id, p_error: message });
    return json({ id, status: 'failed', error: message }, 422);
  }
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
