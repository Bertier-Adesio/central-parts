-- Tests de la recherche publique (ADR 0013). Prérequis : migrations et données fictives. Lancé par tools/test-db.sh.
\set ON_ERROR_STOP 1

create schema if not exists tests;
create or replace function tests.eq(label text, got anyelement, want anyelement) returns void language plpgsql as $$
begin
  if got is distinct from want then raise exception 'ÉCHEC % : obtenu %, attendu %', label, got, want; end if;
  raise notice 'ok  %', label;
end $$;
grant usage on schema tests to service_role;
grant execute on all functions in schema tests to service_role;

-- Lots fictifs XC2S50-5TQ144C à ce stade des contrôles : S2 (broker, HK, 400 à 38 USD), S4 (surplus, CN, 500 à 300 CNH) ;
-- S1 (DE) n'est plus vérifié (abonnement échu dans checks/01_rls.sql) et n'apparaît pas.
set role service_role;
do $$
declare r jsonb := public.public_search('192.0.2.1', ' xc2s 50', 'EUR'); x jsonb;
begin
  perform tests.eq('recherche : espaces et minuscules ignorés', r->>'query', 'XC2S50');
  perform tests.eq('recherche : une ligne par catégorie et pays', jsonb_array_length(r->'results'), 2);
  select e into x from jsonb_array_elements(r->'results') e where e->>'source' = 'surplus' and e->>'ship_from' = 'CN';
  perform tests.eq('recherche : tranche, jamais la quantité exacte', x->>'availability', '100+');
  perform tests.eq('recherche : ni fournisseur ni quantité dans la réponse', x ?| array['seller_id', 'alias', 'qty', 'name'], false);
  perform tests.eq('recherche : pays d''expédition', x->>'ship_from', 'CN');
  perform tests.eq('recherche : sans règle de marge, prix sur demande', x->'price_from', 'null'::jsonb);
end $$;
reset role;

insert into app.price_rules (category, margin_pct) values ('surplus', 10), ('broker', 10);
set role service_role;
do $$
declare x jsonb;
begin
  select e into x from jsonb_array_elements(public.public_search('192.0.2.1', 'XC2S50', 'EUR')->'results') e where e->>'source' = 'surplus' and e->>'ship_from' = 'CN';
  perform tests.eq('prix tout compris : 300 CNH en EUR (0,128) + 10 %', (x->>'price_from')::numeric, 42.2400);
  select e into x from jsonb_array_elements(public.public_search('192.0.2.1', 'XC2S50', 'USD')->'results') e where e->>'source' = 'broker';
  perform tests.eq('prix tout compris en USD : 38 USD + 10 %', (x->>'price_from')::numeric, 41.8000);
  perform tests.eq('recherche : début de référence seulement', jsonb_array_length(public.public_search('192.0.2.1', '2S50', 'EUR')->'results'), 0);
  begin perform public.public_search('192.0.2.1', 'XC', 'EUR'); raise exception 'ÉCHEC recherche de 2 caractères';
  exception when invalid_parameter_value then raise notice 'ok  3 caractères au moins'; end;
end $$;
reset role;

-- Fournisseur en attente de validation : invisible.
update public.organizations set kyb = 'pending' where id = 'S2';
set role service_role;
do $$ begin
  perform tests.eq('fournisseur non validé : invisible', jsonb_array_length(public.public_search('192.0.2.1', 'XC2S50', 'EUR')->'results'), 1);
end $$;
reset role;
update public.organizations set kyb = 'validated' where id = 'S2';

-- Limite : 30 recherches par minute et par adresse.
set role service_role;
do $$
declare i int;
begin
  for i in 1..25 loop perform public.public_search('192.0.2.9', 'XC2S50', 'EUR'); end loop;
  begin
    for i in 1..10 loop perform public.public_search('192.0.2.9', 'XC2S50', 'EUR'); end loop;
    raise exception 'ÉCHEC limite de requêtes absente';
  exception when sqlstate 'CP429' then raise notice 'ok  limite de 30 recherches par minute'; end;
  perform tests.eq('limite : par adresse', jsonb_array_length(public.public_search('192.0.2.10', 'XC2S50', 'EUR')->'results'), 2);
end $$;
reset role;
do $$ begin
  perform tests.eq('limite : adresse non gardée en clair', (select count(*) from app.search_hits where ip_hash like '192.%'), 0::bigint);
end $$;

-- Droits : réservé à la fonction Edge.
set role anon;
do $$ begin
  begin perform public.public_search('x', 'XC2S50', 'EUR'); raise exception 'ÉCHEC recherche directe par anon';
  exception when insufficient_privilege then raise notice 'ok  recherche réservée à la fonction Edge'; end;
end $$;
reset role;

delete from app.price_rules;
drop schema tests cascade;
select 'Tous les tests de la recherche publique sont passés.' as resultat;
