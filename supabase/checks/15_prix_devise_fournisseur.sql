-- Tests des prix publics convertis dans la devise demandée (migration 20261103000025, ADR 0027 ; remplace la règle
-- « devise du fournisseur, sans conversion » de 20261102000019). Prérequis : 14_prix_1ku.sql (lots LOT-K1 et LOT-K2
-- du vendeur S2, en USD, marge 10 %). Taux fictifs de seed.sql : 1 USD = 0,92 EUR. Lancé par tools/test-db.sh.
\set ON_ERROR_STOP 1

create schema if not exists tests;
create or replace function tests.eq(label text, got anyelement, want anyelement) returns void language plpgsql as $$
begin
  if got is distinct from want then raise exception 'ÉCHEC % : obtenu %, attendu %', label, got, want; end if;
  raise notice 'ok  %', label;
end $$;
grant usage on schema tests to service_role, authenticated, anon;
grant execute on all functions in schema tests to service_role, authenticated, anon;

-- Même référence chez un second vendeur vérifié (broker de Hong Kong, comme S2), en EUR.
insert into public.organizations (id, type, name, alias, city, country, currency, lang, profile, kyb)
values ('K-EUR', 'seller', 'Vendeur en euros (fictif)', 'V-KEUR', 'Hong Kong', 'HK', 'EUR', 'en', 'Broker', 'validated');
insert into public.subscriptions (org_id, plan, until) values ('K-EUR', 'Test', current_date + 30);
insert into app.seller_margins (org_id, margin_pct) values ('K-EUR', 10);
insert into public.lots (id, seller_id, source, sku, mpn, manufacturer, qty, unit_price, currency)
values ('LOT-K3', 'K-EUR', 'file', 'K3', 'PRIX1K-A', 'Fictif', 500, 2.00, 'EUR');

set role service_role;
do $$
declare d jsonb; r jsonb; o jsonb;
begin
  d := public.public_search('test-19', 'PRIX1K-A', 'EUR');
  r := d->'results';
  perform tests.eq('recherche : une offre par référence, source et pays, toutes devises confondues', jsonb_array_length(r), 1);
  perform tests.eq('recherche : prix en EUR (0,80 USD + 10 % = 0,88 USD → 0,8096 EUR, moins cher que 2,20 EUR)',
    (r->0->>'price_from') || ' ' || (r->0->>'currency'), '0.8096 EUR');
  perform tests.eq('recherche : prix 1KU converti (1,10 USD → 1,012 EUR)', (r->0->>'price_1k')::numeric, 1.0120);
  perform tests.eq('recherche : date du taux utilisée', d->>'rates_at' is not null, true);
  perform tests.eq('recherche : autre devise demandée (USD), offre en USD inchangée', (public.public_search('test-19b', 'PRIX1K-A', 'USD')->'results'->0->>'price_from')::numeric, 0.8800);
  perform tests.eq('recherche : devise inconnue → EUR', public.public_search('test-19c', 'PRIX1K-A', 'XXX')->>'currency', 'EUR');
  o := public.partner_offers('test-19', 'PRIX1K-A', 'EUR');
  perform tests.eq('offres : deux offres, toutes en EUR', (select string_agg(distinct e->>'currency', ',') || ' ' || count(*) from jsonb_array_elements(o->'offers') e), 'EUR 2');
  perform tests.eq('offres : prix convertis', (select string_agg(e->>'price_from', ',' order by (e->>'price_from')::numeric) from jsonb_array_elements(o->'offers') e), '0.8096,2.2000');
  perform tests.eq('offres : date du taux', o->>'rates_at' is not null, true);
end $$;
reset role;

-- Taux de la BCE : mise à jour, CNH pris sur CNY, valeur aberrante ignorée, droits.
set role service_role;
do $$
declare r jsonb; v_usd numeric := (select eur_rate from public.currencies where code = 'USD');
begin
  update public.currencies set rate_at = now() - interval '2 days' where code = 'GBP';
  r := public.set_eur_rates('{"USD": 1.0870, "CNY": 7.8125, "HKD": 8.4746, "GBP": 0.5, "JPY": "161.29"}', current_date);
  perform tests.eq('taux : USD mis à jour (1 / 1,0870)', (select eur_rate from public.currencies where code = 'USD'), 0.91996320);
  perform tests.eq('taux : CNH pris sur le taux CNY (1 / 7,8125 = 0,128)', (select eur_rate from public.currencies where code = 'CNH'), 0.12800000);
  perform tests.eq('taux : texte numérique accepté (JPY)', (select eur_rate from public.currencies where code = 'JPY'), 0.00620001);
  perform tests.eq('taux : écart de plus de 30 % ignoré (GBP)', r->'skipped', '["GBP"]'::jsonb);
  perform tests.eq('taux : date de publication', (select rate_at from public.currencies where code = 'USD') = ((current_date + time '16:00') at time zone 'Europe/Berlin'), true);
  perform tests.eq('taux : date la plus ancienne (GBP non mis à jour)', public.eur_rates_at() < (select rate_at from public.currencies where code = 'USD'), true);
  begin perform public.set_eur_rates('{"USD": 1.08}', current_date - 30); raise exception 'ÉCHEC date ancienne acceptée';
  exception when invalid_parameter_value then raise notice 'ok  taux : date trop ancienne refusée'; end;
  update public.currencies set eur_rate = v_usd where code = 'USD';
end $$;
reset role;
set role anon;
do $$ begin
  begin perform public.set_eur_rates('{"USD": 1.08}', current_date); raise exception 'ÉCHEC taux modifiable par anon';
  exception when insufficient_privilege then raise notice 'ok  taux réservés au serveur'; end;
end $$;
reset role;

drop schema tests cascade;
select 'Tous les tests des prix convertis en euros sont passés.' as resultat;
