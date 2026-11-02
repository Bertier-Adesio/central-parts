-- Lecture agrégée d'une RFQ (GET /v1/rfqs/{rfq_id}, migration 20261103000022) : statut d'ensemble, décompte,
-- offres par ligne, isolement entre plateformes, anonymat, liste et filtres. Lancé par tools/test-db.sh.
\set ON_ERROR_STOP 1

create schema if not exists tests;
create or replace function tests.eq(label text, got anyelement, want anyelement) returns void language plpgsql as $$
begin
  if got is distinct from want then raise exception 'ÉCHEC % : obtenu %, attendu %', label, got, want; end if;
  raise notice 'ok  %', label;
end $$;
grant usage on schema tests to service_role, authenticated, anon;
grant execute on all functions in schema tests to service_role, authenticated, anon;

-- ------------------------------------------------------------ statut d'ensemble, seul
do $$ begin
  perform tests.eq('agrégé : une ligne à valider = en cours', app.rfq_aggregate_status('{pending_validation,offers_ready}'), 'in_progress');
  perform tests.eq('agrégé : une ligne ouverte = en cours', app.rfq_aggregate_status('{open,no_offer}'), 'in_progress');
  perform tests.eq('agrégé : une offre suffit', app.rfq_aggregate_status('{offers_ready,no_offer,rejected}'), 'offers_ready');
  perform tests.eq('agrégé : commandée compte comme offre', app.rfq_aggregate_status('{ordered,cancelled}'), 'offers_ready');
  perform tests.eq('agrégé : tout annulé', app.rfq_aggregate_status('{cancelled,cancelled}'), 'cancelled');
  perform tests.eq('agrégé : sans offre', app.rfq_aggregate_status('{no_offer,rejected,cancelled}'), 'no_offer');
  perform tests.eq('agrégé : statut inconnu = en cours', app.rfq_aggregate_status('{offers_ready,nouveau}'), 'in_progress');
  perform tests.eq('agrégé : aucune ligne', app.rfq_aggregate_status('{}'), null::text);
end $$;

-- ------------------------------------------------------------ données fictives propres à ce contrôle
insert into public.organizations (id, type, name, alias, city, country, currency, lang, profile, kyb, sandbox) values
  ('PLATA', 'buyer',  'Plateforme Agrégée (fictive)', 'P-AGG', 'Paris', 'FR', 'EUR', 'fr', null, 'validated', false),
  ('PLATZ', 'buyer',  'Autre plateforme (fictive)', 'P-AGZ', 'Lyon', 'FR', 'EUR', 'fr', null, 'validated', false),
  ('RA1',   'seller', 'Fournisseur agrégé secret (fictif)', 'V-981', 'Hong Kong', 'HK', 'USD', 'zh', 'Broker', 'validated', false);
insert into public.subscriptions (org_id, plan, until) values ('RA1', 'Test', current_date + 30);
insert into public.lots (id, seller_id, sku, mpn, manufacturer, qty, date_code, unit_price, currency) values
  ('LOT-RA1', 'RA1', 'SKU-AGG-SECRET', 'RFQAGG555', 'Texas Instruments', 1000, '2430', 0.40, 'USD');
insert into public.wechat_identities (openid, org_id, role) values ('oRA1', 'RA1', 'admin');
insert into app.seller_margins (org_id, margin_pct) values ('RA1', 10)
on conflict (org_id) do update set margin_pct = excluded.margin_pct;

set role service_role;
do $$
declare
  t0 timestamptz := '2026-11-03 09:00+00';
  body jsonb := '{"customer_reference": "ADS-AGG-7", "currency": "EUR", "ship_to_country": "de",
    "lines": [{"line_id": "L1", "mpn": "RFQAGG555", "quantity": 100},
              {"line_id": "L2", "mpn": "RFQAGG555", "quantity": 50},
              {"line_id": "L3", "mpn": "RFQAGG555", "quantity": 10}]}';
  r jsonb; rfq text; d1 text; d2 text; d3 text; rfq2 text;
begin
  r := public.create_rfq('PLATA', 'agg-1', 'hash-agg-1', body, false, t0);
  rfq := r->>'rfq_id'; d1 := r->'demands'->0->>'id'; d2 := r->'demands'->1->>'id'; d3 := r->'demands'->2->>'id';

  -- Avant validation.
  r := public.rfq_for_client('PLATA', rfq, t0);
  perform tests.eq('RFQ reçue : en cours, trois lignes à valider',
    (r->>'status') || ' ' || (r->>'lines_count') || ' ' || (r->'status_counts'->>'pending_validation'), 'in_progress 3 3');
  perform tests.eq('RFQ : référence, devise et pays repris', (r->>'customer_reference') || ' ' || (r->>'currency') || ' ' || (r->>'ship_to_country'), 'ADS-AGG-7 EUR DE');
  perform tests.eq('RFQ : lignes dans l''ordre, avec line_id et id', jsonb_path_query_array(r, '$.lines[*].line_id'), '["L1", "L2", "L3"]');
  perform tests.eq('RFQ : aucune offre avant validation', (r->>'offers_count')::int, 0);
  perform tests.eq('RFQ : pas de validité sans offre', r ? 'price_valid_until', false);
  perform tests.eq('RFQ : identifiant en minuscules accepté', public.rfq_for_client('PLATA', lower(rfq), t0)->>'rfq_id', rfq);
  perform tests.eq('RFQ : invisible pour une autre plateforme', public.rfq_for_client('PLATZ', rfq, t0), null::jsonb);
  perform tests.eq('RFQ : identifiant inconnu', public.rfq_for_client('PLATA', 'RFQ-999999', t0), null::jsonb);

  -- Validation de L1 et L2, refus de L3.
  perform public.approve_rfq(d1, 'oOP', '{RA1}', null, t0);
  perform public.approve_rfq(d2, 'oOP', '{RA1}', null, t0);
  perform public.reject_rfq(d3, 'Quantité trop faible', 'oOP', t0);
  perform public.record_notify_result(d1, 'RA1', true, null, t0);
  perform public.record_notify_result(d2, 'RA1', true, null, t0);
  r := public.rfq_for_client('PLATA', rfq, t0 + interval '1 minute');
  perform tests.eq('après validation : toujours en cours, décompte par statut',
    (r->>'status') || ' ' || (r->'status_counts'->>'open') || ' ' || (r->'status_counts'->>'rejected'), 'in_progress 2 1');
  perform tests.eq('ligne refusée : motif rendu', r->'lines'->2->>'rejected_reason', 'Quantité trop faible');

  -- Le fournisseur chiffre L1 et décline L2 ; clôture des deux.
  perform public.supplier_rfq_answer('oRA1', d1, 'quote', 0.40, 'USD', 5, '2430', null, t0 + interval '1 hour');
  perform public.supplier_rfq_answer('oRA1', d2, 'decline', null, null, null, null, null, t0 + interval '1 hour');
  perform public.close_rfq(d1, t0 + interval '2 hours');
  perform public.close_rfq(d2, t0 + interval '2 hours');

  r := public.rfq_for_client('PLATA', rfq, t0 + interval '3 hours');
  perform tests.eq('RFQ terminée : offres prêtes', r->>'status', 'offers_ready');
  perform tests.eq('décompte : une offre, une sans offre, une refusée',
    (r->'status_counts'->>'offers_ready') || ' ' || (r->'status_counts'->>'no_offer') || ' ' || (r->'status_counts'->>'rejected'), '1 1 1');
  perform tests.eq('statuts par ligne', jsonb_path_query_array(r, '$.lines[*].status'), '["offers_ready", "no_offer", "rejected"]');
  perform tests.eq('offres : seulement sur la ligne chiffrée',
    jsonb_array_length(r->'lines'->0->'offers') || ' ' || jsonb_array_length(r->'lines'->1->'offers') || ' ' || jsonb_array_length(r->'lines'->2->'offers'), '1 0 0');
  perform tests.eq('offres : mêmes champs que GET /v1/demands/{id}/offers',
    r->'lines'->0->'offers', public.rfq_offers_for_client('PLATA', d1, t0 + interval '3 hours')->'offers');
  perform tests.eq('offres : total et validité la plus proche',
    (r->>'offers_count') || ' ' || ((r->>'price_valid_until')::timestamptz = (r->'lines'->0->'offers'->0->>'price_valid_until')::timestamptz)::text, '1 true');
  perform tests.eq('offre : prix tout compris dans la devise demandée', r->'lines'->0->'offers'->0->>'currency', 'EUR');
  perform tests.eq('ligne : les champs de la RFQ ne sont pas répétés',
    (r->'lines'->0) ?| array['rfq_id', 'customer_reference', 'currency', 'ship_to_country'], false);
  perform tests.eq('anonymat : ni fournisseur, ni pseudonyme, ni SKU, ni lot',
    r::text ~ '(RA1|V-981|Fournisseur agrégé|SKU-AGG|LOT-RA1)', false);
  perform tests.eq('offres expirées : retirées de la lecture',
    jsonb_array_length(public.rfq_for_client('PLATA', rfq, t0 + interval '400 days')->'lines'->0->'offers'), 0);

  -- Une deuxième RFQ, entièrement annulée.
  r := public.create_rfq('PLATA', 'agg-2', 'hash-agg-2', jsonb_set(body, '{customer_reference}', '"ADS-AGG-8"'), false, t0 + interval '4 hours');
  rfq2 := r->>'rfq_id';
  perform public.cancel_rfq('PLATA', r->'demands'->0->>'id', t0 + interval '5 hours');
  perform public.cancel_rfq('PLATA', r->'demands'->1->>'id', t0 + interval '5 hours');
  perform tests.eq('annulation partielle : encore en cours', public.rfq_for_client('PLATA', rfq2, t0 + interval '5 hours')->>'status', 'in_progress');
  perform public.cancel_rfq('PLATA', r->'demands'->2->>'id', t0 + interval '5 hours');
  perform tests.eq('tout annulé : cancelled', public.rfq_for_client('PLATA', rfq2, t0 + interval '5 hours')->>'status', 'cancelled');

  -- Liste.
  r := public.rfqs_for_client('PLATA');
  perform tests.eq('liste : les deux RFQ, la plus récente d''abord', jsonb_path_query_array(r, '$[*].rfq_id'), jsonb_build_array(rfq2, rfq));
  perform tests.eq('liste : statut d''ensemble et nombre de lignes',
    (r->1->>'status') || ' ' || (r->1->>'lines_count'), 'offers_ready 3');
  perform tests.eq('liste : sans les lignes ni les offres', r->0 ? 'lines', false);
  perform tests.eq('liste : filtre statut', jsonb_path_query_array(public.rfqs_for_client('PLATA', 'cancelled'), '$[*].rfq_id'), jsonb_build_array(rfq2));
  perform tests.eq('liste : filtre customer_reference',
    jsonb_path_query_array(public.rfqs_for_client('PLATA', null, 'ADS-AGG-7'), '$[*].rfq_id'), jsonb_build_array(rfq));
  perform tests.eq('liste : filtre created_since',
    jsonb_path_query_array(public.rfqs_for_client('PLATA', null, null, t0 + interval '3 hours'), '$[*].rfq_id'), jsonb_build_array(rfq2));
  perform tests.eq('liste : vide pour une autre plateforme', public.rfqs_for_client('PLATZ'), '[]'::jsonb);
end $$;
reset role;

do $$ begin
  perform tests.eq('anon ne peut pas lire une RFQ', has_function_privilege('anon', 'public.rfq_for_client(text, text, timestamptz)', 'execute'), false);
  perform tests.eq('authenticated non plus (clé d''API obligatoire)', has_function_privilege('authenticated', 'public.rfqs_for_client(text, text, text, timestamptz)', 'execute'), false);
end $$;
drop schema tests cascade;
