-- Tests du panier des acheteurs (migration 20261103000026, ADR 0028). Prérequis : checks précédents (lots fictifs
-- LOT-102 de S2, broker HK, 38 USD ; LOT-107 de S4, surplus CN, palier 100 pièces à 250 CNH ; administrateur e1).
-- Lancé par tools/test-db.sh.
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
create table tests.vars (k text primary key, v text);
grant all on tests.vars to service_role, authenticated;

insert into app.price_rules (category, margin_pct) values ('surplus', 10), ('broker', 10)
on conflict (category) do update set margin_pct = excluded.margin_pct;
insert into public.wechat_identities (openid, org_id, role) values ('oS4', 'S4', 'admin') on conflict (openid) do nothing;

set role service_role;
do $$
declare
  buyer jsonb := '{"currency": "EUR", "company": "Atelier Panier (fictif)", "vat": "FR11223344556", "name": "Léa Test",
    "email": "panier@example.com", "country": "FR", "address": "3 rue de l''Exemple, 33000 Bordeaux"}';
  c jsonb; s jsonb; n0 int := (select count(*) from public.purchase_requests);
begin
  -- Erreurs : rien n'est enregistré.
  perform tests.fails('panier vide', format('select public.create_purchase_cart(%L, %L)', '198.51.100.40', buyer || '{"lines": []}'), '22023');
  perform tests.fails('panier de 31 lignes', format('select public.create_purchase_cart(%L, %L)', '198.51.100.40',
    buyer || jsonb_build_object('lines', (select jsonb_agg('{"mpn": "XC2S50-5TQ144C", "source": "surplus", "ship_from": "CN", "qty": "1"}'::jsonb) from generate_series(1, 31)))), '22023');
  perform tests.fails('coordonnées invalides', format('select public.create_purchase_cart(%L, %L)', '198.51.100.40',
    jsonb_set(buyer, '{email}', '"x"') || '{"lines": [{"mpn": "XC2S50-5TQ144C", "source": "surplus", "ship_from": "CN", "qty": "1"}]}'), '22023');
  perform tests.fails('ligne sans quantité', format('select public.create_purchase_cart(%L, %L)', '198.51.100.40',
    buyer || '{"lines": [{"mpn": "XC2S50-5TQ144C", "source": "surplus", "ship_from": "CN", "qty": "0"}]}'), '22023');
  perform tests.fails('ligne introuvable : tout le panier refusé', format('select public.create_purchase_cart(%L, %L)', '198.51.100.40',
    buyer || '{"lines": [{"mpn": "XC2S50-5TQ144C", "source": "surplus", "ship_from": "CN", "qty": "10"}, {"mpn": "NEXISTEPAS", "source": "broker", "ship_from": "HK", "qty": "1"}]}'), 'P0002');
  perform tests.eq('erreurs : aucune demande enregistrée', (select count(*) from public.purchase_requests)::int, n0);

  -- Panier de deux lignes, deux fournisseurs.
  c := public.create_purchase_cart('198.51.100.40', buyer || '{"lines": [
    {"mpn": "xc2s50-5tq144c", "source": "surplus", "ship_from": "CN", "qty": "200"},
    {"mpn": "XC2S50-5TQ144C", "source": "broker", "ship_from": "HK", "qty": "10"}]}');
  insert into tests.vars values ('cart', c->>'ref'), ('tok', c->>'token');
  perform tests.eq('panier : référence CART-', c->>'ref' ~ '^CART-\d{4,}$', true);
  perform tests.eq('panier : deux lignes', jsonb_array_length(c->'lines'), 2);
  perform tests.eq('panier : prix en EUR (250 CNH × 0,128 + 10 % ; 38 USD × 0,92 + 10 %)',
    (c->'lines'->0->>'unit_price') || ' / ' || (c->'lines'->1->>'unit_price'), '35.2000 / 38.4560');
  perform tests.eq('panier : total', (c->>'total')::numeric, 7040.00 + 384.56);
  perform tests.eq('panier : deux demandes, deux fournisseurs, même panier, à valider',
    (select count(*) || ' ' || count(distinct seller_id) || ' ' || string_agg(distinct status, ',') from public.purchase_requests where cart_id = c->>'ref'),
    '2 2 pending_validation');
  perform tests.eq('panier : jeton gardé en empreinte, commun aux lignes',
    (select count(distinct access_hash) from public.purchase_requests where cart_id = c->>'ref')::int || ' ' ||
    (select count(*) from public.purchase_requests where access_hash = c->>'token')::int, '1 0');

  -- Suivi par l'acheteur.
  s := public.purchase_cart_status(lower(c->>'ref'), c->>'token');
  perform tests.eq('suivi : panier et ses lignes', (s->>'cart') || ' ' || jsonb_array_length(s->'lines'), 'true 2');
  perform tests.eq('suivi : statut de chaque ligne', (select string_agg(e->>'status', ',') from jsonb_array_elements(s->'lines') e), 'pending_validation,pending_validation');
  perform tests.eq('suivi : jamais le fournisseur', s::text ~* 'S2|S4|V-\d|seller|lot', false);
  perform tests.eq('suivi : jeton faux, rien', public.purchase_cart_status(c->>'ref', 'faux'), null::jsonb);
  perform tests.eq('suivi d''une ligne avec le même jeton', public.purchase_request_status(c->'lines'->0->>'ref', c->>'token')->>'mpn', 'XC2S50-5TQ144C');

  -- Fournisseur : rien avant la validation.
  perform tests.eq('fournisseur : rien avant la validation',
    (select count(*) from jsonb_array_elements(public.supplier_requests('oS4')) e where e->>'ref' in (select id from public.purchase_requests where cart_id = c->>'ref'))::int, 0);
end $$;
reset role;

-- Administrateur : chaque ligne porte son panier ; validation ligne par ligne.
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000e1';
do $$
declare v_cart text := (select v from tests.vars where k = 'cart'); r jsonb; d jsonb;
begin
  r := (select e from jsonb_array_elements(public.admin_requests()->'rows') e where e->>'cart_id' = v_cart and e->>'source' = 'surplus');
  perform tests.eq('back office : panier et nombre de lignes sur la fiche', (r->>'cart_id') || ' ' || (r->>'cart_lines'), v_cart || ' 2');
  d := public.admin_request_approve(r->>'ref');
  perform tests.eq('back office : ligne validée, vue fournisseur', (d->>'status') || ' ' || (d->'supplier_view'->>'currency'), 'submitted CNH');
end $$;
reset role;

set role service_role;
do $$
declare v_cart text := (select v from tests.vars where k = 'cart'); v_tok text := (select v from tests.vars where k = 'tok');
  buyer jsonb := '{"currency": "EUR", "company": "A", "vat": "DE123456789", "name": "B", "email": "b@example.com", "country": "DE", "address": "C",
    "lines": [{"mpn": "XC2S50-5TQ144C", "source": "surplus", "ship_from": "CN", "qty": "1"}, {"mpn": "XC2S50-5TQ144C", "source": "surplus", "ship_from": "CN", "qty": "2"}]}';
  i int;
begin
  perform tests.eq('suivi : une ligne transmise, l''autre à valider',
    (select string_agg(e->>'status', ',' order by e->>'status') from jsonb_array_elements(public.purchase_cart_status(v_cart, v_tok)->'lines') e), 'pending_validation,submitted');
  perform tests.eq('fournisseur S4 : voit la ligne validée seulement',
    (select count(*) from jsonb_array_elements(public.supplier_requests('oS4')) e where e->>'ref' in (select id from public.purchase_requests where cart_id = v_cart))::int, 1);
  -- Limite : un panier compte pour un envoi (5 par heure et par adresse).
  for i in 1..5 loop perform public.create_purchase_cart('198.51.100.41', buyer); end loop;
  perform tests.eq('limite : 5 paniers de 2 lignes acceptés', (select count(*) from public.purchase_requests where buyer_company = 'A' and cart_id is not null)::int, 10);
  perform tests.fails('limite : 6e envoi refusé (5 par heure)', format('select public.create_purchase_cart(%L, %L)', '198.51.100.41', buyer), 'CP429');
end $$;
reset role;

set role anon;
do $$ begin
  begin perform public.create_purchase_cart('x', '{}'); raise exception 'ÉCHEC panier direct par anon';
  exception when insufficient_privilege then raise notice 'ok  panier réservé à la fonction Edge'; end;
end $$;
reset role;

delete from app.price_rules;
drop schema tests cascade;
select 'Tous les tests du panier sont passés.' as resultat;
