-- Route RFQ des plateformes (ADR 0023) : création, validation, diffusion, règle des 48 h, réponses, clôture,
-- anonymat, idempotence, plafond, droits. Horloge simulée (p_now) : aucune attente réelle. Lancé par tools/test-db.sh.
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
create table if not exists tests.vars (k text primary key, v text);
grant all on tests.vars to service_role;

-- ------------------------------------------------------------ données fictives propres à ce contrôle
insert into public.organizations (id, type, name, alias, city, country, currency, lang, profile, kyb, sandbox) values
  ('PLAT',  'buyer',  'Plateforme Alpha (fictive)', 'P-ALPHA', 'Paris', 'FR', 'EUR', 'fr', null, 'validated', false),
  ('PLAT2', 'buyer',  'Plateforme Beta (fictive)', 'P-BETA', 'Paris', 'FR', 'EUR', 'fr', null, 'validated', false),
  ('RS1',   'seller', 'Fournisseur partenaire 1 (fictif)', 'V-901', 'Hong Kong', 'HK', 'USD', 'zh', 'Broker', 'validated', false),
  ('RS2',   'seller', 'Fournisseur partenaire 2 (fictif)', 'V-902', 'Shenzhen', 'CN', 'CNH', 'zh', 'Surplus EMS', 'validated', false),
  ('RS3',   'seller', 'Fournisseur partenaire 3, sans WeChat (fictif)', 'V-903', 'Shenzhen', 'CN', 'CNH', 'zh', 'Broker', 'validated', false),
  ('RSB',   'seller', 'Fournisseur du bac à sable (fictif)', 'V-TEST', 'Bac à sable', 'CN', 'USD', 'zh', 'Broker', 'validated', true);
insert into public.subscriptions (org_id, plan, until) values
  ('RS1', 'Test', current_date + 30), ('RS2', 'Test', current_date + 30), ('RS3', 'Test', current_date + 30);
insert into public.lots (id, seller_id, sku, mpn, manufacturer, qty, date_code, unit_price, currency) values
  ('LOT-RS1', 'RS1', 'SKU-SECRET-1', 'RFQTEST555', 'Texas Instruments', 1000, '2425', 0.40, 'USD'),
  ('LOT-RS2', 'RS2', 'SKU-SECRET-2', 'RFQTEST555', 'Texas Instruments', 300, '', 2.80, 'CNH'),
  ('LOT-RS3', 'RS3', 'SKU-SECRET-3', 'RFQTEST555', 'Texas Instruments', 900, '2430', 2.50, 'CNH'),
  ('LOT-RSB', 'RSB', 'SKU-SECRET-B', 'RFQTEST555', 'Texas Instruments', 5000, '2440', 0.30, 'USD'),
  ('LOT-OLD', 'RS1', 'SKU-SECRET-4', 'RFQOLD1', '', 50, '1990', 1, 'USD');
insert into public.wechat_identities (openid, org_id, role) values ('oRS1', 'RS1', 'admin'), ('oRS2', 'RS2', 'admin'),
  ('oRSB', 'RSB', 'admin');
insert into app.seller_margins (org_id, margin_pct) values ('RS1', 10), ('RS2', 5), ('RSB', 10)
on conflict (org_id) do update set margin_pct = excluded.margin_pct;
insert into public.webhooks (id, org_id, url, events, signing_secret_ref) values
  ('WHK-RFQ', 'PLAT', 'https://plateforme.example/hook', '{demand.validated,demand.rejected,demand.offers_ready,demand.no_offer}', 'derived:v1');
-- Clés : empreinte seule (sha256 de la clé).
insert into public.api_keys (id, org_id, environment, prefix, key_hash, scopes) values
  ('KEY-RFQ1', 'PLAT', 'live', 'cp_live_ab', encode(extensions.digest('cp_live_abcdef', 'sha256'), 'hex'), '{demands:write}'),
  ('KEY-RFQ2', 'PLAT', 'sandbox', 'cp_test_ab', encode(extensions.digest('cp_test_abcdef', 'sha256'), 'hex'), '{demands:write}'),
  ('KEY-RFQ3', 'RS1', 'live', 'cp_live_zz', encode(extensions.digest('cp_live_vendeur', 'sha256'), 'hex'), '{}');
insert into public.api_keys (id, org_id, environment, prefix, key_hash, revoked_at) values
  ('KEY-RFQ4', 'PLAT', 'live', 'cp_live_rv', encode(extensions.digest('cp_live_revoquee', 'sha256'), 'hex'), now());

create table if not exists tests.rfq (k text primary key, v text);
-- Empreinte d'une clé (le rôle service_role n'a pas accès au schéma extensions dans la base de test).
create or replace function tests.h(k text) returns text language sql security definer as $$ select encode(extensions.digest(k, 'sha256'), 'hex') $$;
grant execute on function tests.h(text) to service_role;
grant all on tests.rfq to service_role;

set role service_role;
do $$
declare
  t0 timestamptz := '2026-11-03 09:00+00';
  body jsonb := '{"customer_reference": "ADS-CLIENT-SECRET-42", "currency": "EUR", "ship_to_country": "de",
    "lines": [{"line_id": "L1", "mpn": "rfqtest 555", "manufacturer": "Texas Instruments", "quantity": 300, "target_price": 0.3},
              {"line_id": "L2", "mpn": "RFQTEST555", "quantity": 200, "date_code_min": "2420"}]}';
  r jsonb; d1 text; d2 text; n int;
begin
  -- ---------------------------------------------------------- authentification
  r := public.rfq_auth(tests.h('cp_live_abcdef'), t0);
  perform tests.eq('clé : organisation et portée', (r->>'org_id') || ' ' || (r->'scopes'->>0) || ' ' || (r->>'sandbox'), 'PLAT demands:write false');
  perform tests.eq('clé de test : bac à sable', public.rfq_auth(tests.h('cp_test_abcdef'), t0)->>'sandbox', 'true');
  perform tests.fails('clé inconnue : refusée', $s$select public.rfq_auth('00', now())$s$, 'CP401');
  perform tests.fails('clé révoquée : refusée', format('select public.rfq_auth(%L)', tests.h('cp_live_revoquee')), 'CP401');
  perform tests.fails('clé d''un fournisseur : refusée', format('select public.rfq_auth(%L)', tests.h('cp_live_vendeur')), 'CP403');
  for n in 2..60 loop perform public.rfq_auth(tests.h('cp_live_abcdef'), t0); end loop;
  perform tests.fails('61e appel de la minute : 429', format('select public.rfq_auth(%L, %L)', tests.h('cp_live_abcdef'), t0), 'CP429');
  perform tests.eq('minute suivante : de nouveau accepté',
    public.rfq_auth(tests.h('cp_live_abcdef'), t0 + interval '1 minute')->>'remaining', '59');

  -- ---------------------------------------------------------- création
  perform tests.fails('création : Idempotency-Key obligatoire', format('select public.create_rfq(%L, %L, %L, %L)', 'PLAT', '', 'h', body), '22023');
  perform tests.fails('création : devise refusée', format('select public.create_rfq(%L, %L, %L, %L)', 'PLAT', 'k-cur', 'h',
    jsonb_set(body, '{currency}', '"CHF"')), '22023');
  perform tests.fails('création : aucune ligne', format('select public.create_rfq(%L, %L, %L, %L)', 'PLAT', 'k-0', 'h',
    jsonb_set(body, '{lines}', '[]')), '22023');
  perform tests.fails('création : mpn vide', format('select public.create_rfq(%L, %L, %L, %L)', 'PLAT', 'k-mpn', 'h',
    jsonb_set(body, '{lines,0,mpn}', '" "')), '22023');
  perform tests.fails('création : quantité nulle', format('select public.create_rfq(%L, %L, %L, %L)', 'PLAT', 'k-qty', 'h',
    jsonb_set(body, '{lines,0,quantity}', '0')), '22023');
  perform tests.fails('création : pays invalide', format('select public.create_rfq(%L, %L, %L, %L)', 'PLAT', 'k-ctry', 'h',
    jsonb_set(body, '{ship_to_country}', '"Allemagne"')), '22023');
  perform tests.fails('création : 51 lignes', format('select public.create_rfq(%L, %L, %L, %L)', 'PLAT', 'k-51', 'h',
    jsonb_set(body, '{lines}', (select jsonb_agg(jsonb_build_object('mpn', 'X' || i, 'quantity', 1)) from generate_series(1, 51) i))), '22023');

  r := public.create_rfq('PLAT', 'idem-1', 'hash-1', body, false, t0);
  d1 := r->'demands'->0->>'id'; d2 := r->'demands'->1->>'id';
  insert into tests.rfq values ('d1', d1), ('d2', d2), ('rfq', r->>'rfq_id');
  perform tests.eq('création : une demande par ligne, en attente', jsonb_path_query_array(r, '$.demands[*].status'), '["pending_validation", "pending_validation"]');
  perform tests.eq('création : identifiants de ligne repris', jsonb_path_query_array(r, '$.demands[*].line_id'), '["L1", "L2"]');
  perform tests.eq('création : rfq_id RFQ-', left(r->>'rfq_id', 4), 'RFQ-');
  perform tests.eq('création : référence normalisée, pays en zone',
    (select mpn || ' ' || zone || ' ' || currency || ' ' || client_org_id from public.demands where id = d1), 'RFQTEST555 DE EUR PLAT');
  perform tests.eq('rejeu, même corps : même réponse', public.create_rfq('PLAT', 'idem-1', 'hash-1', body, false, t0 + interval '1 hour'), r);
  perform tests.eq('rejeu : rien de créé', (select count(*) from public.demands where batch_ref = r->>'rfq_id'), 2::bigint);
  perform tests.fails('rejeu, autre corps : 409', format('select public.create_rfq(%L, %L, %L, %L)', 'PLAT', 'idem-1', 'hash-2', body), 'CP409');
  perform tests.eq('CNY accepté comme CNH',
    public.create_rfq('PLAT2', 'idem-cny', 'h', jsonb_set(jsonb_set(body, '{currency}', '"cny"'), '{lines}', '[{"mpn": "RFQTEST555", "quantity": 1}]'), false, t0)->'demands'->0->>'status',
    'pending_validation');
  perform tests.eq('devise CNY enregistrée en CNH', (select currency from public.demands where client_org_id = 'PLAT2' and idempotency_key = 'idem-cny')::text, 'CNH');

  -- Rien ne part avant la validation.
  perform tests.eq('avant validation : aucun fournisseur consulté', (select count(*) from public.demand_sellers where demand_id in (d1, d2)), 0::bigint);
  perform tests.eq('avant validation : aucun destinataire', public.rfq_contacts(d1), '[]'::jsonb);
  perform tests.eq('fiche administrateur : client, référence client, appariés (RS3 sans WeChat exclu)',
    (select (j->>'client') || ' | ' || (j->>'customer_reference') || ' | ' || (j->'candidates')::text from public.rfq_for_operator(d1) j),
    'PLAT Plateforme Alpha (fictive) | ADS-CLIENT-SECRET-42 | ["RS1", "RS2"]');
  perform tests.eq('date code minimum : RS2 (inconnu) gardé, RS1 (2425 ≥ 2420) gardé',
    public.rfq_for_operator(d2)->'candidates', '["RS1", "RS2"]'::jsonb);
  perform tests.eq('liste à valider', (select count(*) from jsonb_array_elements(public.list_pending_rfq()) x where x->>'id' in (d1, d2)), 2::bigint);
  perform tests.eq('lecture plateforme : statut', public.rfq_demand_for_client('PLAT', d1)->>'status', 'pending_validation');
  perform tests.eq('lecture plateforme : demande d''une autre plateforme invisible', public.rfq_demand_for_client('PLAT2', d1), null::jsonb);
  perform tests.eq('liste plateforme : filtre customer_reference',
    jsonb_array_length(public.rfq_demands_for_client('PLAT', null, 'ADS-CLIENT-SECRET-42')), 2);

  -- ---------------------------------------------------------- rappel à l'administrateur
  perform tests.eq('rappel administrateur : pas avant 24 h', public.claim_ops_rfq_reminders(t0 + interval '23 hours') ? d1, false);
  perform tests.eq('rappel administrateur : à 24 h', public.claim_ops_rfq_reminders(t0 + interval '24 hours') ? d1, true);
  perform tests.eq('rappel administrateur : une seule fois', public.claim_ops_rfq_reminders(t0 + interval '30 hours') ? d1, false);
  perform tests.eq('rappel : toujours en attente (jamais diffusée seule)', (select status from public.demands where id = d1), 'pending_validation');

  -- ---------------------------------------------------------- validation
  perform tests.fails('validation : société hors appariement', format('select public.approve_rfq(%L, %L, %L)', d1, 'oOP', '{RS3}'), '22023');
  r := public.approve_rfq(d1, 'oOP', null, null, t0);
  perform tests.eq('validation : enchère ouverte', r->>'status', 'auction');
  perform tests.eq('validation : deux fournisseurs à prévenir', (select string_agg(seller_id || ':' || notify_status, ',' order by seller_id)
    from public.demand_sellers where demand_id = d1), 'RS1:pending,RS2:pending');
  perform tests.eq('validation : aucune échéance avant envoi', (select count(*) from public.demand_sellers where demand_id = d1 and deadline_at is not null), 0::bigint);
  perform tests.fails('validation : deux fois', format('select public.approve_rfq(%L, %L)', d1, 'oOP'), 'CP409');
  perform tests.fails('refus après validation', format('select public.reject_rfq(%L, %L, %L)', d1, 'x', 'oOP'), 'CP409');
  perform tests.eq('validation : journal', (select decision || ' ' || by from public.demand_decisions where demand_id = d1), 'approved oOP');
  perform tests.eq('validation : webhook demand.validated', (select count(*) from public.webhook_deliveries
    where event = 'demand.validated' and payload->>'demand_id' = d1 and payload->>'status' = 'open'), 1::bigint);
  r := public.approve_rfq(d2, 'oOP', '{RS1}', null, t0);
  perform tests.eq('validation limitée : RS1 seul', (select string_agg(seller_id, ',') from public.demand_sellers where demand_id = d2), 'RS1');

  -- ---------------------------------------------------------- anonymat côté fournisseur
  r := public.rfq_contacts(d1);
  perform tests.eq('destinataires : comptes WeChat des fournisseurs', jsonb_path_query_array(r, '$[*].openids[0]'), '["oRS1", "oRS2"]');
  perform tests.eq('fiche fournisseur : ni plateforme, ni référence client, ni prix cible',
    (r::text ~* 'Plateforme|PLAT|ADS-CLIENT|target|0\.3[^0-9]' ), false);
  perform tests.eq('fiche fournisseur : référence, quantité, zone', (select (c->>'ref') || ' ' || (c->>'qty') || ' ' || (c->>'ship_to')
    from jsonb_path_query(r, '$[0].card') c), d1 || ' 300 DE');
  perform tests.eq('vue v_seller_demands : sans colonne client',
    (select count(*) from information_schema.columns where table_name = 'v_seller_demands'
      and column_name in ('client_org_id', 'customer_reference', 'target_price', 'buyer_id')), 0::bigint);

  -- ---------------------------------------------------------- envois
  perform public.record_notify_result(d1, 'RS1', true, null, t0);
  perform public.record_notify_result(d1, 'RS2', false, 'WeChat 45015 (fenêtre de 48 h dépassée)', t0);
  perform public.record_notify_result(d2, 'RS1', true, null, t0);
  perform tests.eq('envoi réussi : échéance = envoi + 48 h', (select deadline_at from public.demand_sellers where demand_id = d1 and seller_id = 'RS1'), t0 + interval '48 hours');
  perform tests.eq('envoi échoué : pas d''échéance', (select coalesce(deadline_at::text, 'aucune') || ' ' || notify_status
    from public.demand_sellers where demand_id = d1 and seller_id = 'RS2'), 'aucune failed');
  perform tests.eq('envoi échoué : rien compté contre RS2', (select coalesce(sum(received), 0) from public.supplier_scores where seller_id = 'RS2'), 0::bigint);
  perform tests.fails('envoi échoué : réponse refusée tant qu''il n''est pas prévenu',
    format('select public.supplier_rfq_answer(%L, %L, %L)', 'oRS2', d1, 'decline'), 'P0002');
  perform tests.eq('destinataires restants : RS2 seul', jsonb_path_query_array(public.rfq_contacts(d1), '$[*].seller_id'), '["RS2"]');
  perform tests.fails('renvoi d''un fournisseur déjà prévenu', format('select public.resend_rfq(%L, %L, %L)', d1, 'RS1', 'oOP'), 'CP409');
  perform public.resend_rfq(d1, 'RS2', 'oOP', t0 + interval '2 hours');
  perform public.record_notify_result(d1, 'RS2', true, null, t0 + interval '2 hours');
  perform tests.eq('renvoi réussi : échéance démarre à l''envoi réussi', (select deadline_at from public.demand_sellers where demand_id = d1 and seller_id = 'RS2'), t0 + interval '50 hours');
  perform tests.eq('enchère prolongée jusqu''à la dernière échéance', (select closes_at from public.demands where id = d1), t0 + interval '50 hours');

  -- ---------------------------------------------------------- rappels à 36 h
  perform tests.eq('rappel : pas avant 36 h', jsonb_array_length(public.claim_rfq_reminders(t0 + interval '35 hours')), 0);
  perform tests.eq('rappel à 36 h : RS1 sur les deux demandes', jsonb_path_query_array(public.claim_rfq_reminders(t0 + interval '36 hours'), '$[*].card.ref'), jsonb_build_array(d1, d2));
  perform tests.eq('rappel : une seule fois', jsonb_array_length(public.claim_rfq_reminders(t0 + interval '37 hours')), 0);
  perform tests.eq('rappel de RS2 (prévenu 2 h plus tard) à 38 h', jsonb_path_query_array(public.claim_rfq_reminders(t0 + interval '38 hours'), '$[*].seller_id'), '["RS2"]');

  -- ---------------------------------------------------------- réponses et règle des 48 h
  perform tests.fails('réponse : contact d''une autre société', format('select public.supplier_rfq_answer(%L, %L, %L)', 'oRSB', d1, 'decline'), 'P0002');
  perform tests.fails('réponse : devise refusée', format('select public.supplier_rfq_answer(%L, %L, %L, 0.4, %L, 5, %L, null, %L)', 'oRS1', d1, 'quote', 'CHF', '2425', t0 + interval '1 hour'), '22023');
  perform tests.fails('réponse : prix nul', format('select public.supplier_rfq_answer(%L, %L, %L, 0, %L, 5, %L, null, %L)', 'oRS1', d1, 'quote', 'USD', '2425', t0 + interval '1 hour'), '22023');
  perform tests.fails('réponse : lot d''une autre référence', format('select public.supplier_rfq_answer(%L, %L, %L, 0.4, %L, 5, %L, %L, %L)', 'oRS1', d1, 'quote', 'USD', '2425', 'LOT-OLD', t0 + interval '1 hour'), '22023');
  r := public.supplier_rfq_answer('oRS1', d1, 'quote', 0.38, 'usd', 5, null, null, t0 + interval '47 hours 59 minutes');
  perform tests.eq('réponse à 47 h 59 : acceptée, date code du lot', (select net::numeric(6,2) || ' ' || currency || ' ' || date_code || ' ' || lead_days
    from public.bids where demand_id = d1 and seller_id = 'RS1'), '0.38 USD 2425 5');
  perform tests.eq('réponse : demande pas encore complète (RS2 en attente)', r->>'all_done', 'false');
  perform tests.fails('deuxième réponse du même fournisseur', format('select public.supplier_rfq_answer(%L, %L, %L, null, null, null, null, null, %L)', 'oRS1', d1, 'decline', t0 + interval '48 hours'), 'CP409');
  perform tests.fails('clôture avant la fin : refusée', format('select public.close_rfq(%L, %L)', d1, t0 + interval '48 hours'), 'CP409');
  perform tests.fails('réponse à 48 h 01 : refusée', format('select public.supplier_rfq_answer(%L, %L, %L, 0.30, %L, 5, %L, null, %L)', 'oRS1', d2, 'quote', 'USD', '2425', t0 + interval '48 hours 1 minute'), 'CP410');
  perform tests.eq('réponse tardive : aucun bid enregistré', (select count(*) from public.bids where demand_id = d2), 0::bigint);
  perform tests.fails('date code requis si le lot n''en a pas', format('select public.supplier_rfq_answer(%L, %L, %L, 2.2, %L, 3, null, null, %L)', 'oRS2', d1, 'quote', 'CNH', t0 + interval '49 hours'), '22023');
  r := public.supplier_rfq_answer('oRS2', d1, 'decline', null, null, null, null, null, t0 + interval '49 hours');
  perform tests.eq('无货 : réponse traitée, demande complète', (select response_status from public.demand_sellers where demand_id = d1 and seller_id = 'RS2') || ' ' || (r->>'all_done'), 'declined true');

  -- Expiration.
  perform tests.eq('expiration à 48 h 01', public.expire_overdue_sellers(t0 + interval '48 hours 1 minute') ? d2, true);
  perform tests.eq('expiré : compté « non traité »', (select response_status from public.demand_sellers where demand_id = d2 and seller_id = 'RS1'), 'expired');

  -- ---------------------------------------------------------- clôture et consolidation
  perform tests.eq('demandes à clore', public.rfq_due_for_close(t0 + interval '49 hours') @> jsonb_build_array(d1, d2), true);
  perform tests.eq('clôture automatique : seulement les RFQ des plateformes',
    (select count(*) from jsonb_array_elements_text(public.rfq_due_for_close(t0 + interval '30 days')) x
      join public.demands d on d.id = x where d.client_org_id is null), 0::bigint);
  r := public.close_rfq(d1, t0 + interval '49 hours');
  perform tests.eq('clôture : une offre, statut offers', (r->>'offers') || ' ' || (r->>'status'), '1 offers');
  -- 0,38 USD × 0,92 = 0,3496 EUR, + 10 % = 0,3846 EUR.
  r := public.rfq_offers_for_client('PLAT', d1, t0 + interval '50 hours');
  perform tests.eq('offre : prix tout compris dans la devise demandée', (r->'offers'->0->>'unit_price')::numeric, 0.3846);
  perform tests.eq('offre : fabricant affiché, catégorie broker_surplus, expédition HK',
    (r->'offers'->0->>'manufacturer') || ' ' || (r->'offers'->0->>'source_category') || ' ' || (r->'offers'->0->>'ship_from'),
    'Texas Instruments broker_surplus HK');
  perform tests.eq('offre : ni fournisseur, ni pseudonyme, ni SKU, ni lot, ni prix net',
    r::text ~ '(RS1|V-901|SKU-SECRET|LOT-RS|Fournisseur partenaire|"net"|0\.38[^0-9]|seller)', false);
  perform tests.eq('offre : statut offers_ready vu par la plateforme', r->>'status', 'offers_ready');
  perform tests.eq('offre : autre plateforme refusée', (select count(*) from public.demands where id = d1 and client_org_id = 'PLAT2'), 0::bigint);
  perform tests.eq('webhook demand.offers_ready, avec la référence client', (select payload->>'offers_count' || ' ' || (payload->>'customer_reference')
    from public.webhook_deliveries where event = 'demand.offers_ready' and payload->>'demand_id' = d1), '1 ADS-CLIENT-SECRET-42');
  perform tests.fails('clôture deux fois', format('select public.close_rfq(%L, %L)', d1, t0 + interval '50 hours'), 'CP409');
  r := public.close_rfq(d2, t0 + interval '49 hours');
  perform tests.eq('aucune réponse à temps : no_offer, bid tardif absent', (r->>'status') || ' ' || (r->>'offers'), 'no_offer 0');
  perform tests.eq('webhook demand.no_offer', (select count(*) from public.webhook_deliveries where event = 'demand.no_offer' and payload->>'demand_id' = d2), 1::bigint);
  perform tests.eq('offre expirée : plus listée', jsonb_array_length(public.rfq_offers_for_client('PLAT', d1, t0 + interval '30 days')->'offers'), 0);

  -- ---------------------------------------------------------- notation
  perform tests.eq('notation RS1 : 2 reçues, 1 avec prix, 1 expirée', (select (s->>'received') || ' ' || (s->>'quoted') || ' ' || (s->>'expired') || ' ' || (s->>'treatment_rate')
    from public.supplier_score('RS1') s), '2 1 1 0.500');
  perform tests.eq('notation RS2 : envoi échoué non compté, 无货 traité', (select (s->>'received') || ' ' || (s->>'declined') || ' ' || (s->>'treatment_rate')
    from public.supplier_score('RS2') s), '1 1 1.000');
  perform tests.eq('notation : sous le seuil de 10, sans effet', public.supplier_score('RS1')->>'counts_for_ranking', 'false');
  perform tests.eq('notation : sous le seuil, aucun poids', app.score_weight('RS1'), null::numeric);
  perform tests.eq('demandes expirées listées pour le fournisseur', public.supplier_score('RS1')->'expired_demands', jsonb_build_array(d2));
  perform tests.eq('/depot/ : demandes reçues et taux du fournisseur seulement',
    (select jsonb_array_length(x->'demands') || ' ' || (x->'score'->>'received') || ' ' || (x::text ~ 'RS2|PLAT|ADS-CLIENT')::text from public.supplier_rfqs('oRS1') x),
    '2 2 false');
end $$;
reset role;

-- ---------------------------------------------------------- refus, annulation, aucun apparié, bac à sable, plafond
set role service_role;
do $$
declare t0 timestamptz := '2026-11-04 09:00+00'; r jsonb; d text; n int;
  one jsonb := '{"currency": "EUR", "ship_to_country": "FR", "lines": [{"mpn": "RFQTEST555", "quantity": 100}]}';
begin
  d := public.create_rfq('PLAT', 'idem-rej', 'h', one, false, t0)->'demands'->0->>'id';
  perform tests.fails('refus sans motif', format('select public.reject_rfq(%L, %L, %L)', d, ' ', 'oOP'), 'CP005');
  r := public.reject_rfq(d, 'Référence hors périmètre', 'oOP', t0);
  perform tests.eq('refus : statut et motif', (r->>'status') || ' ' || (r->>'rejected_reason'), 'rejected Référence hors périmètre');
  perform tests.eq('refus : vu par la plateforme avec le motif', public.rfq_demand_for_client('PLAT', d)->>'rejected_reason', 'Référence hors périmètre');
  perform tests.eq('refus : webhook demand.rejected', (select count(*) from public.webhook_deliveries where event = 'demand.rejected' and payload->>'demand_id' = d), 1::bigint);
  perform tests.eq('refus : aucun fournisseur prévenu', (select count(*) from public.demand_sellers where demand_id = d), 0::bigint);

  d := public.create_rfq('PLAT', 'idem-can', 'h', one, false, t0)->'demands'->0->>'id';
  perform public.approve_rfq(d, 'oOP', null, null, t0);
  perform public.record_notify_result(d, 'RS1', true, null, t0);
  perform tests.fails('annulation par une autre plateforme', format('select public.cancel_rfq(%L, %L)', 'PLAT2', d), 'P0002');
  r := public.cancel_rfq('PLAT', d, t0 + interval '1 hour');
  perform tests.eq('annulation : statut et fournisseurs prévenus à informer', (r->'demand'->>'status') || ' ' || (r->'notify'->0->>'seller_id'), 'cancelled RS1');
  perform tests.fails('annulation deux fois', format('select public.cancel_rfq(%L, %L)', 'PLAT', d), 'CP409');
  perform tests.fails('réponse après annulation', format('select public.supplier_rfq_answer(%L, %L, %L, null, null, null, null, null, %L)', 'oRS1', d, 'decline', t0 + interval '2 hours'), 'CP409');

  d := public.create_rfq('PLAT', 'idem-none', 'h', jsonb_set(one, '{lines,0,mpn}', '"INTROUVABLE-1"'), false, t0)->'demands'->0->>'id';
  r := public.approve_rfq(d, 'oOP', null, null, t0);
  perform tests.eq('aucun fournisseur apparié : no_offer immédiat', r->>'status', 'no_offer');

  d := public.create_rfq('PLAT', 'idem-sbx', 'h', one, true, t0)->'demands'->0->>'id';
  perform tests.eq('bac à sable : seul le fournisseur de test est apparié', public.rfq_for_operator(d)->'candidates', '["RSB"]'::jsonb);
  d := public.create_rfq('PLAT', 'idem-live', 'h', one, false, t0)->'demands'->0->>'id';
  perform tests.eq('production : le fournisseur de test n''est jamais apparié', public.rfq_for_operator(d)->'candidates' ? 'RSB', false);

  -- Plafond : 50 demandes en attente par plateforme (PLAT2 en a déjà 1).
  perform public.create_rfq('PLAT2', 'idem-cap', 'h', jsonb_set(one, '{lines}',
    (select jsonb_agg(jsonb_build_object('mpn', 'CAP' || i, 'quantity', 1)) from generate_series(1, 49) i)), false, t0);
  perform tests.fails('plafond de 50 demandes en attente', format('select public.create_rfq(%L, %L, %L, %L)', 'PLAT2', 'idem-cap2', 'h', one), 'CP429');

  -- Webhooks de la plateforme.
  perform tests.fails('webhook : https obligatoire', $s$select public.rfq_webhook_create('PLAT2', 'http://x.example', '{demand.validated}')$s$, '22023');
  perform tests.fails('webhook : événement inconnu', $s$select public.rfq_webhook_create('PLAT2', 'https://x.example', '{demand.created}')$s$, '22023');
  r := public.rfq_webhook_create('PLAT2', 'https://x.example/h', '{demand.validated}');
  perform tests.eq('webhook : secret jamais en base', (select signing_secret_ref from public.webhooks where id = r->>'id'), 'derived:v1');
  perform tests.eq('webhook : liste', public.rfq_webhooks('PLAT2')->0->>'url', 'https://x.example/h');
  perform tests.fails('webhook : suppression par une autre plateforme', format('select public.rfq_webhook_delete(%L, %L)', 'PLAT', r->>'id'), 'P0002');
  perform public.rfq_webhook_delete('PLAT2', r->>'id');
  perform tests.eq('webhook : supprimé', jsonb_array_length(public.rfq_webhooks('PLAT2')), 0);
  -- Livraisons : deux événements créés maintenant, dus tout de suite.
  delete from public.webhook_deliveries where delivered_at is null;
  insert into public.webhook_deliveries (webhook_id, event, payload) values
    ('WHK-RFQ', 'demand.validated', '{"event": "demand.validated"}'), ('WHK-RFQ', 'demand.no_offer', '{"event": "demand.no_offer"}');
  r := public.claim_webhook_deliveries(now() + interval '1 minute', 500);
  perform tests.eq('livraisons dues : URL de l''abonnement', jsonb_path_query_array(r, '$[*].url'), '["https://plateforme.example/hook", "https://plateforme.example/hook"]');
  perform public.record_webhook_delivery((r->0->>'id')::bigint, false, 500, now());
  perform tests.eq('échec de livraison : nouvelle tentative plus tard', (select attempts || ' ' || (next_attempt_at > now()) from public.webhook_deliveries where id = (r->0->>'id')::bigint), '1 true');
  perform tests.eq('échec : pas redemandée tout de suite', jsonb_array_length(public.claim_webhook_deliveries(now(), 500)), 1);
  perform public.record_webhook_delivery((r->1->>'id')::bigint, true, 200, now());
  perform tests.eq('livraison réussie', (select delivered_at is not null from public.webhook_deliveries where id = (r->1->>'id')::bigint), true);
  perform tests.eq('abandon après 24 h', jsonb_array_length(public.claim_webhook_deliveries(now() + interval '25 hours', 500)), 0);
end $$;
reset role;

-- ---------------------------------------------------------- droits
do $$ begin
  perform tests.eq('anon ne peut pas créer de RFQ', has_function_privilege('anon', 'public.create_rfq(text, text, text, jsonb, boolean, timestamptz)', 'execute'), false);
  perform tests.eq('authenticated ne peut pas créer de RFQ', has_function_privilege('authenticated', 'public.create_rfq(text, text, text, jsonb, boolean, timestamptz)', 'execute'), false);
  perform tests.eq('authenticated ne peut pas valider hors back office', has_function_privilege('authenticated', 'public.approve_rfq(text, text, text[], timestamptz, timestamptz)', 'execute'), false);
  perform tests.eq('anon ne peut pas répondre à la place d''un fournisseur', has_function_privilege('anon', 'public.supplier_rfq_answer(text, text, text, numeric, text, int, text, text, timestamptz)', 'execute'), false);
  perform tests.eq('anon : aucune lecture des décisions', has_table_privilege('anon', 'public.demand_decisions', 'select'), false);
  perform tests.eq('anon : aucune lecture des notes', has_table_privilege('anon', 'public.supplier_scores', 'select'), false);
end $$;
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000f1';
do $$ begin
  perform tests.fails('back office : non-administrateur refusé (liste)', 'select public.admin_rfq_list()', '42501');
  perform tests.fails('back office : non-administrateur refusé (validation)', $s$select public.admin_rfq_approve('DEM-1000')$s$, '42501');
  perform tests.fails('back office : non-administrateur refusé (note)', $s$select public.admin_supplier_score('RS1')$s$, '42501');
  perform tests.eq('RLS : un utilisateur sans organisation ne lit aucune note', (select count(*) from public.supplier_scores), 0::bigint);
end $$;
reset role; reset request.jwt.claim.sub;

drop schema tests cascade;
