-- Tests des listes des vendeurs : lien personnel, dépôt complet, MOQ, date de confirmation, expiration,
-- API acheteur anonyme. Prérequis : checks précédents. Lancé par tools/test-db.sh.
\set ON_ERROR_STOP 1

create schema if not exists tests;
create or replace function tests.eq(label text, got anyelement, want anyelement) returns void language plpgsql as $$
begin
  if got is distinct from want then raise exception 'ÉCHEC % : obtenu %, attendu %', label, got, want; end if;
  raise notice 'ok  %', label;
end $$;
grant usage on schema tests to service_role, authenticated;
grant execute on all functions in schema tests to service_role, authenticated;

-- Vendeur partenaire fictif, approuvé par l'opérateur.
insert into public.organizations (id, type, name, alias, city, country, currency, lang, profile, kyb)
values ('P1', 'seller', 'Partenaire de test (fictif)', 'tmp-P1', 'Hong Kong', 'HK', 'USD', 'en', 'Broker', 'pending');
insert into app.price_rules (category, margin_pct) values ('broker', 10) on conflict (category) do update set margin_pct = 10;
create table tests.vars (k text primary key, v text);
grant all on tests.vars to service_role;

set role service_role;
do $$
declare t text;
begin
  begin perform public.create_depot_link('P1'); raise exception 'ÉCHEC lien pour un vendeur non approuvé';
  exception when no_data_found then raise notice 'ok  lien refusé tant que le vendeur n''est pas approuvé'; end;
  perform public.approve_supplier('P1', 'test');
  t := public.create_depot_link('P1', 'Démo electronica');
  insert into tests.vars values ('token', t);
  perform tests.eq('lien : jeton de 48 caractères', length(t), 48);
  perform tests.eq('lien : seule l''empreinte est gardée', (select count(*) from public.depot_links where token_hash = t), 0::bigint);
  perform tests.eq('lien : vendeur reconnu', public.depot_link_identity(t)->>'org_id', 'P1');
  perform tests.eq('lien : seuil de 7 jours par défaut', (public.depot_link_identity(t)->>'ttl_days')::int, 7);
  perform tests.eq('lien inconnu : refusé', public.depot_link_identity('faux'), null::jsonb);
  perform tests.eq('lien vide : refusé', public.depot_link_identity(null), null::jsonb);
end $$;
reset role;

-- Premier dépôt par le lien : fichier complet (rôle du stockage).
insert into storage.objects (bucket_id, name) values ('stock-imports', 'P1/20261102-090000-liste-complet.csv');

set role service_role;
do $$
declare imp text := (select id from public.stock_imports where storage_path = 'P1/20261102-090000-liste-complet.csv');
        res jsonb;
begin
  perform tests.eq('dépôt par le lien : fichier complet', (select replace_all from public.stock_imports where id = imp), true);
  res := public.apply_stock_import_batch(imp, '[
    {"line": 2, "mpn": "TLIN10283DRQ1", "mfr": "Texas Instruments", "sku": "T-0001", "qty": 2500, "price": 1.85, "currency": "USD", "moq": 1, "tiers": {"10": 1.72, "100": 1.58}},
    {"line": 3, "mpn": "IRLML2502TRPBF", "mfr": "Infineon", "sku": "T-0008", "qty": 60000, "price": 0.062, "currency": "USD", "moq": 100, "tiers": {"1000": 0.055}},
    {"line": 4, "mpn": "AD823ARZ-R7", "mfr": "Analog Devices", "sku": "T-0006", "qty": 5000, "price": 2.10, "currency": "USD", "moq": 1, "tiers": {}},
    {"line": 5, "mpn": "ADG419BRZ-REEL7", "sku": "T-0007", "qty": 3500, "currency": "XYZ"}
  ]', '[{"line": 6, "code": "breaks_price_order", "reason": "Prix des paliers en hausse"}]');
  perform public.finish_stock_import(imp);
  perform tests.eq('dépôt : 3 offres créées', (res->>'created')::int, 3);
  perform tests.eq('rapport : devise refusée avec son code', (select report->'rejected'->1->>'code' from public.stock_imports where id = imp), 'currency');
  perform tests.eq('rapport : rejet de lecture gardé avec son code', (select report->'rejected'->0->>'code' from public.stock_imports where id = imp), 'breaks_price_order');
  perform tests.eq('MOQ gardé', (select moq from public.lots where seller_id = 'P1' and sku = 'T-0008'), 100);
  perform tests.eq('date de confirmation posée', (select count(*) from public.lots where seller_id = 'P1' and confirmed_at > now() - interval '1 minute'), 3::bigint);
  perform tests.eq('état vendeur : 3 en ligne, 0 à reconfirmer',
    (select (s->>'live') || '/' || (s->>'to_reconfirm') from (select public.seller_offer_status('P1') s) x), '3/0');
end $$;

-- API acheteur : vendeur anonyme, date visible, prix tout compris.
do $$
declare res jsonb; o jsonb;
begin
  res := public.partner_offers('10.0.0.1', 'tlin', 'USD');
  o := res->'offers'->0;
  perform tests.eq('offres : une offre trouvée par début de référence', jsonb_array_length(res->'offers'), 1);
  perform tests.eq('offres : « Fournisseur partenaire »', o->>'supplier', 'partner');
  perform tests.eq('offres : ni nom, ni pseudonyme, ni SKU du vendeur',
    res::text ~ '(Partenaire de test|V-\d|T-0001|P1|example\.com)', false);
  perform tests.eq('offres : date de mise à jour présente', (o->>'updated_at') is not null, true);
  perform tests.eq('offres : prix « à partir de » avec marge (1,58 × 1,10)', (o->>'price_from')::numeric, 1.738);
  perform tests.eq('offres : quantité par tranche', o->>'availability', '1000+');
  perform tests.eq('offres : catégorie vendeur réservée, vide', o->'seller_category', 'null'::jsonb);
  perform tests.eq('offres sans recherche : liste des dernières offres', jsonb_array_length(public.partner_offers('10.0.0.1', '', 'USD')->'offers') >= 3, true);
  begin perform public.partner_offers('10.0.0.1', 'TL'); raise exception 'ÉCHEC recherche trop courte';
  exception when sqlstate '22023' then raise notice 'ok  recherche de 2 caractères refusée'; end;
end $$;

reset role;  -- le seuil se règle par l'opérateur (éditeur SQL), pas par les fonctions
-- Expiration : une offre non reconfirmée depuis 8 jours passe « à reconfirmer » et disparaît côté acheteur.
do $$
begin
  update public.lots set confirmed_at = now() - interval '8 days' where seller_id = 'P1' and sku = 'T-0001';
  perform tests.eq('expiration : offre retirée de l''API acheteur', jsonb_array_length(public.partner_offers('10.0.0.2', 'TLIN', 'USD')->'offers'), 0);
  perform tests.eq('expiration : offre retirée de la recherche publique', jsonb_array_length(public.public_search('10.0.0.2', 'TLIN', 'USD')->'results'), 0);
  perform tests.eq('expiration : le vendeur la voit à reconfirmer',
    (select (s->>'live') || '/' || (s->>'to_reconfirm') from (select public.seller_offer_status('P1') s) x), '2/1');
  update app.settings set value = '10' where name = 'offer_ttl_days';
  perform tests.eq('seuil porté à 10 jours : offre de nouveau visible', jsonb_array_length(public.partner_offers('10.0.0.2', 'TLIN', 'USD')->'offers'), 1);
  update app.settings set value = '7' where name = 'offer_ttl_days';
end $$;
reset role;

-- Nouveau dépôt complet : remplace la liste (absents à 0, paliers effacés si la ligne n'en donne pas), historique gardé.
insert into storage.objects (bucket_id, name) values ('stock-imports', 'P1/20261103-090000-liste-complet.csv');
set role service_role;
do $$
declare imp text := (select id from public.stock_imports where storage_path = 'P1/20261103-090000-liste-complet.csv');
begin
  perform public.apply_stock_import_batch(imp, '[
    {"line": 2, "mpn": "TLIN10283DRQ1", "mfr": "Texas Instruments", "sku": "T-0001", "qty": 2000, "price": 1.80, "currency": "USD", "tiers": {}}
  ]');
  perform public.finish_stock_import(imp);
  perform tests.eq('remplacement : 2 offres absentes retirées', (select withdrawn from public.stock_imports where id = imp), 2);
  perform tests.eq('remplacement : offre reconfirmée', (select confirmed_at > now() - interval '1 minute' from public.lots where seller_id = 'P1' and sku = 'T-0001'), true);
  perform tests.eq('remplacement : anciens paliers effacés', (select count(*) from public.lot_price_breaks b join public.lots l on l.id = b.lot_id where l.seller_id = 'P1' and l.sku = 'T-0001'), 0::bigint);
  perform tests.eq('remplacement : MOQ absent effacé', (select moq from public.lots where seller_id = 'P1' and sku = 'T-0001'), null::int);
  perform tests.eq('historique : deux dépôts gardés', (select count(*) from public.stock_imports where org_id = 'P1'), 2::bigint);
  perform tests.eq('état vendeur : 1 en ligne', (public.seller_offer_status('P1')->>'live')::int, 1);
end $$;

-- Révocation et vendeur suspendu.
do $$
declare t text := (select v from tests.vars where k = 'token');
begin
  update public.organizations set kyb = 'rejected' where id = 'P1';
  perform tests.eq('vendeur suspendu : lien refusé', public.depot_link_identity(t), null::jsonb);
  update public.organizations set kyb = 'validated' where id = 'P1';
  perform tests.eq('révocation : un lien révoqué', public.revoke_depot_links('P1'), 1);
  perform tests.eq('lien révoqué : refusé', public.depot_link_identity(t), null::jsonb);
end $$;
reset role;

-- Utilisateurs connectés et visiteurs : aucun accès direct.
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
do $$ begin
  begin perform public.partner_offers('x', 'TLIN'); raise exception 'ÉCHEC API acheteur appelée sans la fonction Edge';
  exception when insufficient_privilege then raise notice 'ok  API acheteur réservée au serveur'; end;
  begin perform count(*) from public.depot_links; raise exception 'ÉCHEC liens lisibles';
  exception when insufficient_privilege then raise notice 'ok  liens de dépôt illisibles'; end;
end $$;
reset role;

drop schema tests cascade;
select 'Tous les tests des listes des vendeurs sont passés.' as resultat;
