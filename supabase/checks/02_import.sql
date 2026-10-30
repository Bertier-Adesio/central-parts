-- Tests du dépôt de fichiers de stock, de leur transformation en lots et de l'API search_stock.
-- Prérequis : 00_stub_supabase.sql, les migrations, seed.sql et 01_rls.sql (comptes de test). Lancé par tools/test-db.sh.
\set ON_ERROR_STOP 1

create schema if not exists tests;
create or replace function tests.eq(label text, got anyelement, want anyelement) returns void language plpgsql as $$
begin
  if got is distinct from want then raise exception 'ÉCHEC % : obtenu %, attendu %', label, got, want; end if;
  raise notice 'ok  %', label;
end $$;
grant usage on schema tests to authenticated, anon, service_role;

-- ---------------------------------------------------------------- dépôt (rôle du stockage)
insert into storage.objects (bucket_id, name) values
  ('stock-imports', 'S2/stock-2026-10-30.csv'),
  ('stock-imports', 'INCONNU/stock.csv'),
  ('stock-imports', 'S2/notes.pdf');
do $$ begin
  perform tests.eq('dépôt S2 : import reçu', (select status from public.stock_imports where storage_path = 'S2/stock-2026-10-30.csv'), 'received');
  perform tests.eq('dépôt S2 : format CSV', (select format from public.stock_imports where storage_path = 'S2/stock-2026-10-30.csv'), 'csv');
  perform tests.eq('dossier inconnu : échec', (select status from public.stock_imports where storage_path = 'INCONNU/stock.csv'), 'failed');
  perform tests.eq('PDF refusé', (select error from public.stock_imports where storage_path = 'S2/notes.pdf'), 'Format non pris en charge : CSV, XLS ou XLSX');
end $$;

-- ---------------------------------------------------------------- transformation (fonction Edge → service_role)
set role service_role;
do $$
declare imp text := (select id from public.stock_imports where storage_path = 'S2/stock-2026-10-30.csv');
        res jsonb;
begin
  res := public.apply_stock_import_batch(imp, '[
    {"line": 2, "mpn": "ep2c5t144c8n", "mfr": "Intel", "sku": "HB-1", "qty": 900, "dc": "2012", "price": 4.2, "currency": "USD", "tiers": {"100": 4.0, "1000": 3.8}},
    {"line": 3, "mpn": "XC2S50-5TQ144C", "mfr": "AMD Xilinx", "sku": "HB-2", "qty": 1200, "dc": "2011", "currency": "RMB", "tiers": {}},
    {"line": 4, "mpn": "LM358DR", "sku": "HB-3", "qty": 50, "dc": "", "currency": "XYZ"},
    {"line": 5, "mpn": "NE555DR", "sku": "HB-4", "qty": 0, "dc": "2020"}
  ]', '[{"line": 6, "reason": "MPN manquant"}]');
  perform tests.eq('paquet : 2 lots créés', (res->>'created')::int, 2);
  perform tests.eq('paquet : 3 lignes rejetées (devise, quantité, lecture)', (res->>'rejected')::int, 3);
  perform tests.eq('doublon signalé (même référence, date code et quantité que LOT-101)', (res->>'duplicates')::int, 1);
  perform tests.eq('import en cours', (select status from public.stock_imports where id = imp), 'processing');
  perform tests.eq('lot en majuscules, source fichier', (select source || ':' || mpn from public.lots where sku = 'HB-1'), 'file:EP2C5T144C8N');
  perform tests.eq('RMB enregistré en CNH', (select currency from public.lots where sku = 'HB-2'), 'CNH');
  perform tests.eq('paliers enregistrés', (select count(*) from public.lot_price_breaks b join public.lots l on l.id = b.lot_id where l.sku = 'HB-1'), 2::bigint);
  perform public.finish_stock_import(imp);
  perform tests.eq('import terminé', (select status || ' ' || rows_total || ' lignes' from public.stock_imports where id = imp), 'done 5 lignes');
  perform tests.eq('rapport : lignes rejetées', (select jsonb_array_length(report->'rejected') from public.stock_imports where id = imp), 3);
  perform tests.eq('journal alimenté', (select count(*) from public.events where text like 'Import ' || imp || '%'), 1::bigint);
  begin
    perform public.apply_stock_import_batch(imp, '[]');
    raise exception 'ÉCHEC import terminé modifiable';
  exception when raise_exception then
    if sqlerrm like 'ÉCHEC%' then raise; end if; raise notice 'ok  import terminé non modifiable';
  end;
end $$;
reset role;

-- Fichier complet : même SKU mis à jour, lots absents remis à 0, lots non issus d'un fichier inchangés.
insert into storage.objects (bucket_id, name) values ('stock-imports', 'S2/stock-complet.xlsx');
set role service_role;
do $$
declare imp text := (select id from public.stock_imports where storage_path = 'S2/stock-complet.xlsx');
        res jsonb;
begin
  perform tests.eq('fichier « complet » : remplacement demandé', (select replace_all from public.stock_imports where id = imp), true);
  res := public.apply_stock_import_batch(imp, '[{"line": 2, "mpn": "EP2C5T144C8N", "sku": "HB-1", "qty": 750, "dc": "2012", "currency": "USD"}]');
  perform tests.eq('même SKU : lot mis à jour', (res->>'updated')::int, 1);
  perform public.finish_stock_import(imp);
  perform tests.eq('quantité mise à jour', (select qty from public.lots where sku = 'HB-1'), 750);
  perform tests.eq('lot absent du fichier complet remis à 0', (select qty from public.lots where sku = 'HB-2'), 0);
  perform tests.eq('un lot retiré', (select withdrawn from public.stock_imports where id = imp), 1);
  perform tests.eq('lot venu de l''API inchangé', (select qty from public.lots where id = 'LOT-102'), 400);
end $$;
reset role;

-- ---------------------------------------------------------------- droits
-- Acheteur : ni transformation, ni lecture des imports d'un vendeur ; recherche autorisée.
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
do $$ begin
  begin perform public.apply_stock_import_batch('IMP-0100', '[]'); raise exception 'ÉCHEC acheteur transforme un import';
  exception when insufficient_privilege then raise notice 'ok  acheteur : transformation refusée'; end;
  perform tests.eq('acheteur : aucun import visible', (select count(*) from public.stock_imports), 0::bigint);
  perform tests.eq('API : lot importé trouvé', (select jsonb_array_length(public.search_stock('ep2c5')->'opportunity')), 1);
  perform tests.eq('API : quantité agrégée, sans vendeur', (select (public.search_stock('EP2C5T144C8N')->'opportunity'->0) - 'date_codes'),
                   '{"mpn": "EP2C5T144C8N", "lots": 1, "quantity": 750, "verified": true, "manufacturer": "Intel"}'::jsonb);
  perform tests.eq('API : lot à 0 exclu', (select (public.search_stock('XC2S50')->'opportunity'->0->>'lots')::int), 2);
  perform tests.eq('API : Inventory inclus', (select jsonb_array_length(public.search_stock('NE555')->'inventory')), 1);
  begin perform public.search_stock('E'); raise exception 'ÉCHEC recherche d''un caractère';
  exception when invalid_parameter_value then raise notice 'ok  recherche : au moins 2 caractères'; end;
end $$;
reset role;

-- Vendeur S2 : voit ses imports ; vendeur S3 : rien, et ne peut pas déposer dans le dossier de S2.
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
do $$ begin
  perform tests.eq('vendeur S2 : ses 3 imports (dont le PDF refusé)', (select count(*) from public.stock_imports), 3::bigint);
end $$;
reset role;
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a3';
do $$ begin
  perform tests.eq('vendeur S3 : aucun import de S2', (select count(*) from public.stock_imports), 0::bigint);
  begin insert into storage.objects (bucket_id, name) values ('stock-imports', 'S2/intrus.csv'); raise exception 'ÉCHEC dépôt dans le dossier d''un autre';
  exception when insufficient_privilege then raise notice 'ok  dépôt dans le dossier d''un autre vendeur refusé'; end;
  insert into storage.objects (bucket_id, name) values ('stock-imports', 'S3/stock.csv');
  perform tests.eq('vendeur S3 : dépôt dans son dossier', (select count(*) from public.stock_imports where org_id = 'S3'), 1::bigint);
end $$;
reset role;
-- Visiteur anonyme : pas d'API.
set role anon;
do $$ begin
  begin perform public.search_stock('XC2S50'); raise exception 'ÉCHEC anonyme interroge l''API';
  exception when insufficient_privilege then raise notice 'ok  anonyme : API refusée'; end;
end $$;
reset role;

drop schema tests cascade;
select 'Tous les tests d''import sont passés.' as resultat;
