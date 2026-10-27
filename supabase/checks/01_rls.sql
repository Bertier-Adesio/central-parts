-- Tests de la RLS et des règles d'intégrité, sur un PostgreSQL local (voir supabase/README.md, lancé par tools/test-db.sh).
-- Prérequis : 00_stub_supabase.sql, la migration et seed.sql appliqués. S'arrête à la première erreur.
\set ON_ERROR_STOP 1

create schema if not exists tests;
create or replace function tests.eq(label text, got anyelement, want anyelement) returns void language plpgsql as $$
begin
  if got is distinct from want then raise exception 'ÉCHEC % : obtenu %, attendu %', label, got, want; end if;
  raise notice 'ok  %', label;
end $$;
grant usage on schema tests to authenticated, anon, service_role;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000b1', 'acheteur@example.test'),
  ('00000000-0000-0000-0000-0000000000a2', 'broker@example.test'),
  ('00000000-0000-0000-0000-0000000000a3', 'oem@example.test'),
  ('00000000-0000-0000-0000-0000000000c1', 'labo@example.test'),
  ('00000000-0000-0000-0000-0000000000d1', 'banque@example.test'),
  ('00000000-0000-0000-0000-0000000000e1', 'ops1@example.test'),
  ('00000000-0000-0000-0000-0000000000e2', 'ops2@example.test');
insert into public.members (user_id, org_id) values
  ('00000000-0000-0000-0000-0000000000b1', 'B1'), ('00000000-0000-0000-0000-0000000000a2', 'S2'),
  ('00000000-0000-0000-0000-0000000000a3', 'S3'), ('00000000-0000-0000-0000-0000000000c1', 'L1'),
  ('00000000-0000-0000-0000-0000000000d1', 'BK'), ('00000000-0000-0000-0000-0000000000e1', 'CP'),
  ('00000000-0000-0000-0000-0000000000e2', 'CP');

-- Clôture de l'enchère DEM-0427 : deux offres classées.
insert into public.offers (id, demand_id, bid_id, seller_id, lot_id, net, currency, net_eur, date_code, buyer_currency, unit_price, lead_days, rank, valid_until) values
  ('OFF-0501', 'DEM-0427', 'BID-0900', 'S2', 'LOT-102', 43.25, 'USD', 39.79, '2009/2012', 'EUR', 44.56, 4, 1, now() + interval '2 days'),
  ('OFF-0502', 'DEM-0427', 'BID-0899', 'S1', 'LOT-101', 41.2, 'EUR', 41.2, '2011', 'EUR', 46.14, 5, 2, now() + interval '2 days');

-- ---------------------------------------------------------------- anon : rien
set role anon;
do $$ begin
  begin perform 1 from public.organizations; raise exception 'ÉCHEC anon lit organizations';
  exception when insufficient_privilege then raise notice 'ok  anon refusé sur organizations'; end;
  begin perform 1 from public.v_seller_status; raise exception 'ÉCHEC anon lit v_seller_status';
  exception when insufficient_privilege then raise notice 'ok  anon refusé sur les vues'; end;
end $$;
reset role;

-- ---------------------------------------------------------------- acheteur B1
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
do $$ begin
  perform tests.eq('acheteur : sa seule organisation', (select count(*) from public.organizations), 1::bigint);
  perform tests.eq('acheteur : ses demandes', (select count(*) from public.demands), 2::bigint);
  perform tests.eq('acheteur : aucune enchère', (select count(*) from public.bids), 0::bigint);
  perform tests.eq('acheteur : aucun lot brut', (select count(*) from public.lots), 0::bigint);
  perform tests.eq('acheteur : aucune offre brute', (select count(*) from public.offers), 0::bigint);
  perform tests.eq('acheteur : aucune transaction brute', (select count(*) from public.transactions), 0::bigint);
  perform tests.eq('acheteur : deux offres anonymes', (select count(*) from public.v_buyer_offers), 2::bigint);
  perform tests.eq('acheteur : alias du vendeur classé 1', (select seller_alias from public.v_buyer_offers where rank = 1), 'V-2');
  perform tests.eq('acheteur : TX-0041 visible', (select count(*) from public.v_my_transactions), 1::bigint);
  perform tests.eq('acheteur : vendeur par alias', (select seller_alias from public.v_my_transactions), 'V-3');
  perform tests.eq('acheteur : pas d''alias acheteur', (select buyer_alias from public.v_my_transactions), null::text);
  perform tests.eq('acheteur : prix net masqué', (select net from public.v_my_transactions), null::numeric);
  perform tests.eq('acheteur : total visible', (select total from public.v_my_transactions), 942.00::numeric);
  perform tests.eq('acheteur : lot sans prix vendeur', (select lot ? 'unit_price' from public.v_my_transactions), false);
  perform tests.eq('acheteur : historique', (select count(*) from public.transaction_history), 4::bigint);
  perform tests.eq('acheteur : pas de compte dédié', (select count(*) from public.funds_movements), 0::bigint);
  perform tests.eq('acheteur : pas de demande vendeur', (select count(*) from public.v_seller_demands), 0::bigint);
  perform tests.eq('acheteur : pas de journal', (select count(*) from public.events), 0::bigint);
  begin insert into public.demands (buyer_id, mpn, qty, currency, closes_at) values ('B1', 'X', 1, 'EUR', now());
    raise exception 'ÉCHEC acheteur écrit dans demands';
  exception when insufficient_privilege then raise notice 'ok  acheteur : écriture directe refusée'; end;
end $$;
reset role;

-- ---------------------------------------------------------------- vendeur S3 (partie à TX-0041)
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a3';
do $$ begin
  perform tests.eq('vendeur S3 : sa seule organisation', (select count(*) from public.organizations), 1::bigint);
  perform tests.eq('vendeur S3 : aucune demande brute', (select count(*) from public.demands), 0::bigint);
  perform tests.eq('vendeur S3 : DEM-0428 reçue', (select string_agg(id, ',') from public.v_seller_demands), 'DEM-0428');
  perform tests.eq('vendeur S3 : ses lots', (select count(*) from public.lots), 2::bigint);
  perform tests.eq('vendeur S3 : acheteur par alias', (select buyer_alias from public.v_my_transactions), 'A-7Q2');
  perform tests.eq('vendeur S3 : pas d''alias vendeur', (select seller_alias from public.v_my_transactions), null::text);
  perform tests.eq('vendeur S3 : son prix net', (select net from public.v_my_transactions), 3.4::numeric);
  perform tests.eq('vendeur S3 : total acheteur masqué', (select total from public.v_my_transactions), null::numeric);
  perform tests.eq('vendeur S3 : adresse réduite à la zone', (select delivery from public.v_my_transactions), 'France');
  perform tests.eq('vendeur S3 : offres des autres invisibles', (select count(*) from public.offers), 0::bigint);
  perform tests.eq('vendeur S3 : coordonnées bancaires propres', (select count(*) from public.org_bank_accounts), 1::bigint);
end $$;
reset role;

-- ---------------------------------------------------------------- broker S2
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
do $$ begin
  perform tests.eq('broker S2 : DEM-0427 reçue par connecteur', (select via from public.v_seller_demands where id = 'DEM-0427'), 'connector');
  perform tests.eq('broker S2 : son enchère', (select my_bid_id from public.v_seller_demands where id = 'DEM-0427'), 'BID-0900');
  perform tests.eq('broker S2 : son offre seulement', (select string_agg(id, ',') from public.offers), 'OFF-0501');
  perform tests.eq('broker S2 : son connecteur', (select count(*) from public.connectors), 1::bigint);
  perform tests.eq('broker S2 : TX-0041 invisible', (select count(*) from public.v_my_transactions), 0::bigint);
  perform tests.eq('broker S2 : statuts publics des vendeurs', (select count(*) from public.v_seller_status), 4::bigint);
end $$;
reset role;

-- ---------------------------------------------------------------- laboratoire, banque, opérateurs
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000c1';
do $$ begin
  perform tests.eq('labo : son dossier', (select count(*) from public.lab_cases), 1::bigint);
  perform tests.eq('labo : transaction sans prix', (select coalesce(net, total) from public.v_my_transactions), null::numeric);
  perform tests.eq('labo : ni vendeur ni acheteur', (select coalesce(seller_alias, buyer_alias) from public.v_my_transactions), null::text);
  perform tests.eq('labo : pas d''historique', (select count(*) from public.transaction_history), 0::bigint);
end $$;
reset role;

set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000d1';
do $$ begin
  perform tests.eq('banque : mouvements', (select count(*) from public.funds_movements), 1::bigint);
  perform tests.eq('banque : solde EUR', (select balance from public.funds_balances where currency = 'EUR'), 942.00::numeric);
  perform tests.eq('banque : pas de demandes', (select count(*) from public.demands), 0::bigint);
end $$;
reset role;

set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000e1';
do $$ begin
  perform tests.eq('ops : toutes les organisations', (select count(*) from public.organizations), 11::bigint);
  perform tests.eq('ops : toutes les transactions', (select count(*) from public.transactions), 1::bigint);
  perform tests.eq('ops : toutes les enchères', (select count(*) from public.bids), 2::bigint);
end $$;
reset role;

-- ---------------------------------------------------------------- statut « vérifié »
do $$ begin
  perform tests.eq('S1 vérifié (abonnement en cours)', app.is_verified('S1'), true);
  perform tests.eq('L1 non vendeur abonné', app.is_verified('L1'), false);
  perform tests.eq('bac à sable exempté', app.is_verified('SBX'), true);
  update public.subscriptions set until = current_date - 1, starts_on = current_date - 400 where org_id = 'S1';
  perform tests.eq('S1 non vérifié après échéance', app.is_verified('S1'), false);
  update public.organizations set kyb = 'pending' where id = 'S3';
  perform tests.eq('S3 non vérifié pendant un nouveau KYB', app.is_verified('S3'), false);
end $$;

-- ---------------------------------------------------------------- intégrité (rôle de l'API métier)
set role service_role;
do $$ begin
  begin update public.funds_movements set amount = 0; raise exception 'ÉCHEC mouvement modifié';
  exception when raise_exception then
    if sqlerrm like 'ÉCHEC%' then raise; end if; raise notice 'ok  compte dédié en ajout seul'; end;
  begin delete from public.transaction_history; raise exception 'ÉCHEC historique supprimé';
  exception when raise_exception then
    if sqlerrm like 'ÉCHEC%' then raise; end if; raise notice 'ok  historique en ajout seul'; end;

  insert into public.payment_orders (id, type, tx_id, currency, amount) values ('ORD-0071', 'release', 'TX-0041', 'EUR', 942);
  perform tests.eq('référence générée', (select id from public.payment_orders where id = 'ORD-0071'), 'ORD-0071');
  insert into public.payment_approvals (order_id, user_id) values ('ORD-0071', '00000000-0000-0000-0000-0000000000e1');
  begin update public.payment_orders set status = 'approved' where id = 'ORD-0071'; raise exception 'ÉCHEC une seule validation';
  exception when raise_exception then
    if sqlerrm like 'ÉCHEC%' then raise; end if; raise notice 'ok  une validation ne suffit pas'; end;
  insert into public.payment_approvals (order_id, user_id) values ('ORD-0071', '00000000-0000-0000-0000-0000000000b1');
  begin update public.payment_orders set status = 'approved' where id = 'ORD-0071'; raise exception 'ÉCHEC validation par un acheteur';
  exception when raise_exception then
    if sqlerrm like 'ÉCHEC%' then raise; end if; raise notice 'ok  seuls les opérateurs valident'; end;
  insert into public.payment_approvals (order_id, user_id) values ('ORD-0071', '00000000-0000-0000-0000-0000000000e2');
  update public.payment_orders set status = 'approved' where id = 'ORD-0071';
  perform tests.eq('deux opérateurs : ordre approuvé', (select status from public.payment_orders where id = 'ORD-0071'), 'approved');
  insert into public.demands (buyer_id, mpn, qty, currency, closes_at) values ('B3', 'NE555DR', 10, 'USD', now());
  perform tests.eq('référence de demande générée', (select id from public.demands where buyer_id = 'B3'), 'DEM-1000');
end $$;
reset role;

drop schema tests cascade;
select 'Tous les tests RLS sont passés.' as resultat;
