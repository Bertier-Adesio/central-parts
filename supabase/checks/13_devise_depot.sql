-- Tests de 20261102000017 : devise choisie au dépôt et provenance de la devise de chaque ligne.
-- Prérequis : checks précédents. Lancé par tools/test-db.sh.
\set ON_ERROR_STOP 1

create schema if not exists tests;
create or replace function tests.eq(label text, got anyelement, want anyelement) returns void language plpgsql as $$
begin
  if got is distinct from want then raise exception 'ÉCHEC % : obtenu %, attendu %', label, got, want; end if;
  raise notice 'ok  %', label;
end $$;
grant usage on schema tests to service_role, authenticated, anon;
grant execute on all functions in schema tests to service_role, authenticated, anon;

-- Dépôts dans le dossier du vendeur S2 (société réglée en USD) : avec devise choisie, sans, et avec un code inconnu.
insert into storage.objects (bucket_id, name) values
  ('stock-imports', 'S2/20261102-120000-prix-complet-devise-EUR.csv'),
  ('stock-imports', 'S2/20261102-120100-prix.csv'),
  ('stock-imports', 'S2/20261102-120200-prix-devise-XYZ.csv');
do $$ begin
  perform tests.eq('dépôt : devise choisie lue dans le nom', (select currency from public.stock_imports where storage_path like '%120000-prix-complet-devise-EUR.csv'), 'EUR');
  perform tests.eq('dépôt : fichier complet toujours reconnu', (select replace_all from public.stock_imports where storage_path like '%120000%'), true);
  perform tests.eq('dépôt sans choix : pas de devise', (select currency from public.stock_imports where storage_path like '%120100-prix.csv'), null::text);
  perform tests.eq('dépôt : code de devise inconnu ignoré', (select currency from public.stock_imports where storage_path like '%devise-XYZ.csv'), null::text);
end $$;

set role service_role;
do $$
declare v_a text := (select id from public.stock_imports where storage_path like '%120000%');
        v_b text := (select id from public.stock_imports where storage_path like '%120100%');
begin
  -- Ligne avec devise dans le fichier (USD) et ligne sans devise : la seconde prend la devise choisie (EUR).
  perform public.apply_stock_import_batch(v_a, '[
    {"line": 2, "mpn": "DEV17-A", "sku": "D17A", "qty": "10", "price": "1", "currency": "USD"},
    {"line": 3, "mpn": "DEV17-B", "sku": "D17B", "qty": "10", "price": "1"},
    {"line": 4, "mpn": "DEV17-C", "sku": "D17C", "qty": "10", "price": "1"}]'::jsonb);
  -- Sans devise choisie ni dans le fichier : devise de la société (USD).
  perform public.apply_stock_import_batch(v_b, '[{"line": 2, "mpn": "DEV17-D", "sku": "D17D", "qty": "10", "price": "1"}]'::jsonb);
end $$;
reset role;
do $$ begin
  perform tests.eq('ligne avec devise dans le fichier : USD', (select currency from public.lots where seller_id = 'S2' and sku = 'D17A'), 'USD');
  perform tests.eq('ligne sans devise : devise choisie au dépôt (EUR)', (select currency from public.lots where seller_id = 'S2' and sku = 'D17B'), 'EUR');
  perform tests.eq('rapport : lignes comptées par devise et provenance',
    (select currency_used from public.stock_imports where storage_path like '%120000%'), '{"EUR|upload": 2, "USD|file": 1}'::jsonb);
  perform tests.eq('sans choix au dépôt : devise de la société', (select currency from public.lots where seller_id = 'S2' and sku = 'D17D'), 'USD');
  perform tests.eq('rapport : provenance « société »',
    (select currency_used from public.stock_imports where storage_path like '%120100%'), '{"USD|company": 1}'::jsonb);
end $$;

-- Second paquet du même import : les compteurs s'additionnent.
set role service_role;
do $$ begin
  perform public.apply_stock_import_batch((select id from public.stock_imports where storage_path like '%120000%'),
    '[{"line": 5, "mpn": "DEV17-E", "sku": "D17E", "qty": "10", "price": "1"}]'::jsonb);
end $$;
reset role;
do $$ begin
  perform tests.eq('paquets successifs : compteurs additionnés',
    (select currency_used from public.stock_imports where storage_path like '%120000%'), '{"EUR|upload": 3, "USD|file": 1}'::jsonb);
end $$;

-- Back office : le dernier import porte la devise choisie et sa provenance.
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000e1';
do $$
declare li jsonb := public.admin_supplier('S2')->'last_import';
begin
  perform tests.eq('back office : dernier import avec devise et provenance', li ? 'currency_used' and li ? 'currency', true);
end $$;
reset role;

drop schema tests cascade;
select 'Tous les tests de la devise au dépôt sont passés.' as resultat;
