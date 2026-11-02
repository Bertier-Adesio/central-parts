-- Tests de 20261102000019 : prix publics dans la devise du fournisseur, sans conversion, devise sur chaque offre.
-- Prérequis : 14_prix_1ku.sql (lots LOT-K1 et LOT-K2 du vendeur S2, en USD, marge 10 %). Lancé par tools/test-db.sh.
\set ON_ERROR_STOP 1

create schema if not exists tests;
create or replace function tests.eq(label text, got anyelement, want anyelement) returns void language plpgsql as $$
begin
  if got is distinct from want then raise exception 'ÉCHEC % : obtenu %, attendu %', label, got, want; end if;
  raise notice 'ok  %', label;
end $$;
grant usage on schema tests to service_role, authenticated, anon;
grant execute on all functions in schema tests to service_role, authenticated, anon;

-- Même référence chez un second vendeur vérifié, en EUR : deux offres distinctes, chacune dans sa devise.
insert into public.organizations (id, type, name, alias, city, country, currency, lang, profile, kyb)
values ('K-EUR', 'seller', 'Vendeur en euros (fictif)', 'V-KEUR', 'Hong Kong', 'HK', 'EUR', 'en', 'Broker', 'validated');
insert into public.subscriptions (org_id, plan, until) values ('K-EUR', 'Test', current_date + 30);
insert into app.seller_margins (org_id, margin_pct) values ('K-EUR', 10);
insert into public.lots (id, seller_id, source, sku, mpn, manufacturer, qty, unit_price, currency)
values ('LOT-K3', 'K-EUR', 'file', 'K3', 'PRIX1K-A', 'Fictif', 500, 2.00, 'EUR');

set role service_role;
do $$
declare r jsonb; usd jsonb; eur jsonb; o jsonb;
begin
  r := public.public_search('test-19', 'PRIX1K-A', 'EUR')->'results';
  usd := (select e from jsonb_array_elements(r) e where e->>'currency' = 'USD');
  eur := (select e from jsonb_array_elements(r) e where e->>'currency' = 'EUR');
  perform tests.eq('recherche : offre du vendeur en USD restée en USD malgré une demande en EUR', (usd->>'price_from')::numeric, 0.88);
  perform tests.eq('recherche : prix 1KU en USD, sans conversion', (usd->>'price_1k')::numeric, 1.10);
  perform tests.eq('recherche : offre du vendeur en EUR en EUR (2,00 + 10 %)', (eur->>'price_from')::numeric, 2.20);
  perform tests.eq('recherche : une offre par devise', jsonb_array_length(r), 2);
  perform tests.eq('recherche : même résultat quelle que soit la devise demandée',
    (select e->>'price_from' from jsonb_array_elements(public.public_search('test-19b', 'PRIX1K-A', 'CNH')->'results') e where e->>'currency' = 'USD'), '0.8800');
  o := (select e from jsonb_array_elements(public.partner_offers('test-19', 'PRIX1K-A', 'EUR')->'offers') e where e->>'currency' = 'USD');
  perform tests.eq('offres : prix en USD, devise indiquée', (o->>'price_from') || ' ' || (o->>'currency'), '0.8800 USD');
end $$;
reset role;

drop schema tests cascade;
select 'Tous les tests des prix en devise du fournisseur sont passés.' as resultat;
