-- Tests des conditions de vente propres à un fournisseur (migration 20261103000029). Vendeurs, lots et conditions
-- fictifs. Prérequis : checks précédents (taux fictifs de seed.sql : 1 USD = 0,92 EUR). Lancé par tools/test-db.sh.
\set ON_ERROR_STOP 1

create schema if not exists tests;
create or replace function tests.eq(label text, got anyelement, want anyelement) returns void language plpgsql as $$
begin
  if got is distinct from want then raise exception 'ÉCHEC % : obtenu %, attendu %', label, got, want; end if;
  raise notice 'ok  %', label;
end $$;
grant usage on schema tests to service_role, authenticated, anon;
grant execute on all functions in schema tests to service_role, authenticated, anon;

-- Deux fournisseurs fictifs : CT1 a ses propres conditions (DAP, livraison offerte dès 2 000 USD), CT2 suit la règle
-- de Central.Parts (app.settings « default_terms »).
insert into public.organizations (id, type, name, alias, city, country, currency, lang, profile, kyb) values
  ('CT1', 'seller', 'Distributeur avec conditions (fictif)', 'tmp-CT1', 'Hong Kong', 'HK', 'USD', 'en', 'Distributor', 'pending'),
  ('CT2', 'seller', 'Distributeur sans conditions (fictif)', 'tmp-CT2', 'Shenzhen', 'CN', 'USD', 'zh', 'Distributor', 'pending');
insert into app.price_rules (category, margin_pct) values ('distributor', 10) on conflict (category) do update set margin_pct = 10;
select public.approve_supplier('CT1', 'test'), public.approve_supplier('CT2', 'test');
insert into public.lots (id, seller_id, source, sku, mpn, manufacturer, qty, unit_price, currency, confirmed_at) values
  ('LOT-CT1', 'CT1', 'file', 'CT-1', 'CONDTEST01', 'Test Semi', 100000, 1.00, 'USD', now()),
  ('LOT-CT2', 'CT2', 'file', 'CT-2', 'CONDTEST02', 'Test Semi', 100000, 1.00, 'USD', now());
insert into app.seller_terms (org_id, incoterm, free_shipping_over, free_shipping_currency, carriers, ship_within_hours,
  transit_days_min, transit_days_max, prepaid, returns_days, returns_quality_only, restocking_pct, warranty_days)
values ('CT1', 'DAP', 2000, 'USD', '{DHL,FedEx,UPS,SF}', 24, 5, 7, true, 30, true, 15, 90);

set role service_role;
do $$
declare o jsonb; q jsonb; s jsonb; g1 jsonb; g2 jsonb;
begin
  o := (select e from jsonb_array_elements(public.partner_offers('10.24.0.1', 'CONDTEST01', 'EUR')->'offers') e);
  perform tests.eq('offres : DAP et seuil converti en euros (2 000 USD × 0,92)', (o->>'incoterm') || ' ' || (o->'terms'->>'free_shipping_over'), 'DAP 1840');
  perform tests.eq('offres : transporteurs, délais, retours, garantie',
    (o->'terms'->'carriers')::text || ' ' || (o->'terms'->>'transit_days_min') || '-' || (o->'terms'->>'transit_days_max') || ' ' ||
    (o->'terms'->>'returns_days') || ' ' || (o->'terms'->>'warranty_days'), '["DHL", "FedEx", "UPS", "SF"] 5-7 30 90');
  perform tests.eq('offres : jamais le nom du fournisseur', o::text ~* 'CT1|Distributeur avec', false);
  o := (select e from jsonb_array_elements(public.partner_offers('10.24.0.1', 'CONDTEST02', 'EUR')->'offers') e);
  perform tests.eq('offres : sans exception, règle de Central.Parts (DAP, offerte dès 2 000 €, garantie 90 jours)',
    (o->>'incoterm') || ' ' || (o->'terms'->>'free_shipping_over') || ' ' || (o->'terms'->>'warranty_days'), 'DAP 2000 90');
  q := public.public_quote('CONDTEST01', 'distributor', 'HK', 10, 'EUR');
  perform tests.eq('devis : incoterm et conditions du lot retenu', (q->>'incoterm') || ' ' || (q->'terms'->>'free_shipping_over'), 'DAP 1840');
  perform tests.eq('recherche : conditions du fournisseur unique du groupe',
    (select (e->>'incoterm') || ' ' || (e->'terms'->>'warranty_days') from jsonb_array_elements(public.public_search('10.24.0.2', 'CONDTEST01', 'EUR')->'results') e), 'DAP 90');

  -- Panier : 1 000 pièces chez CT1 (1 012 €) et 10 chez CT2 : deux groupes, livraison non offerte, montant manquant.
  s := public.cart_shipping('10.24.0.3', '{"currency": "EUR", "lines": [
    {"mpn": "CONDTEST01", "source": "distributor", "ship_from": "HK", "qty": "1000"},
    {"mpn": "CONDTEST02", "source": "distributor", "ship_from": "CN", "qty": "10"}]}');
  g1 := s->'groups'->0; g2 := s->'groups'->1;
  perform tests.eq('panier : deux groupes de fournisseurs, numérotés', jsonb_array_length(s->'groups') || ' ' || (g1->>'group') || (g2->>'group'), '2 12');
  perform tests.eq('panier : groupe 1, sous-total et montant manquant (1 840 − 1 012)', (g1->>'subtotal') || ' ' || (g1->>'free_shipping') || ' ' || (g1->>'missing_for_free'), '1012.00 false 828.00');
  perform tests.eq('panier : groupe 2, règle de Central.Parts, encore 1 989,88 € pour la livraison offerte (10 × 1,012 €)',
    (g2->>'incoterm') || ' ' || (g2->>'free_shipping') || ' ' || (g2->>'missing_for_free'), 'DAP false 1989.88');
  perform tests.eq('panier : jamais le fournisseur', s::text ~* 'CT1|CT2|Distributeur', false);
  s := public.cart_shipping('10.24.0.4', '{"currency": "EUR", "lines": [{"mpn": "CONDTEST01", "source": "distributor", "ship_from": "HK", "qty": "2000"}]}');
  perform tests.eq('panier : livraison offerte au-delà du seuil', (s->'groups'->0->>'free_shipping') || ' ' || coalesce(s->'groups'->0->>'missing_for_free', '-'), 'true -');
end $$;
reset role;

set role anon;
do $$ begin
  begin perform public.cart_shipping('x', '{}'); raise exception 'ÉCHEC livraison lisible par anon';
  exception when insufficient_privilege then raise notice 'ok  livraison réservée à la fonction Edge'; end;
end $$;
reset role;
set role authenticated;
do $$ begin
  begin perform count(*) from app.seller_terms; raise exception 'ÉCHEC conditions lisibles';
  exception when insufficient_privilege then raise notice 'ok  conditions des fournisseurs non lisibles directement'; end;
end $$;
reset role;

delete from public.lots where id in ('LOT-CT1', 'LOT-CT2');
delete from app.price_rules;
drop schema tests cascade;
select 'Tous les tests des conditions des fournisseurs sont passés.' as resultat;
