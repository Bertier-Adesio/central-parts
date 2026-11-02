-- Tests de 20261102000015 : identifiants au-delà de 9999 et rapprochement des lots par index (avec ou sans SKU).
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

-- 1. app.ref : plus de troncature au-delà de la largeur.
create sequence tests.seq start 9998;
do $$ begin
  perform tests.eq('référence : 9998 complété sur 4 chiffres', app.ref('T', 'tests.seq'), 'T-9998');
  perform tests.eq('référence : 9999', app.ref('T', 'tests.seq'), 'T-9999');
  perform tests.eq('référence : 10000 écrit en entier (lpad tronquait en T-1000)', app.ref('T', 'tests.seq'), 'T-10000');
  perform tests.eq('référence : 10001 distinct de 10000', app.ref('T', 'tests.seq'), 'T-10001');
  perform tests.eq('référence : petits numéros inchangés', app.ref('T', 'tests.seq', 6) like 'T-%', true);
end $$;

-- 2. Lots au-delà de LOT-9999 : création sans collision.
insert into public.organizations (id, type, name, alias, currency, kyb) values ('IMP15', 'seller', 'Import rapide (fictif)', 'V-IMP15', 'USD', 'validated');
insert into public.stock_imports (id, org_id, storage_path, file_name, format, replace_all)
values ('IMP-T15A', 'IMP15', 'IMP15/a.csv', 'a.csv', 'csv', true);
select setval('app.lot_seq', greatest((select last_value from app.lot_seq), 9999));
set role service_role;
do $$
declare res jsonb;
begin
  -- avec SKU (3 lignes) et sans SKU (2 lignes, même référence, dates codes différentes)
  res := public.apply_stock_import_batch('IMP-T15A', '[
    {"line": 2, "mpn": "A15-1", "sku": "S1", "qty": "10", "price": "1.0", "tiers": {"1": "1.2", "100": "1.0"}},
    {"line": 3, "mpn": "A15-2", "sku": "S2", "qty": "20", "price": "2.0"},
    {"line": 4, "mpn": "A15-3", "sku": "S3", "qty": "30", "price": "3.0"},
    {"line": 5, "mpn": "B15", "dc": "2401", "qty": "40", "price": "4.0"},
    {"line": 6, "mpn": "B15", "dc": "2402", "qty": "50", "price": "5.0"}]'::jsonb);
  perform tests.eq('import au-delà de LOT-9999 : 5 lots créés sans collision', res->>'created', '5');
end $$;
reset role;
do $$ begin
  perform tests.eq('identifiants distincts', (select count(distinct id) from public.lots where seller_id = 'IMP15'), 5::bigint);
  perform tests.eq('identifiants à 5 chiffres', (select bool_and(id ~ '^LOT-\d{5}$') from public.lots where seller_id = 'IMP15'), true);
end $$;

-- 3. Réimport : les mêmes lignes mettent à jour les lots (par SKU, ou par référence et date code sans SKU).
insert into public.stock_imports (id, org_id, storage_path, file_name, format, replace_all)
values ('IMP-T15B', 'IMP15', 'IMP15/b.csv', 'b.csv', 'csv', true);
set role service_role;
do $$
declare res jsonb;
begin
  res := public.apply_stock_import_batch('IMP-T15B', '[
    {"line": 2, "mpn": "A15-1", "sku": "S1", "qty": "11", "price": "1.0", "tiers": {"1": "1.3"}},
    {"line": 5, "mpn": "b15", "dc": "2401", "qty": "41", "price": "4.0"}]'::jsonb);
  perform tests.eq('réimport : 2 mises à jour, aucune création', (res->>'updated') || '/' || (res->>'created'), '2/0');
end $$;
reset role;
do $$ begin
  perform tests.eq('réimport par SKU : quantité et paliers remplacés',
    (select qty || ' ' || (select string_agg(min_qty || ':' || unit_price::numeric(6,2), ',' order by min_qty) from public.lot_price_breaks b where b.lot_id = l.id)
       from public.lots l where seller_id = 'IMP15' and sku = 'S1'), '11 1:1.30');
  perform tests.eq('réimport sans SKU : rapproché par référence et date code (majuscules)',
    (select qty from public.lots where seller_id = 'IMP15' and sku is null and date_code = '2401'), 41);
  perform tests.eq('réimport sans SKU : l''autre date code reste distinct',
    (select qty from public.lots where seller_id = 'IMP15' and sku is null and date_code = '2402'), 50);
end $$;

drop schema tests cascade;
select 'Tous les tests de l''import rapide sont passés.' as resultat;
