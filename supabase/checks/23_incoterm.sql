-- Tests de l'Incoterm FCA des prix publics (migration 20261103000028, ADR 0029). Prérequis : checks précédents
-- (lots fictifs LOT-102 de S2, Hong Kong ; LOT-107 de S4, Chine). Lancé par tools/test-db.sh.
\set ON_ERROR_STOP 1

create schema if not exists tests;
create or replace function tests.eq(label text, got anyelement, want anyelement) returns void language plpgsql as $$
begin
  if got is distinct from want then raise exception 'ÉCHEC % : obtenu %, attendu %', label, got, want; end if;
  raise notice 'ok  %', label;
end $$;
grant usage on schema tests to service_role;
grant execute on all functions in schema tests to service_role;

do $$ begin
  perform tests.eq('lieu : Hong Kong par le pays', app.fca_place('HK', null), 'HK');
  perform tests.eq('lieu : Shenzhen en chinois', app.fca_place('CN', '深圳'), 'SZ');
  perform tests.eq('lieu : Shenzhen en anglais', app.fca_place('CN', ' Shenzhen '), 'SZ');
  perform tests.eq('lieu : Dongguan, Guangzhou, Shanghai, Xiamen', app.fca_place('CN', '东莞') || app.fca_place('CN', 'Canton') || app.fca_place('CN', '上海市') || app.fca_place('CN', 'Xiamen'), 'DGGZSHXM');
  perform tests.eq('lieu : ville inconnue → pays', app.fca_place('CN', 'Ningbo'), 'CN');
  perform tests.eq('lieu : Taïwan', app.fca_place('TW', 'Taipei'), 'TW');
  perform tests.eq('lieu : rien de connu → CN', app.fca_place(null, null), 'CN');
end $$;

insert into app.price_rules (category, margin_pct) values ('surplus', 10), ('broker', 10) on conflict (category) do update set margin_pct = 10;
set role service_role;
do $$
declare r jsonb; o jsonb; q jsonb;
begin
  r := public.public_search('10.23.0.1', 'XC2S50', 'EUR')->'results';
  perform tests.eq('recherche : FCA Hong Kong pour l''offre de Hong Kong',
    (select (e->>'incoterm') || ' ' || (e->>'fca_place') from jsonb_array_elements(r) e where e->>'ship_from' = 'HK'), 'FCA HK');
  perform tests.eq('recherche : FCA au lieu du fournisseur chinois',
    (select e->>'fca_place' from jsonb_array_elements(r) e where e->>'ship_from' = 'CN' and e->>'source' = 'surplus') is not null, true);
  o := (select e from jsonb_array_elements(public.partner_offers('10.23.0.2', 'XC2S50', 'EUR')->'offers') e where e->>'ship_from' = 'HK' limit 1);
  perform tests.eq('offres : incoterm et lieu', (o->>'incoterm') || ' ' || (o->>'fca_place'), 'FCA HK');
  q := public.public_quote('XC2S50-5TQ144C', 'broker', 'HK', 10, 'EUR');
  perform tests.eq('devis : incoterm et lieu du lot retenu', (q->>'incoterm') || ' ' || (q->>'fca_place'), 'FCA HK');
end $$;
reset role;

delete from app.price_rules;
drop schema tests cascade;
select 'Tous les tests de l''Incoterm sont passés.' as resultat;
