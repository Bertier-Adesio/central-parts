-- Tests des adresses (acheteur : facturation et livraison ; vendeur : expédition) et du choix du transport
-- (migration 20261103000030, ADR 0030). Vendeurs, adresses et lots fictifs. Lancé par tools/test-db.sh.
\set ON_ERROR_STOP 1

create schema if not exists tests;
create or replace function tests.eq(label text, got anyelement, want anyelement) returns void language plpgsql as $$
begin
  if got is distinct from want then raise exception 'ÉCHEC % : obtenu %, attendu %', label, got, want; end if;
  raise notice 'ok  %', label;
end $$;
create or replace function tests.fails(label text, stmt text, code text) returns void language plpgsql as $$
begin
  execute stmt;
  raise exception 'ÉCHEC % : aucune erreur', label;
exception when others then
  if sqlerrm like 'ÉCHEC%' then raise; end if;
  if sqlstate <> code then raise exception 'ÉCHEC % : erreur % (%), attendu %', label, sqlstate, sqlerrm, code; end if;
  raise notice 'ok  %', label;
end $$;
grant usage on schema tests to service_role, authenticated, anon;
grant execute on all functions in schema tests to service_role, authenticated, anon;

-- Vendeur fictif de Hong Kong avec deux adresses d'expédition : Hong Kong (par défaut) et Shenzhen.
insert into public.organizations (id, type, name, alias, city, country, currency, lang, profile, kyb) values
  ('AD1', 'seller', 'Vendeur deux entrepôts (fictif)', 'tmp-AD1', 'Hong Kong', 'HK', 'USD', 'en', 'Distributor', 'pending');
insert into app.price_rules (category, margin_pct) values ('distributor', 10) on conflict (category) do update set margin_pct = 10;
select public.approve_supplier('AD1', 'test');
insert into public.seller_addresses (id, org_id, label, address, city, country, is_default) values
  ('ADR-T1', 'AD1', 'Entrepôt Hong Kong', 'Unit 1, Kwun Tong (fictif)', 'Hong Kong', 'HK', true),
  ('ADR-T2', 'AD1', 'Entrepôt Shenzhen', 'Futian (fictif)', 'Shenzhen', 'CN', false);
insert into public.lots (id, seller_id, source, sku, mpn, manufacturer, qty, unit_price, currency, confirmed_at, ship_address_id) values
  ('LOT-AD1', 'AD1', 'file', 'AD-1', 'ADRTEST01', 'Test Semi', 10000, 1.00, 'USD', now(), null),
  ('LOT-AD2', 'AD1', 'file', 'AD-2', 'ADRTEST02', 'Test Semi', 10000, 1.00, 'USD', now(), 'ADR-T2');

do $$ begin
  perform tests.eq('lieu : adresse par défaut du vendeur', app.lot_place('LOT-AD1'), 'HK');
  perform tests.eq('lieu : adresse propre au lot', app.lot_place('LOT-AD2'), 'SZ');
  begin
    insert into public.seller_addresses (org_id, address, city, country, is_default) values ('AD1', 'x', 'Hong Kong', 'HK', true);
    raise exception 'ÉCHEC deux adresses par défaut';
  exception when unique_violation then raise notice 'ok  une seule adresse par défaut par vendeur'; end;
end $$;

set role service_role;
do $$
declare
  o jsonb; c jsonb; r jsonb;
  buyer jsonb := '{"currency": "EUR", "company": "Atelier Adresses (fictif)", "vat": "FR22334455667", "name": "Léo Test",
    "email": "adr@example.com", "phone": "+33 1 00 00 00 00", "country": "DE", "address": "Lager 5, 10115 Berlin",
    "billing_country": "FR", "billing_address": "1 rue de l''Exemple, 75000 Paris",
    "lines": [{"mpn": "ADRTEST02", "source": "distributor", "ship_from": "HK", "qty": "100"}]}';
begin
  o := (select e from jsonb_array_elements(public.partner_offers('10.25.0.1', 'ADRTEST02', 'EUR')->'offers') e);
  perform tests.eq('offres : lieu FCA de l''adresse du lot, jamais l''adresse', (o->>'fca_place') || ' ' || (o::text ~* 'Futian|Kwun|ADR-T'), 'SZ false');
  perform tests.eq('devis : lieu de l''adresse du lot', public.public_quote('ADRTEST02', 'distributor', 'HK', 10, 'EUR')->>'fca_place', 'SZ');

  -- Transport : erreurs.
  perform tests.fails('transport : mode inconnu', format('select public.create_purchase_cart(%L, %L)', '10.25.0.2', buyer || '{"transport": {"mode": "x"}}'), '22023');
  perform tests.fails('transport : compte de l''acheteur sans numéro', format('select public.create_purchase_cart(%L, %L)', '10.25.0.2', buyer || '{"transport": {"mode": "own", "carrier": "DHL"}}'), '22023');
  perform tests.fails('transport : transporteur inconnu', format('select public.create_purchase_cart(%L, %L)', '10.25.0.2', buyer || '{"transport": {"mode": "central", "carrier": "Pigeon"}}'), '22023');
  perform tests.fails('facturation : pays invalide', format('select public.create_purchase_cart(%L, %L)', '10.25.0.2', jsonb_set(buyer, '{billing_country}', '"France"')), '22023');

  -- Compte de l'acheteur (FCA) : facturation à Paris, livraison à Berlin.
  c := public.create_purchase_cart('10.25.0.3', buyer || '{"transport": {"mode": "own", "carrier": "FedEx", "account": "1234 5678 9"}}');
  perform tests.eq('panier : facturation, livraison et transport enregistrés',
    (select billing_country || ' ' || delivery_country || ' ' || transport_mode || ' ' || carrier || ' ' || carrier_account
       from public.purchase_requests where cart_id = c->>'ref'), 'FR DE own FedEx 123456789');
  r := public.request_for_operator(c->'lines'->0->>'ref');
  perform tests.eq('fiche opérateur : facturation, transport, adresse d''expédition du lot',
    (r->>'billing') || ' | ' || (r->'transport'->>'mode') || ' ' || (r->'transport'->>'account') || ' | ' || (r->'ship_address'->>'city'),
    'FR · 1 rue de l''Exemple, 75000 Paris | own 123456789 | Shenzhen');
  perform tests.eq('suivi de l''acheteur : jamais l''adresse du vendeur', public.purchase_cart_status(c->>'ref', c->>'token')::text ~* 'Futian|Shenzhen|ADR-T', false);

  -- Sans facturation ni transport : la livraison sert de facturation, transport par Central.Parts.
  c := public.create_purchase_cart('10.25.0.4', (buyer - 'billing_country' - 'billing_address') || '{"transport": {"mode": "central", "carrier": "DHL"}}');
  perform tests.eq('panier : facturation par défaut = livraison ; Central.Parts, DHL préféré',
    (select billing_country || ' ' || transport_mode || ' ' || carrier || ' ' || coalesce(carrier_account, '-') from public.purchase_requests where cart_id = c->>'ref'), 'DE central DHL -');
end $$;
reset role;

-- Droits : adresses des vendeurs non lisibles par un acheteur ; lecture par un administrateur.
set role anon;
do $$ begin
  begin perform count(*) from public.seller_addresses; raise exception 'ÉCHEC adresses lisibles par anon';
  exception when insufficient_privilege then raise notice 'ok  adresses des vendeurs non lisibles par anon'; end;
end $$;
reset role;
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
do $$ begin
  perform tests.eq('utilisateur ordinaire : aucune adresse lisible', (select count(*) from public.seller_addresses)::int, 0);
  perform tests.fails('utilisateur ordinaire : liste refusée', $s$select public.admin_seller_addresses('AD1')$s$, '42501');
end $$;
reset role;
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000e1';
do $$ begin
  perform tests.eq('administrateur : adresses du vendeur, la principale d''abord',
    (select string_agg(e->>'city', ',') from jsonb_array_elements(public.admin_seller_addresses('ad1')) e), 'Hong Kong,Shenzhen');
end $$;
reset role;

delete from public.purchase_requests where mpn like 'ADRTEST%';
delete from public.lots where id in ('LOT-AD1', 'LOT-AD2');
delete from app.price_rules;
drop schema tests cascade;
select 'Tous les tests des adresses et du transport sont passés.' as resultat;
