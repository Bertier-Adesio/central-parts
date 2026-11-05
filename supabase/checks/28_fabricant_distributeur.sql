-- Tests du fabricant distribué par un distributeur agréé (migration 20261105000033). Distributeur, marque et fabricant
-- fictifs. Prérequis : checks précédents (administrateur fictif e1). Lancé par tools/test-db.sh.
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


-- Un distributeur fictif dépose le stock d'une marque fictive dont il est le distributeur agréé.
insert into public.organizations (id, type, name, alias, city, country, currency, lang, profile, kyb) values
  ('DA1', 'seller', 'Distributeur agréé de démonstration (fictif)', 'tmp-DA1', 'Hong Kong', 'HK', 'USD', 'en', 'Distributor', 'pending');
select public.approve_supplier('DA1', 'test');
insert into public.lots (id, seller_id, source, sku, mpn, manufacturer, qty, unit_price, currency, confirmed_at) values
  ('LOT-DA1', 'DA1', 'file', 'DA-1', 'DISTTEST01', 'Marque Dist', 100000, 0.10, 'USD', now());

set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000e1';
do $$
declare r jsonb;
begin
  r := public.admin_supplier_profile_save('DA1', jsonb_build_object('brands', jsonb_build_array('Marque Dist'),
    'about', jsonb_build_object('en', 'Fictitious manufacturer.'), 'brand_role', 'authorized_distributor'));
  perform tests.eq('sans nom du fabricant : publication impossible', (r->>'can_publish')::boolean, false);
  perform tests.fails('sans nom du fabricant : publication refusée', $s$select public.admin_supplier_publish('DA1', true)$s$, '22023');
  perform tests.fails('rôle inconnu refusé', $s$select public.admin_supplier_profile_save('DA1', '{"brand_role": "broker"}')$s$, '22023');
  r := public.admin_supplier_profile_save('DA1', '{"brand_name": "  Fabricant Marque Dist (fictif)  "}');
  perform tests.eq('nom du fabricant et rôle enregistrés', (r->>'brand_name') || ' · ' || (r->>'brand_role'), 'Fabricant Marque Dist (fictif) · authorized_distributor');
  r := public.admin_supplier_publish('DA1', true);
  perform tests.eq('page publiée', (r->>'public_page')::boolean, true);
end $$;
reset role;

set role service_role;
do $$
declare p jsonb; o jsonb;
begin
  p := public.public_manufacturer('10.9.1.1', 'Marque Dist');
  perform tests.eq('page publique : nom du fabricant, jamais celui du distributeur', (p->>'name') || ' · ' || (p->>'channel'),
    'Fabricant Marque Dist (fictif) · authorized_distributor');
  perform tests.eq('page publique : aucun nom du compte', p::text ~ 'Distributeur agréé de démonstration', false);
  o := (select x from jsonb_array_elements(public.partner_offers('10.9.1.2', 'DISTTEST', 'USD')->'offers') x limit 1);
  perform tests.eq('offre : distributeur agréé, pas « direct fabricant »', (o->>'authorized_distributor') || ' ' || (o->>'factory_direct') || ' ' || (o->>'brand_page'),
    'true false Marque Dist');
  perform tests.eq('offre : vendeur toujours anonyme', o->>'supplier', 'partner');
end $$;
reset role;

-- Nom du fabricant effacé : page retirée.
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000e1';
do $$ begin
  perform tests.eq('nom effacé : page retirée', (public.admin_supplier_profile_save('DA1', '{"brand_name": ""}')->>'public_page')::boolean, false);
end $$;
reset role;

drop schema tests cascade;
select 'Tous les tests du fabricant distribué sont passés.' as resultat;
