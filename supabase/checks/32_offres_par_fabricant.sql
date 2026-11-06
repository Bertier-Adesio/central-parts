-- Tests de la recherche rapide par fabricant des offres publiques (migration 20261106000038). Vendeurs et lots
-- fictifs. Prérequis : checks précédents. Lancé par tools/test-db.sh.
\set ON_ERROR_STOP 1

create schema if not exists tests;
create or replace function tests.eq(label text, got anyelement, want anyelement) returns void language plpgsql as $$
begin
  if got is distinct from want then raise exception 'ÉCHEC % : obtenu %, attendu %', label, got, want; end if;
  raise notice 'ok  %', label;
end $$;
grant usage on schema tests to service_role, authenticated, anon;
grant execute on all functions in schema tests to service_role, authenticated, anon;

insert into public.organizations (id, type, name, alias, city, country, currency, lang, profile, kyb) values
  ('MF1', 'seller', 'Vendeur fabricants (fictif)', 'tmp-MF1', 'Shenzhen', 'CN', 'USD', 'zh', 'Distributor', 'pending');
select public.approve_supplier('MF1', 'test');
insert into public.lots (id, seller_id, source, sku, mpn, manufacturer, qty, unit_price, currency, confirmed_at) values
  ('LOT-MF1', 'MF1', 'file', 'MF-1', 'MFRQTEST01', 'Fabricant Alpha', 1000, 0.10, 'USD', now()),
  ('LOT-MF2', 'MF1', 'file', 'MF-2', 'MFRQTEST02', 'FABRICANT ALPHA', 2000, 0.10, 'USD', now()),
  ('LOT-MF3', 'MF1', 'file', 'MF-3', 'MFRQTEST03', 'Fabricant Beta', 500, 0.10, 'USD', now());

set role service_role;
do $$
declare r jsonb := public.partner_offers('10.9.5.1', 'MFRQTEST', 'EUR');
  f jsonb := public.partner_offers('10.9.5.2', 'MFRQTEST', 'EUR', 'fabricant alpha');
  g jsonb := public.partner_offers('10.9.5.3', '', 'EUR', 'Fabricant Beta');
begin
  perform tests.eq('fabricants de la recherche, regroupés sans tenir compte de la casse',
    (select string_agg((x->>'name') || ':' || (x->>'offers'), ' ' order by x->>'name') from jsonb_array_elements(r->'manufacturers') x), 'Fabricant Alpha:2 Fabricant Beta:1');
  perform tests.eq('filtre fabricant : offres et totaux filtrés', jsonb_array_length(f->'offers') || ' ' || (f->>'total_offers') || ' ' || (f->>'total_units') || ' ' || (f->>'manufacturer'),
    '2 2 3000 FABRICANT ALPHA');
  perform tests.eq('filtre fabricant : boutons inchangés (sans le filtre)', jsonb_array_length(f->'manufacturers'), 2);
  perform tests.eq('filtre fabricant sans recherche de référence', (select bool_and(x->>'manufacturer' = 'Fabricant Beta') from jsonb_array_elements(g->'offers') x)
    and jsonb_array_length(g->'offers') >= 1, true);
end $$;
reset role;

drop schema tests cascade;
select 'Tous les tests de la recherche par fabricant sont passés.' as resultat;
