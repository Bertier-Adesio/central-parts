-- Tests des fabricants et de leurs distributeurs (migration 20261105000033). Fabricants, marques et distributeurs
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


-- Un fabricant qui se distribue lui-même (FM1), un distributeur agréé de deux fabricants (FD1), un broker (FK1) qui
-- revend la même marque, et un distributeur non rattaché (FD2).
insert into public.organizations (id, type, name, alias, city, country, currency, lang, profile, kyb) values
  ('FM1', 'seller', 'Compte du fabricant (fictif)', 'tmp-FM1', 'Shenzhen', 'CN', 'USD', 'zh', 'Manufacturer', 'pending'),
  ('FD1', 'seller', 'Distributeur agréé (fictif)', 'tmp-FD1', 'Hong Kong', 'HK', 'USD', 'en', 'Distributor', 'pending'),
  ('FD2', 'seller', 'Distributeur non rattaché (fictif)', 'tmp-FD2', 'Hong Kong', 'HK', 'USD', 'en', 'Distributor', 'pending'),
  ('FK1', 'seller', 'Broker (fictif)', 'tmp-FK1', 'Hong Kong', 'HK', 'USD', 'en', 'Broker', 'pending');
select public.approve_supplier(x, 'test') from unnest(array['FM1', 'FD1', 'FD2', 'FK1']) x;
insert into public.lots (id, seller_id, source, sku, mpn, manufacturer, qty, unit_price, currency, confirmed_at) values
  ('LOT-FM1', 'FM1', 'file', 'FM-1', 'MFRTEST01', 'Marque A', 100000, 0.10, 'USD', now()),
  ('LOT-FD1', 'FD1', 'file', 'FD-1', 'MFRTEST02', 'MARQUE A', 5000, 0.12, 'USD', now()),
  ('LOT-FD3', 'FD1', 'file', 'FD-3', 'MFRTEST03', 'Marque B', 5000, 0.12, 'USD', now()),
  ('LOT-FD2', 'FD2', 'file', 'FD-2', 'MFRTEST04', 'Marque A', 5000, 0.12, 'USD', now()),
  ('LOT-FK1', 'FK1', 'file', 'FK-1', 'MFRTEST05', 'Marque A', 5000, 0.12, 'USD', now());

set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
do $$ begin
  perform tests.fails('non-administrateur : liste refusée', $s$select public.admin_manufacturers()$s$, '42501');
  perform tests.fails('non-administrateur : création refusée', $s$select public.admin_manufacturer_save(null, '{"name": "X"}')$s$, '42501');
end $$;
reset role;

set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000e1';
do $$
declare a jsonb; b jsonb;
begin
  a := public.admin_manufacturer_save(null, jsonb_build_object('name', 'Fabricant A (fictif)', 'brands', jsonb_build_array('Marque A'),
    'founded_year', 2013, 'website', 'https://fabricant-a.example', 'staff', 120, 'annual_units', 3000000000, 'revenue_usd', 70000000,
    'about', jsonb_build_object('en', 'Fictitious manufacturer A.'), 'languages', jsonb_build_array('zh', 'en')));
  insert into tests.vars values ('a', a->>'id');
  perform tests.eq('fabricant : créé, publication possible', (a->>'id' like 'MFR-%') and (a->>'can_publish')::boolean, true);
  b := public.admin_manufacturer_save(null, jsonb_build_object('name', 'Fabricant B (fictif)', 'brands', jsonb_build_array('Marque B')));
  insert into tests.vars values ('b', b->>'id');
  perform tests.fails('marque déjà attribuée à un autre fabricant',
    format($s$select public.admin_manufacturer_save('%s', '{"brands": ["marque a"]}')$s$, b->>'id'), '22023');
  perform tests.fails('nom obligatoire', $s$select public.admin_manufacturer_save(null, '{"name": " "}')$s$, '22023');
  perform tests.fails('logo hors du dossier du fabricant refusé',
    format($s$select public.admin_manufacturer_save('%s', '{"logo_path": "%s/logo.png"}')$s$, a->>'id', b->>'id'), '22023');
  a := public.admin_manufacturer_save(a->>'id', jsonb_build_object('logo_path', (a->>'id') || '/logo-1.png'));
  perform tests.eq('logo enregistré, clé absente conservée', (a->>'founded_year') || ' ' || (a->>'logo_path'), '2013 ' || (a->>'id') || '/logo-1.png');

  -- Rattachements : fabricant lui-même, distributeur agréé de deux fabricants ; broker refusé.
  a := public.admin_manufacturer_link(a->>'id', 'FM1', 'self');
  a := public.admin_manufacturer_link(a->>'id', 'FD1', 'authorized');
  b := public.admin_manufacturer_link(b->>'id', 'fd1', 'authorized');
  perform tests.eq('fabricant A : deux comptes, fabricant lui-même d''abord', (select string_agg((x->>'org_id') || ':' || (x->>'role') || ':' || (x->>'offers'), ' ')
    from jsonb_array_elements(a->'distributors') x), 'FM1:self:1 FD1:authorized:1');
  perform tests.eq('distributeur : deux fabricants dans sa fiche', jsonb_array_length(public.admin_supplier_profile('FD1')->'manufacturers'), 2);
  perform tests.fails('un seul compte « fabricant lui-même »', format($s$select public.admin_manufacturer_link('%s', 'FD2', 'self')$s$, a->>'id'), '22023');
  perform tests.fails('broker : rattachement refusé', format($s$select public.admin_manufacturer_link('%s', 'FK1', 'authorized')$s$, a->>'id'), '22023');
  perform tests.fails('rôle inconnu refusé', format($s$select public.admin_manufacturer_link('%s', 'FD2', 'broker')$s$, a->>'id'), '22023');

  perform tests.fails('publication sans présentation refusée', format($s$select public.admin_manufacturer_publish('%s', true)$s$, b->>'id'), '22023');
  a := public.admin_manufacturer_publish(a->>'id', true);
  perform tests.eq('publication : au nom de l''administrateur', (a->>'public_page') || ' ' || (a->>'public_page_by'), 'true admin:ops1@example.test');
end $$;
reset role;

set role service_role;
do $$
declare p jsonb; o jsonb;
begin
  p := public.public_manufacturer('10.9.2.1', 'marque a');
  perform tests.eq('page publique : nom du fabricant, offres par canal', (p->>'name') || ' · ' || (p->>'offers_direct') || ' · ' || (p->>'offers_authorized'),
    'Fabricant A (fictif) · 1 · 1');
  perform tests.eq('page publique : ni site, ni CA, ni distributeur, ni identifiant',
    p ?| array['website', 'revenue_usd', 'distributors', 'id', 'org_id', 'alias'] or p::text ~ 'Compte du fabricant|Distributeur agréé \(fictif\)|tmp-', false);
  perform tests.eq('page non publiée : introuvable', public.public_manufacturer('10.9.2.1', 'Marque B'), null::jsonb);

  -- Offres : badge du canal officiel seulement ; broker et distributeur non rattaché restent « partenaire ».
  for o in select x from jsonb_array_elements(public.partner_offers('10.9.2.2', 'MFRTEST', 'USD')->'offers') x loop
    insert into tests.vars values (o->>'mpn', coalesce(o->>'brand_page', '-') || ' ' || (o->>'factory_direct') || ' ' || (o->>'authorized_distributor'));
  end loop;
  perform tests.eq('offre du fabricant : direct fabricant', (select v from tests.vars where k = 'MFRTEST01'), 'Marque A true false');
  perform tests.eq('offre du distributeur agréé : distributeur agréé', (select v from tests.vars where k = 'MFRTEST02'), 'Marque A false true');
  perform tests.eq('autre fabricant, page non publiée : badge sans lien', (select v from tests.vars where k = 'MFRTEST03'), '- false true');
  perform tests.eq('distributeur non rattaché : aucun badge', (select v from tests.vars where k = 'MFRTEST04'), 'Marque A false false');
  perform tests.eq('broker de la même marque : aucun badge', (select v from tests.vars where k = 'MFRTEST05'), 'Marque A false false');
end $$;
reset role;

-- Détachement, présentation vidée : badge et page retirés.
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000e1';
do $$
declare a text := (select v from tests.vars where k = 'a'); r jsonb;
begin
  r := public.admin_manufacturer_unlink(a, 'FD1');
  perform tests.eq('détaché', jsonb_array_length(r->'distributors'), 1);
  r := public.admin_manufacturer_save(a, '{"about": {}}');
  perform tests.eq('présentation vidée : page retirée', (r->>'public_page')::boolean, false);
  perform tests.eq('liste des fabricants', jsonb_array_length(public.admin_manufacturers()) >= 2, true);
end $$;
reset role;
set role service_role;
do $$ begin
  perform tests.eq('page retirée : introuvable', public.public_manufacturer('10.9.2.3', 'Marque A'), null::jsonb);
  perform tests.eq('détaché : plus de badge', (select (x->>'authorized_distributor')::boolean from jsonb_array_elements(public.partner_offers('10.9.2.4', 'MFRTEST02', 'USD')->'offers') x), false);
end $$;
reset role;
do $$ begin
  perform tests.eq('journal : création, rattachements et publication inscrits',
    (select count(*) from public.events where ref = (select v from tests.vars where k = 'a') and text ~ 'par admin:')::int >= 5, true);
end $$;

drop schema tests cascade;
select 'Tous les tests des fabricants et distributeurs sont passés.' as resultat;
