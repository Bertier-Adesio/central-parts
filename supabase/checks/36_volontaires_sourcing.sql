-- Tests des brokers volontaires de la recherche payante (migration 20261109000042, ADR 0033) : inscription, ouverture au
-- paiement, envoi, réponses (offre, 无货, après 48 h), prix tout compris, page de l'acheteur, prolongation, arrêt,
-- commande, tâche planifiée, note du vendeur, back office. Sociétés et demandes fictives. Lancé par tools/test-db.sh.
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

insert into public.organizations (id, type, name, alias, city, country, currency, lang, profile, kyb, sandbox) values
  ('VS1', 'seller', 'Broker volontaire 1 (fictif)', 'V-951', 'Hong Kong', 'HK', 'USD', 'zh', 'Broker', 'validated', false),
  ('VS2', 'seller', 'Surplus volontaire 2 (fictif)', 'V-952', 'Shenzhen', 'CN', 'CNH', 'zh', 'Surplus EMS', 'validated', false),
  ('VS3', 'seller', 'Distributeur non éligible (fictif)', 'V-953', 'Shenzhen', 'CN', 'CNH', 'zh', 'Distributor', 'validated', false),
  ('VS4', 'seller', 'Broker en attente (fictif)', 'V-954', 'Shenzhen', 'CN', 'CNH', 'zh', 'Broker', 'pending', false),
  ('VS5', 'seller', 'Broker volontaire 5, sans réponse (fictif)', 'V-955', 'Shenzhen', 'CN', 'CNH', 'zh', 'Broker', 'validated', false);
insert into public.wechat_identities (openid, org_id, role) values ('oVS1', 'VS1', 'admin'), ('oVS2', 'VS2', 'admin'),
  ('oVS3', 'VS3', 'admin'), ('oVS4', 'VS4', 'admin'), ('oVS5', 'VS5', 'admin');
-- Conditions négociées à l'avance : 10 % pour VS1 ; VS2 et VS5 sans marge propre ni marge de catégorie.
insert into app.seller_margins (org_id, margin_pct) values ('VS1', 10) on conflict (org_id) do update set margin_pct = excluded.margin_pct;
delete from app.price_rules where category in ('broker', 'surplus');

set role service_role;
do $$
declare s jsonb; o jsonb; r jsonb; t0 timestamptz := '2026-11-10 08:00+00';
begin
  -- Inscription par le vendeur (/depot/) : brokers et surplus approuvés seulement.
  s := public.supplier_sourcing('oVS1');
  perform tests.eq('broker approuvé : éligible, pas encore volontaire', (s->>'eligible') || ' ' || coalesce(s->>'volunteer', '-'), 'true -');
  s := public.supplier_sourcing_join('oVS1', true, '  Laboratoire fictif de Shenzhen  ');
  perform tests.eq('inscription : volontaire actif, laboratoires enregistrés', (s#>>'{volunteer,active}') || ' ' || (s#>>'{volunteer,labs}'), 'true Laboratoire fictif de Shenzhen');
  perform public.supplier_sourcing_join('oVS2', true, null);
  perform public.supplier_sourcing_join('oVS5', true, '');
  perform tests.fails('distributeur : inscription refusée', $s$select public.supplier_sourcing_join('oVS3', true, null)$s$, '42501');
  perform tests.fails('broker non approuvé : inscription refusée', $s$select public.supplier_sourcing_join('oVS4', true, null)$s$, '42501');
  perform tests.fails('contact inconnu : refusé', $s$select public.supplier_sourcing_join('oINCONNU', true, null)$s$, '42501');

  -- Recherche payée → ouverte 7 jours aux volontaires actifs.
  r := public.create_sourcing_request('10.9.8.1', '{"mpn": "VOLTEST1", "manufacturer": "Fabricant fictif", "qty": 1000, "company": "Acheteur secret (fictif)",
    "contact": "Contact secret", "email": "secret@exemple.test", "country": "US", "target_price": "3", "notes": "Note secrète de l''acheteur"}');
  insert into tests.vars values ('src', r->>'id'), ('tok', r->>'token');
  perform tests.eq('non payée : pas d''ouverture', public.sourcing_open(r->>'id', t0), null::jsonb);
  perform public.sourcing_set_payment_ref(r->>'id', 'BRQ_VOL_1');
  perform public.sourcing_mark_paid('BRQ_VOL_1');
  o := public.sourcing_open(r->>'id', t0);
  perform tests.eq('payée : ouverte 7 jours, 3 volontaires à prévenir', (o->>'volunteers') || ' ' || ((o->>'open_until')::timestamptz = t0 + interval '7 days')::text
    || ' ' || jsonb_array_length(o->'contacts'), '3 true 3');
  perform tests.eq('ouverture rejouée : sans effet', public.sourcing_open(r->>'id', t0), null::jsonb);
  perform tests.eq('fiche du vendeur : ni société, ni contact, ni prix cible, ni précisions',
    (select (c->'card')::text ~ '(secret|Secrète|target|3\.0| notes)' from jsonb_array_elements(o->'contacts') c where c->>'seller_id' = 'VS1'), false);
  perform tests.eq('fiche du vendeur : référence, quantité, pays de livraison',
    (select (c#>>'{card,mpn}') || ' ' || (c#>>'{card,qty}') || ' ' || (c#>>'{card,ship_to}') from jsonb_array_elements(o->'contacts') c where c->>'seller_id' = 'VS1'), 'VOLTEST1 1000 US');

  -- Envoi : l'échéance de 48 h démarre à l'envoi réussi ; un échec ne compte pas.
  perform public.sourcing_notify_result(r->>'id', 'VS1', true, null, t0);
  perform public.sourcing_notify_result(r->>'id', 'VS2', true, null, t0 + interval '1 hour');
  perform public.sourcing_notify_result(r->>'id', 'VS5', false, 'WeChat: not delivered', t0);
  perform tests.eq('échec d''envoi : encore à prévenir', (select jsonb_array_length(public.sourcing_contacts(r->>'id'))), 1);
  perform public.sourcing_notify_result(r->>'id', 'VS5', true, null, t0 + interval '2 hours');
  perform tests.eq('échéance = envoi + 48 h', (select deadline_at from public.sourcing_sellers where request_id = r->>'id' and seller_id = 'VS1'), t0 + interval '48 hours');

  -- Réponses.
  perform tests.fails('devise refusée', format($s$select public.sourcing_answer('oVS1', '%s', 'quote', 1.2, 'XYZ', 5, '2420')$s$, r->>'id'), '22023');
  perform tests.fails('vendeur non consulté : inconnu', format($s$select public.sourcing_answer('oVS3', '%s', 'quote', 1.2, 'USD', 5, '2420')$s$, r->>'id'), 'P0002');
  s := public.sourcing_answer('oVS1', lower(r->>'id'), 'quote', 2.5, 'usd', 10, 'DC2420', null, t0 + interval '3 hours');
  insert into tests.vars values ('offer1', s->>'offer_id');
  perform tests.eq('offre dans les 48 h : comptée, prix tout compris calculé', (s->>'on_time') || ' ' || (s->>'priced'), 'true true');
  perform tests.eq('prix tout compris : 2,5 USD × 0,92 × 1,10', (select unit_price_eur from public.sourcing_offers where id = s->>'offer_id'), 2.5300::numeric);
  perform tests.eq('date code nettoyé', (select date_code from public.sourcing_offers where id = s->>'offer_id'), '2420');
  s := public.sourcing_answer('oVS1', r->>'id', 'quote', 2.1, 'USD', 30, '2318', 400, t0 + interval '4 hours');
  insert into tests.vars values ('offer2', s->>'offer_id');
  perform tests.eq('deuxième offre du même vendeur, partielle', (select qty from public.sourcing_offers where id = s->>'offer_id'), 400::bigint);
  perform tests.fails('无货 après une offre : déjà répondu', format($s$select public.sourcing_answer('oVS1', '%s', 'decline')$s$, r->>'id'), 'CP409');
  s := public.sourcing_answer('oVS2', r->>'id', 'decline', null, null, null, null, null, t0 + interval '5 hours');
  perform tests.eq('无货 dans les 48 h : compté', s->>'on_time', 'true');
  s := public.sourcing_answer('oVS2', r->>'id', 'quote', 15, 'CNY', 7, '2401', null, t0 + interval '3 days');
  perform tests.eq('trouvée après 无货 : offre acceptée, sans marge (non montrée)', (s->>'priced') || ' ' ||
    (select response_status from public.sourcing_sellers where request_id = r->>'id' and seller_id = 'VS2'), 'false quoted');
end $$;

-- Tâche planifiée : rappel à 36 h, échéance de 48 h.
do $$
declare t jsonb; v_id text := (select v from tests.vars where k = 'src'); t0 timestamptz := '2026-11-10 08:00+00';
begin
  t := public.sourcing_tick(t0 + interval '39 hours');
  perform tests.eq('rappel à 36 h : VS5 seulement (sans réponse)', (select string_agg(x->>'seller_id', ',') from jsonb_array_elements(t->'reminders') x), 'VS5');
  t := public.sourcing_tick(t0 + interval '40 hours');
  perform tests.eq('rappel une seule fois', jsonb_array_length(t->'reminders'), 0);
  t := public.sourcing_tick(t0 + interval '51 hours');
  perform tests.eq('48 h sans réponse : expiré', (select response_status from public.sourcing_sellers where request_id = v_id and seller_id = 'VS5'), 'expired');
  perform tests.eq('recherche encore ouverte', (select status from public.sourcing_requests where id = v_id), 'in_progress');
  perform public.sourcing_answer('oVS5', v_id, 'quote', 20, 'CNH', 3, '2433', null, t0 + interval '60 hours');
  perform tests.eq('offre après 48 h : acceptée, vendeur toujours « expiré » pour la note',
    (select response_status from public.sourcing_sellers where request_id = v_id and seller_id = 'VS5')
    || ' ' || (select count(*) from public.sourcing_offers where request_id = v_id and seller_id = 'VS5'), 'expired 1');
end $$;

-- Page de l'acheteur : offres anonymes, prix tout compris ; prolongation ; commande.
do $$
declare s jsonb; a jsonb; tok text := (select v from tests.vars where k = 'tok'); t0 timestamptz := '2026-11-10 08:00+00';
begin
  s := public.sourcing_status(tok);
  perform tests.eq('acheteur : ouverte, 3 vendeurs consultés, 2 offres avec prix (sans marge : non montrée)',
    (s->>'open') || ' ' || (s->>'sellers') || ' ' || jsonb_array_length(s->'offers'), 'true 3 2');
  perform tests.eq('offres triées par prix, vendeur anonyme, laboratoire signalé',
    (select string_agg((x->>'unit_price') || '/' || (x->>'source') || '/' || (x->>'ship_from') || '/' || (x->>'lab_test'), ' ') from jsonb_array_elements(s->'offers') x),
    '2.1252/broker/HK/true 2.5300/broker/HK/true');
  perform tests.eq('acheteur : jamais le vendeur, son prix net ni sa devise', (s->'offers')::text ~ '(VS1|V-951|Broker volontaire|"net"|USD)', false);
  perform tests.eq('offre partielle signalée, total sur la quantité proposée',
    (select (x->>'partial') || ' ' || (x->>'total') from jsonb_array_elements(s->'offers') x where (x->>'qty')::int = 400), 'true 850.08');
  a := public.sourcing_buyer_action(tok, 'extend', null, false, t0 + interval '6 days');
  perform tests.eq('prolongation : +7 jours, une fois', ((a#>>'{status,open_until}')::timestamptz = t0 + interval '14 days')::text || ' ' || (a#>>'{status,can_extend}'), 'true false');
  perform tests.fails('deuxième prolongation refusée', format($s$select public.sourcing_buyer_action('%s', 'extend')$s$, tok), 'CP409');
  perform tests.fails('offre sans prix : non commandable', format($s$select public.sourcing_buyer_action('%s', 'order', '%s')$s$, tok,
    (select id from public.sourcing_offers where seller_id = 'VS2' limit 1)), 'P0002');
  -- Commande en gardant la recherche ouverte, puis arrêt par le bouton.
  a := public.sourcing_buyer_action(tok, 'order', (select v from tests.vars where k = 'offer2'), true, t0 + interval '7 days');
  perform tests.eq('commande, recherche gardée ouverte : avis aux opérateurs avec le vendeur et son prix net',
    (a#>>'{status,open}') || ' ' || (a#>>'{order,seller_id}') || ' ' || (a#>>'{order,net}') || ' ' || coalesce(a->>'closed', '-'), 'true VS1 2.1 -');
  perform tests.fails('même offre commandée deux fois', format($s$select public.sourcing_buyer_action('%s', 'order', '%s')$s$, tok,
    (select v from tests.vars where k = 'offer2')), 'CP409');
  a := public.sourcing_buyer_action(tok, 'stop', null, false, t0 + interval '8 days');
  perform tests.eq('arrêt par l''acheteur : close, état « commandée »', (a#>>'{status,status}') || ' ' || (a#>>'{status,close_reason}') || ' ' || (a#>>'{status,open}'),
    'ordered buyer_stop false');
  perform tests.fails('réponse après l''arrêt refusée', format($s$select public.sourcing_answer('oVS2', '%s', 'quote', 1, 'USD', 1, '2401')$s$,
    (select v from tests.vars where k = 'src')), 'CP409');
  perform tests.fails('prolongation après l''arrêt refusée', format($s$select public.sourcing_buyer_action('%s', 'extend')$s$, tok), 'CP409');
  a := public.sourcing_buyer_action(tok, 'order', (select v from tests.vars where k = 'offer1'), false, t0 + interval '9 days');
  perform tests.eq('commande encore possible après la clôture', jsonb_array_length(a#>'{status,offers}') || ' ' || (a#>>'{order,offer}'),
    '2 ' || (select v from tests.vars where k = 'offer1'));
  perform tests.fails('lien inconnu', $s$select public.sourcing_buyer_action('inconnu', 'stop')$s$, 'P0002');
end $$;

-- Arrêt par une commande ; clôture à l'échéance ; volontaires sans réponse « clos » (hors note).
do $$
declare r jsonb; o jsonb; a jsonb; t jsonb; t1 timestamptz := '2026-11-20 08:00+00'; v_off text;
begin
  r := public.create_sourcing_request('10.9.8.2', '{"mpn": "VOLTEST2", "qty": 50, "company": "A (fictif)", "contact": "B", "email": "a@exemple.test", "country": "US"}');
  perform public.sourcing_set_payment_ref(r->>'id', 'BRQ_VOL_2'); perform public.sourcing_mark_paid('BRQ_VOL_2');
  o := public.sourcing_open(r->>'id', t1);
  perform public.sourcing_notify_result(r->>'id', 'VS1', true, null, t1);
  perform public.sourcing_notify_result(r->>'id', 'VS5', true, null, t1);
  v_off := public.sourcing_answer('oVS1', r->>'id', 'quote', 1, 'EUR', 2, '2440', null, t1 + interval '1 hour')->>'offer_id';
  a := public.sourcing_buyer_action(r->>'token', 'order', v_off, false, t1 + interval '2 hours');
  perform tests.eq('commande : la recherche s''arrête, VS5 prévenu', (a#>>'{status,status}') || ' ' || (a#>>'{closed,reason}') || ' '
    || (select string_agg(x->>'seller_id', ',') from jsonb_array_elements(a#>'{closed,tell}') x), 'ordered ordered VS5');
  perform tests.eq('VS5 arrêté avant l''échéance : « clos », hors note',
    (select response_status from public.sourcing_sellers where request_id = r->>'id' and seller_id = 'VS5'), 'closed');

  r := public.create_sourcing_request('10.9.8.3', '{"mpn": "VOLTEST3", "qty": 5, "company": "A (fictif)", "contact": "B", "email": "a@exemple.test", "country": "US"}');
  insert into tests.vars values ('src3', r->>'id');
  perform public.sourcing_set_payment_ref(r->>'id', 'BRQ_VOL_3'); perform public.sourcing_mark_paid('BRQ_VOL_3');
  perform public.sourcing_open(r->>'id', t1);
  perform public.sourcing_notify_result(r->>'id', 'VS2', true, null, t1);
  perform public.sourcing_answer('oVS2', r->>'id', 'decline', null, null, null, null, null, t1 + interval '1 hour');
  t := public.sourcing_tick(t1 + interval '7 days 1 minute');
  perform tests.eq('7 jours : close, sans offre → introuvable', (select status || ' ' || close_reason from public.sourcing_requests where id = r->>'id'), 'not_found expired');
end $$;

-- Note du vendeur : RFQ et recherches payantes ensemble ; « clos » ne compte pas.
do $$
declare s jsonb := public.supplier_score('VS5');
begin
  perform tests.eq('VS5 : 1 reçue (expirée), l''arrêt ne compte pas', (s->>'received') || ' ' || (s->>'expired') || ' ' || (s#>>'{sourcing,received}'), '1 1 1');
  s := public.supplier_score('VS1');
  perform tests.eq('VS1 : 2 reçues, 2 offres dans les 48 h', (s->>'received') || ' ' || (s->>'quoted') || ' ' || (s->>'treatment_rate'), '2 2 1.000');
  perform tests.eq('VS5 : échéance manquée listée', (select v from tests.vars where k = 'src') = any (select jsonb_array_elements_text(public.supplier_score('VS5')->'expired_demands')), true);
end $$;

-- Retrait par le vendeur : plus consulté.
do $$
declare s jsonb := public.supplier_sourcing_join('oVS5', false);
begin
  perform tests.eq('retrait : inactif', (s#>>'{volunteer,active}') || ' ' || ((s#>>'{volunteer,left_at}') is not null)::text, 'false true');
  perform tests.eq('recherches reçues listées sur /depot/', jsonb_array_length(s->'requests') >= 2, true);
end $$;
reset role;

-- Back office : volontaires (laboratoires), offres, retrait d'une offre.
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
do $$ begin
  perform tests.fails('non-administrateur : volontaires refusés', $s$select public.admin_sourcing_volunteers()$s$, '42501');
  perform tests.fails('non-administrateur : retrait refusé', $s$select public.admin_sourcing_offer_withdraw('SOF-1', 'x')$s$, '42501');
end $$;
reset role;
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000e1';
do $$
declare vol jsonb := public.admin_sourcing_volunteers(); l jsonb; v_id text := (select v from tests.vars where k = 'src'); f text := (select v from tests.vars where k = 'offer1');
begin
  perform tests.eq('administrateur : laboratoires visibles', (select x->>'labs' from jsonb_array_elements(vol) x where x->>'org_id' = 'VS1'), 'Laboratoire fictif de Shenzhen');
  vol := public.admin_sourcing_volunteer_set('VS2', '{"labs": "Labo corrigé par l''administrateur"}');
  perform tests.eq('administrateur : laboratoires modifiés', (select x->>'labs' from jsonb_array_elements(vol) x where x->>'org_id' = 'VS2'), 'Labo corrigé par l''administrateur');
  perform tests.fails('administrateur : distributeur refusé', $s$select public.admin_sourcing_volunteer_set('VS3', '{"active": true}')$s$, '22023');
  l := public.admin_sourcing_list('');
  perform tests.eq('administrateur : vendeurs consultés et offres, avec le vendeur',
    (select jsonb_array_length(x->'sellers') || ' ' || jsonb_array_length(x->'offers') || ' ' || (x->'offers'->0->>'org_id') from jsonb_array_elements(l->'rows') x where x->>'id' = v_id), '3 4 VS1');
  perform tests.fails('retrait sans motif refusé', format($s$select public.admin_sourcing_offer_withdraw('%s', ' ')$s$, f), 'CP005');
  perform public.admin_sourcing_offer_withdraw(f, 'Prix à revoir avec le vendeur');
end $$;
reset role;
set role service_role;
do $$ begin
  perform tests.eq('offre retirée : disparaît de la page de l''acheteur',
    jsonb_array_length(public.sourcing_status((select v from tests.vars where k = 'tok'))->'offers'), 1);
end $$;
reset role;

-- Nettoyage.
delete from public.sourcing_requests where mpn like 'VOLTEST%';
delete from public.sourcing_volunteers where org_id like 'VS%';
delete from public.supplier_scores where seller_id like 'VS%';
delete from app.seller_margins where org_id like 'VS%';
delete from public.wechat_identities where org_id like 'VS%';
delete from public.organizations where id like 'VS%';
drop schema tests cascade;
select 'Tous les tests des brokers volontaires sont passés.' as resultat;
