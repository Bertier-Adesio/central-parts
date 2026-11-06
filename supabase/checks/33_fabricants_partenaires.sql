-- Tests des fabricants partenaires et du regroupement des noms de fabricants des offres (migration 20261106000039).
-- Fabricant, vendeurs et lots fictifs. Prérequis : checks précédents (administrateur fictif e1). Lancé par tools/test-db.sh.
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
  ('FP1', 'seller', 'Vendeur partenaire (fictif)', 'tmp-FP1', 'Shenzhen', 'CN', 'USD', 'zh', 'Distributor', 'pending');
select public.approve_supplier('FP1', 'test');
insert into public.lots (id, seller_id, source, sku, mpn, manufacturer, qty, unit_price, currency, confirmed_at) values
  ('LOT-FP1', 'FP1', 'file', 'FP-1', 'PARTTEST01', 'Marque Partenaire', 100, 0.10, 'USD', now()),
  ('LOT-FP2', 'FP1', 'file', 'FP-2', 'PARTTEST02', 'Analog Test Inc.', 100, 0.10, 'USD', now()),
  ('LOT-FP3', 'FP1', 'file', 'FP-3', 'PARTTEST03', 'Analog Test', 100, 0.10, 'USD', now()),
  ('LOT-FP4', 'FP1', 'file', 'FP-4', 'PARTTEST04', 'ANALOG TEST CO., LTD.', 100, 0.10, 'USD', now());

set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000e1';
do $$
declare m jsonb := public.admin_manufacturer_save(null, '{"name": "Fabricant partenaire (fictif)", "brands": ["Marque Partenaire"]}');
begin perform public.admin_manufacturer_link(m->>'id', 'FP1', 'authorized'); end $$;
reset role;

set role service_role;
do $$
declare r jsonb := public.partner_offers('10.9.6.1', 'PARTTEST', 'EUR'); f jsonb := public.partner_offers('10.9.6.2', 'PARTTEST', 'EUR', 'analog test');
begin
  perform tests.eq('nom normalisé : suffixes, ponctuation et casse retirés', app.mfr_key(' Fenghua Advanced Technology (Group) Co., Ltd. '), 'FENGHUA ADVANCED TECHNOLOGY');
  perform tests.eq('fabricants : partenaire d''abord, variantes de nom regroupées sous le nom le plus court',
    (select string_agg((x->>'name') || ':' || (x->>'offers') || ':' || (x->>'partner'), ' ') from jsonb_array_elements(r->'manufacturers') x),
    'Marque Partenaire:1:true Analog Test:3:false');
  perform tests.eq('filtre : toutes les variantes du fabricant', jsonb_array_length(f->'offers') || ' ' || (f->>'manufacturer'), '3 ANALOG TEST');
end $$;
reset role;

drop schema tests cascade;
select 'Tous les tests des fabricants partenaires sont passés.' as resultat;
