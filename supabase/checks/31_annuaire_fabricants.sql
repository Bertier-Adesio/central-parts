-- Tests de l'annuaire public des fabricants (migration 20261106000037). Fabricants et vendeurs fictifs.
-- Prérequis : checks précédents (administrateur fictif e1). Lancé par tools/test-db.sh.
\set ON_ERROR_STOP 1

create schema if not exists tests;
create or replace function tests.eq(label text, got anyelement, want anyelement) returns void language plpgsql as $$
begin
  if got is distinct from want then raise exception 'ÉCHEC % : obtenu %, attendu %', label, got, want; end if;
  raise notice 'ok  %', label;
end $$;
grant usage on schema tests to service_role, authenticated, anon;
grant execute on all functions in schema tests to service_role, authenticated, anon;
create table tests.vars (k text primary key, v text);
grant all on tests.vars to service_role, authenticated;

insert into public.organizations (id, type, name, alias, city, country, currency, lang, profile, kyb) values
  ('AN1', 'seller', 'Compte direct (fictif)', 'tmp-AN1', 'Shenzhen', 'CN', 'USD', 'zh', 'Manufacturer', 'pending'),
  ('AN2', 'seller', 'Broker annuaire (fictif)', 'tmp-AN2', 'Hong Kong', 'HK', 'USD', 'en', 'Broker', 'pending');
select public.approve_supplier('AN1', 'test'), public.approve_supplier('AN2', 'test');
insert into public.lots (id, seller_id, source, sku, mpn, manufacturer, qty, unit_price, currency, confirmed_at) values
  ('LOT-AN1', 'AN1', 'file', 'AN-1', 'ANNTEST01', 'Marque Annuaire', 1000, 0.10, 'USD', now()),
  ('LOT-AN2', 'AN1', 'file', 'AN-2', 'ANNTEST02', 'Marque Annuaire', 1000, 0.10, 'USD', now()),
  ('LOT-AN3', 'AN2', 'file', 'AN-3', 'ANNTEST03', 'Marque Annuaire', 1000, 0.10, 'USD', now());

set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000e1';
do $$
declare m jsonb;
begin
  m := public.admin_manufacturer_save(null, jsonb_build_object('name', 'Fabricant annuaire (fictif)', 'brands', jsonb_build_array('Marque Annuaire'),
    'about', jsonb_build_object('en', 'Fictitious.'), 'positioning', jsonb_build_object('en', 'Fictitious positioning'),
    'revenue_usd', 1000000, 'website', 'https://annuaire.example', 'logo_path', null));
  perform public.admin_manufacturer_link(m->>'id', 'AN1', 'self');
  perform public.admin_manufacturer_consent(m->>'id', 'AN1', true);
  -- Un second fabricant, non publié : absent de l'annuaire.
  perform public.admin_manufacturer_save(null, jsonb_build_object('name', 'Fabricant non publié (fictif)', 'brands', jsonb_build_array('Marque Cachée'),
    'about', jsonb_build_object('en', 'Hidden.')));
  insert into tests.vars values ('m', m->>'id');
end $$;
reset role;

set role service_role;
do $$ begin
  perform tests.eq('page non publiée : absente de l''annuaire',
    (select count(*) from jsonb_array_elements(public.public_manufacturers('10.9.4.1')) x where x->>'name' like 'Fabricant %annuaire%' or x->>'name' like 'Fabricant non publié%')::int, 0);
end $$;
reset role;
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000e1';
do $$ begin perform public.admin_manufacturer_publish((select v from tests.vars where k = 'm'), true); end $$;
reset role;
set role service_role;
do $$
declare x jsonb := (select x from jsonb_array_elements(public.public_manufacturers('10.9.4.2')) x where x->>'name' = 'Fabricant annuaire (fictif)');
begin
  perform tests.eq('annuaire : fabricant publié, marque et positionnement', (x->>'brand') || ' · ' || (x->'positioning'->>'en'), 'Marque Annuaire · Fictitious positioning');
  perform tests.eq('annuaire : offres du canal officiel seulement (pas le broker)', (x->>'offers')::int, 2);
  perform tests.eq('annuaire : ni site, ni CA, ni distributeur, ni identifiant',
    x ?| array['website', 'revenue_usd', 'distributors', 'id', 'org_id', 'alias'] or x::text ~ 'Compte direct|tmp-', false);
end $$;
reset role;

drop schema tests cascade;
select 'Tous les tests de l''annuaire des fabricants sont passés.' as resultat;
