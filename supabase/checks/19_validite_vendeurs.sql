-- Tests de la validité des offres par vendeur, de la reconfirmation sans fichier et des rappels (migration 20261103000023).
-- Prérequis : checks précédents. Lancé par tools/test-db.sh. Sociétés et lots fictifs.
\set ON_ERROR_STOP 1

create schema if not exists tests;
create or replace function tests.eq(label text, got anyelement, want anyelement) returns void language plpgsql as $$
begin
  if got is distinct from want then raise exception 'ÉCHEC % : obtenu %, attendu %', label, got, want; end if;
  raise notice 'ok  %', label;
end $$;
grant usage on schema tests to service_role;
grant execute on all functions in schema tests to service_role;

-- Un fabricant et un broker approuvés, chacun avec une offre confirmée il y a 10 jours.
insert into public.organizations (id, type, name, alias, city, country, currency, lang, profile, kyb) values
  ('VF1', 'seller', 'Fabricant de test (fictif)', 'tmp-VF1', 'Shenzhen', 'CN', 'USD', 'zh', 'Manufacturer', 'pending'),
  ('VB1', 'seller', 'Broker de test (fictif)', 'tmp-VB1', 'Hong Kong', 'HK', 'USD', 'en', 'Broker', 'pending');
insert into public.wechat_identities (openid, org_id, role) values ('oVF1admin', 'VF1', 'admin'), ('oVB1admin', 'VB1', 'admin');
insert into app.price_rules (category, margin_pct) values ('manufacturer', 10), ('broker', 10) on conflict (category) do update set margin_pct = 10;
select public.approve_supplier('VF1', 'test'), public.approve_supplier('VB1', 'test');
insert into public.lots (id, seller_id, source, sku, mpn, manufacturer, qty, unit_price, currency, confirmed_at) values
  ('LOT-VF1', 'VF1', 'file', 'VF-1', 'VALTEST100', 'Test Semi', 5000, 0.10, 'USD', now() - interval '10 days'),
  ('LOT-VB1', 'VB1', 'file', 'VB-1', 'VALTEST200', 'Test Semi', 3000, 0.20, 'USD', now() - interval '10 days');

-- Durées.
do $$ begin
  perform tests.eq('fabricant : 14 jours', extract(day from app.seller_ttl('VF1'))::int, 14);
  perform tests.eq('broker : 7 jours', extract(day from app.seller_ttl('VB1'))::int, 7);
  perform tests.eq('distributeur et revendeur : 7 jours', extract(day from app.org_ttl(null, 'Distributor'))::int || '/' || extract(day from app.org_ttl(null, 'Reseller'))::int, '7/7');
  perform tests.eq('durée propre au vendeur prioritaire', extract(day from app.org_ttl(30, 'Broker'))::int, 30);
end $$;

set role service_role;
do $$ begin
  -- Offre de 10 jours : visible chez le fabricant (14 jours), retirée chez le broker (7 jours).
  perform tests.eq('/offres/ : offre du fabricant de 10 jours visible', jsonb_array_length(public.partner_offers('10.9.0.1', 'VALTEST100', 'USD')->'offers'), 1);
  perform tests.eq('/offres/ : offre du broker de 10 jours retirée', jsonb_array_length(public.partner_offers('10.9.0.1', 'VALTEST200', 'USD')->'offers'), 0);
  perform tests.eq('recherche publique : idem', jsonb_array_length(public.public_search('10.9.0.2', 'VALTEST100', 'USD')->'results') || '/' ||
    jsonb_array_length(public.public_search('10.9.0.2', 'VALTEST200', 'USD')->'results'), '1/0');
  perform tests.eq('API d''offres : idem', (select count(*) from app.catalog_lots('VALTEST100', null, null, false, now()))::int || '/' ||
    (select count(*) from app.catalog_lots('VALTEST200', null, null, false, now()))::int, '1/0');
  perform tests.eq('API d''offres : prix valable au plus jusqu''à l''échéance du fabricant',
    (app.catalog_offer_json('LOT-VF1', null, 'USD', now())->>'price_valid_until')::timestamptz <= now() + interval '4 days 1 minute', true);
  perform tests.eq('/offres/ : durées affichées', (public.partner_offers('10.9.0.3', '', 'USD')->>'ttl_days') || '/' ||
    (public.partner_offers('10.9.0.3', '', 'USD')->>'ttl_days_manufacturer'), '7/14');
  perform tests.eq('état du fabricant : en ligne, 14 jours', (select (s->>'live') || '/' || (s->>'ttl_days') from (select public.seller_offer_status('VF1') s) x), '1/14');
  perform tests.eq('état du broker : à reconfirmer', (public.seller_offer_status('VB1')->>'to_reconfirm')::int, 1);
end $$;
reset role;

-- Durée propre : 5 jours pour le fabricant, son offre de 10 jours disparaît.
update public.organizations set offer_ttl_days = 5 where id = 'VF1';
set role service_role;
do $$ begin
  perform tests.eq('durée propre de 5 jours : offre de 10 jours retirée', jsonb_array_length(public.partner_offers('10.9.0.4', 'VALTEST100', 'USD')->'offers'), 0);
end $$;
reset role;
update public.organizations set offer_ttl_days = null where id = 'VF1';

-- Reconfirmation sans fichier : le broker remet ses offres en ligne, journal tenu.
set role service_role;
do $$
declare r jsonb;
begin
  r := public.seller_reconfirm('VB1', 'oVB1admin', 'wechat');
  perform tests.eq('reconfirmation : une offre', (r->>'lots')::int, 1);
  perform tests.eq('reconfirmation : échéance dans 7 jours', ((r->>'expires_at')::timestamptz - now()) > interval '6 days 23 hours', true);
  perform tests.eq('reconfirmation : offre de nouveau visible', jsonb_array_length(public.partner_offers('10.9.0.5', 'VALTEST200', 'USD')->'offers'), 1);
  perform tests.eq('reconfirmation : journalisée', (select count(*) from public.stock_reconfirmations where org_id = 'VB1' and channel = 'wechat' and by_who = 'oVB1admin')::int, 1);
  perform tests.eq('état : dernière reconfirmation connue', (public.seller_offer_status('VB1')->>'last_reconfirmed') is not null, true);
  begin perform public.seller_reconfirm('VB1', 'x', 'courrier'); raise exception 'ÉCHEC canal inconnu accepté';
  exception when sqlstate '22023' then raise notice 'ok  reconfirmation : canal inconnu refusé'; end;
  begin perform public.seller_reconfirm('S-INEXISTANT', 'x', 'depot'); raise exception 'ÉCHEC reconfirmation sans offre';
  exception when no_data_found then raise notice 'ok  reconfirmation : vendeur sans offre en stock refusé'; end;
end $$;
reset role;

-- Rappels : le fabricant expire dans 24 h (soon), le broker a expiré il y a 12 h (expired).
update public.lots set confirmed_at = now() - interval '13 days' where id = 'LOT-VF1';
update public.lots set confirmed_at = now() - interval '7 days 12 hours' where id = 'LOT-VB1';
set role service_role;
do $$
declare d jsonb;
begin
  d := public.due_stock_reminders();
  perform tests.eq('rappel « bientôt » pour le fabricant, avec ses administrateurs',
    (select e->>'kind' || ' ' || (e->'admins'->>0) from jsonb_array_elements(d) e where e->>'org_id' = 'VF1'), 'soon oVF1admin');
  perform tests.eq('rappel « expiré » pour le broker', (select e->>'kind' from jsonb_array_elements(d) e where e->>'org_id' = 'VB1'), 'expired');
  perform tests.eq('rappels : vendeurs de démonstration et bac à sable exclus', (select count(*) from jsonb_array_elements(d) e where e->>'org_id' in ('SBX'))::int, 0);
  perform public.record_stock_reminder('VF1', 'soon', (select (e->>'expires_at')::timestamptz from jsonb_array_elements(d) e where e->>'org_id' = 'VF1'), true);
  perform tests.eq('rappel envoyé : pas de second envoi', (select count(*) from jsonb_array_elements(public.due_stock_reminders()) e where e->>'org_id' = 'VF1')::int, 0);
  -- Reconfirmation : nouvelle échéance, plus de rappel dû.
  perform public.seller_reconfirm('VB1', 'oVB1admin', 'depot');
  perform tests.eq('après reconfirmation : plus de rappel', (select count(*) from jsonb_array_elements(public.due_stock_reminders()) e where e->>'org_id' = 'VB1')::int, 0);
end $$;
reset role;

-- Droits : rien d'accessible sans le serveur.
set role authenticated;
do $$ begin
  begin perform public.seller_reconfirm('VB1', 'x', 'depot'); raise exception 'ÉCHEC reconfirmation par un utilisateur';
  exception when insufficient_privilege then raise notice 'ok  reconfirmation réservée au serveur'; end;
  begin perform public.due_stock_reminders(); raise exception 'ÉCHEC rappels lisibles';
  exception when insufficient_privilege then raise notice 'ok  rappels réservés au serveur'; end;
end $$;
reset role;

delete from public.lots where id in ('LOT-VF1', 'LOT-VB1');
drop schema tests cascade;
select 'Tous les tests de la validité des offres par vendeur sont passés.' as resultat;
