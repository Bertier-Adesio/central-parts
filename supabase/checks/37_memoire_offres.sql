-- Tests de la mémoire des offres (migration 20261110000043) : historique des changements, expiration gardée en mémoire,
-- âge et état de chaque offre, remise en ligne par un administrateur (motif, hors note), validité par vendeur, tableau
-- de bord, fiche vendeur. Vendeurs et offres fictifs. Lancé par tools/test-db.sh.
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

insert into public.organizations (id, type, name, alias, city, country, currency, lang, profile, kyb, sandbox) values
  ('MO1', 'seller', 'Distributeur expiré (fictif)', 'V-971', 'Shenzhen', 'CN', 'USD', 'zh', 'Distributor', 'validated', false),
  ('MO2', 'seller', 'Distributeur à jour (fictif)', 'V-972', 'Shenzhen', 'CN', 'USD', 'zh', 'Distributor', 'validated', false);
insert into public.stock_imports (id, org_id, storage_path, file_name, status, received_at, processed_at)
values ('IMP-MO1', 'MO1', 'MO1/stock-fictif.xlsx', 'stock-fictif.xlsx', 'done', now() - interval '10 days', now() - interval '10 days');
-- MO1 : trois offres importées il y a 10 jours (validité de 7 jours : expirées depuis 3 jours). MO2 : une offre du jour.
insert into public.lots (id, seller_id, mpn, manufacturer, qty, unit_price, currency, import_id, confirmed_at, created_at) values
  ('LOT-MO1A', 'MO1', 'MEMTEST-A', 'Fabricant fictif', 1000, 0.50, 'USD', 'IMP-MO1', now() - interval '10 days', now() - interval '10 days'),
  ('LOT-MO1B', 'MO1', 'MEMTEST-B', 'Fabricant fictif', 2000, 0.30, 'USD', 'IMP-MO1', now() - interval '10 days', now() - interval '10 days'),
  ('LOT-MO1C', 'MO1', 'MEMTEST-C', 'Fabricant fictif', 300, 1.20, 'USD', 'IMP-MO1', now() - interval '10 days', now() - interval '10 days'),
  ('LOT-MO2A', 'MO2', 'MEMTEST-D', 'Fabricant fictif', 50, 2.00, 'USD', null, now() - interval '1 day', now() - interval '1 day');

-- Back office : âge et état des offres, filtre, validité, tableau de bord, avant la remise en ligne.
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
do $$ begin
  perform tests.fails('non-administrateur : validité refusée', $s$select public.admin_offer_validity()$s$, '42501');
  perform tests.fails('non-administrateur : remise en ligne refusée', $s$select public.admin_reconfirm('MO1', 'x')$s$, '42501');
  perform tests.fails('non-administrateur : tableau de bord refusé', $s$select public.admin_dashboard()$s$, '42501');
  perform tests.fails('non-administrateur : historique refusé', $s$select public.admin_lot_history('LOT-MO1A')$s$, '42501');
end $$;
reset role;
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000e1';
do $$
declare l jsonb; v jsonb; d jsonb; a jsonb;
begin
  l := public.admin_lots('MO1', '', 50, 0, null);
  a := l->'rows'->0->'age';
  perform tests.eq('âge : import du fichier, état expiré, échéance passée',
    (a->>'state') || ' ' || (a->>'import_file') || ' ' || ((a->>'imported_at')::timestamptz < now() - interval '9 days')::text
    || ' ' || ((a->>'expires_at')::timestamptz < now())::text, 'expired stock-fictif.xlsx true true');
  perform tests.eq('filtre « expirées » : 3 offres de MO1', (public.admin_lots('MO1', '', 50, 0, 'expired')->>'total')::int, 3);
  perform tests.eq('filtre « en ligne » : 0 pour MO1, 1 pour MO2',
    (public.admin_lots('MO1', '', 50, 0, 'live')->>'total') || ' ' || (public.admin_lots('MO2', '', 50, 0, 'live')->>'total'), '0 1');
  perform tests.eq('offre sans import : âge = date de création', (public.admin_lots('MO2', '', 50, 0, null)->'rows'->0->'age'->>'state'), 'live');
  v := (select x from jsonb_array_elements(public.admin_offer_validity()) x where x->>'org_id' = 'MO1');
  perform tests.eq('validité : 0 en ligne, 3 expirées, 7 jours, dernier import', (v#>>'{validity,live}') || ' ' || (v#>>'{validity,expired}') || ' '
    || (v#>>'{validity,ttl_days}') || ' ' || (v#>>'{validity,last_import,file}'), '0 3 7 stock-fictif.xlsx');
  perform tests.eq('validité : vendeurs entièrement expirés en tête',
    (select x->>'org_id' from jsonb_array_elements(public.admin_offer_validity()) x where (x#>>'{validity,expired}')::int > 0 limit 1) is not null, true);
  d := public.admin_dashboard();
  perform tests.eq('tableau de bord : MO1 parmi les vendeurs expirés, compteurs présents',
    (select count(*) from jsonb_array_elements(d->'sellers_expired') x where x->>'org_id' = 'MO1' and (x->>'lots')::int = 3)::text || ' '
    || (d ?& array['suppliers_pending', 'requests_pending', 'rfq_pending', 'sourcing_open', 'offers_live', 'offers_expired', 'sellers_expiring', 'notify_failed'])::text,
    '1 true');
  a := public.admin_reminder_targets('MO1');
  perform tests.eq('relance : offres expirées, 3 offres', (a->>'kind') || ' ' || (a->>'lots'), 'expired 3');

  -- Remise en ligne par l'administrateur : motif obligatoire.
  perform tests.fails('remise en ligne sans motif refusée', $s$select public.admin_reconfirm('MO1', '  ')$s$, 'CP005');
  a := public.admin_reconfirm('mo1', 'Salon electronica : stock confirmé par téléphone (fictif)');
  perform tests.eq('remise en ligne : 3 offres, 7 jours', (a->>'lots') || ' ' || (a->>'ttl_days') || ' ' || (a->>'org_id'), '3 7 MO1');
end $$;
reset role;

set role service_role;
do $$
declare h record; s jsonb;
begin
  -- Mémoire de l'expiration : une ligne « renewed » par offre, avec la date d'expiration et le canal.
  perform tests.eq('historique : 3 remises en ligne, canal admin, expiration gardée',
    (select count(*) || ' ' || min(via) || ' ' || bool_and(expired_at < now() - interval '2 days')::text from public.lot_history where seller_id = 'MO1' and event = 'renewed'),
    '3 admin true');
  perform tests.eq('reconfirmation : motif et canal journalisés',
    (select channel || ' ' || reason from public.stock_reconfirmations where org_id = 'MO1' order by at desc limit 1),
    'admin Salon electronica : stock confirmé par téléphone (fictif)');
  perform tests.eq('remise en ligne par l''administrateur : hors fréquence de mise à jour (seul l''import compte)',
    (public.seller_updates('MO1')->>'days_30')::int, 1);
  -- Reconfirmation d'offres encore en ligne : rien n'est écrit (volume).
  perform public.seller_reconfirm('MO1', 'oMO1', 'depot');
  perform tests.eq('reconfirmation d''offres en ligne : aucune ligne d''historique', (select count(*) from public.lot_history where seller_id = 'MO1')::int, 3);
  -- Changement de prix, retrait par un fichier complet, suppression.
  update public.lots set unit_price = 0.45 where id = 'LOT-MO1A';
  select * into h from public.lot_history where lot_id = 'LOT-MO1A' and event = 'changed';
  perform tests.eq('changement de prix : ancien et nouveau prix, date d''import, canal fichier',
    h.unit_price || ' ' || h.new_unit_price || ' ' || h.via || ' ' || (h.imported_at < now() - interval '9 days')::text, '0.500000 0.450000 file true');
  update public.lots set qty = 0 where id = 'LOT-MO1B';
  perform tests.eq('retrait : quantité gardée', (select qty || ' → ' || new_qty from public.lot_history where lot_id = 'LOT-MO1B' and event = 'withdrawn'), '2000 → 0');
  delete from public.lots where id = 'LOT-MO1C';
  perform tests.eq('suppression : l''historique reste', (select count(*) from public.lot_history where lot_id = 'LOT-MO1C')::int, 2);
  perform tests.fails('historique en ajout seul', $s$update public.lot_history set qty = 1 where lot_id = 'LOT-MO1A'$s$, 'P0001');
end $$;
reset role;

set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000e1';
do $$
declare h jsonb := public.admin_lot_history('lot-mo1a'); s jsonb := public.admin_supplier('MO1'); v jsonb;
begin
  perform tests.eq('historique d''une offre : le plus récent d''abord', (h->0->>'event') || ' ' || (h->1->>'event'), 'changed renewed');
  perform tests.eq('filtre « retirées »', (public.admin_lots('MO1', '', 50, 0, 'withdrawn')->>'total')::int, 1);
  perform tests.eq('fiche : validité, dernière remise en ligne et son motif', (s#>>'{validity,live}') || ' ' || (s#>>'{validity,last_lapse,via}') || ' '
    || (s#>>'{validity,lapses_90}') || ' ' || (s->'reconfirmations'->1->>'reason'), '1 admin 1 Salon electronica : stock confirmé par téléphone (fictif)');
  perform tests.eq('fiche : marge, note et inscription présentes', (s ?& array['margin', 'score', 'volunteer'])::text || ' ' || (s#>>'{margin,category}'), 'true distributor');
end $$;
reset role;

-- Nettoyage (l'historique est en ajout seul : on le vide en désactivant le déclencheur).
alter table public.lot_history disable trigger lot_history_append_only;
delete from public.lot_history where seller_id like 'MO%';
alter table public.lot_history enable trigger lot_history_append_only;
delete from public.stock_reconfirmations where org_id like 'MO%';
delete from public.lots where seller_id like 'MO%';
delete from public.stock_imports where org_id like 'MO%';
delete from public.organizations where id like 'MO%';
drop schema tests cascade;
select 'Tous les tests de la mémoire des offres sont passés.' as resultat;
