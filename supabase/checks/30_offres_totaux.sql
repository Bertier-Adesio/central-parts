-- Tests du nombre de références et de la taille de l'inventaire des offres publiques (migration 20261106000036).
-- Vendeurs et lots fictifs. Prérequis : checks précédents. Lancé par tools/test-db.sh.
\set ON_ERROR_STOP 1

create schema if not exists tests;
create or replace function tests.eq(label text, got anyelement, want anyelement) returns void language plpgsql as $$
begin
  if got is distinct from want then raise exception 'ÉCHEC % : obtenu %, attendu %', label, got, want; end if;
  raise notice 'ok  %', label;
end $$;
grant usage on schema tests to service_role, authenticated, anon;
grant execute on all functions in schema tests to service_role, authenticated, anon;

-- Deux vendeurs fictifs : deux offres pour la même référence, une autre référence, une offre à zéro, une offre expirée.
insert into public.organizations (id, type, name, alias, city, country, currency, lang, profile, kyb) values
  ('TT1', 'seller', 'Vendeur totaux 1 (fictif)', 'tmp-TT1', 'Shenzhen', 'CN', 'USD', 'zh', 'Distributor', 'pending'),
  ('TT2', 'seller', 'Vendeur totaux 2 (fictif)', 'tmp-TT2', 'Hong Kong', 'HK', 'USD', 'en', 'Distributor', 'pending');
select public.approve_supplier('TT1', 'test'), public.approve_supplier('TT2', 'test');
insert into public.lots (id, seller_id, source, sku, mpn, manufacturer, qty, unit_price, currency, confirmed_at) values
  ('LOT-TT1', 'TT1', 'file', 'TT-1', 'TOTTEST01', 'Test Semi', 1000, 0.10, 'USD', now()),
  ('LOT-TT2', 'TT2', 'file', 'TT-2', 'tottest01', 'Test Semi', 2500, 0.11, 'USD', now()),
  ('LOT-TT3', 'TT1', 'file', 'TT-3', 'TOTTEST02', 'Test Semi', 500, 0.20, 'USD', now()),
  ('LOT-TT4', 'TT1', 'file', 'TT-4', 'TOTTEST03', 'Test Semi', 0, 0.20, 'USD', now()),
  ('LOT-TT5', 'TT2', 'file', 'TT-5', 'TOTTEST04', 'Test Semi', 900, 0.20, 'USD', now() - interval '60 days');

set role service_role;
do $$
declare r jsonb := public.partner_offers('10.9.3.1', 'TOTTEST', 'EUR'); a jsonb := public.partner_offers('10.9.3.2', '', 'EUR');
begin
  perform tests.eq('recherche : références distinctes, offres et pièces en ligne', (r->>'total_refs') || ' ' || (r->>'total_offers') || ' ' || (r->>'total_units'), '2 3 4000');
  perform tests.eq('recherche : offres affichées cohérentes', jsonb_array_length(r->'offers'), 3);
  perform tests.eq('sans recherche : totaux sur tout le catalogue, au-delà des 50 offres affichées',
    (a->>'total_offers')::int >= 3 and (a->>'total_offers')::int >= jsonb_array_length(a->'offers') and (a->>'total_units')::bigint >= 4000, true);
end $$;
reset role;

drop schema tests cascade;
select 'Tous les tests des totaux des offres sont passés.' as resultat;
