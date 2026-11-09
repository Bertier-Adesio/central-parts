-- Tests de la fréquence de mise à jour dans la note du fournisseur (migration 20261109000041, ADR 0023).
-- Vendeur fictif, dates fixes (p_now) : un jour compte une fois, à l'heure de Pékin ; fichiers en échec, dépôts
-- d'opérateur, reconfirmations par l'administrateur ou sans stock ne comptent pas. Lancé par tools/test-db.sh.
\set ON_ERROR_STOP 1

create schema if not exists tests;
create or replace function tests.eq(label text, got anyelement, want anyelement) returns void language plpgsql as $$
begin
  if got is distinct from want then raise exception 'ÉCHEC % : obtenu %, attendu %', label, got, want; end if;
  raise notice 'ok  %', label;
end $$;
grant usage on schema tests to service_role, authenticated, anon;
grant execute on all functions in schema tests to service_role, authenticated, anon;

insert into public.organizations (id, type, name, alias, currency, lang, profile, kyb)
values ('ORG-MAJ1', 'seller', 'Vendeur fréquence (fictif)', 'V-MAJ1', 'USD', 'zh', 'Broker', 'validated');

-- Fichiers : deux le même jour de Pékin (3 novembre, 09:00 et 23:30 heure de Pékin), un le 5, un en échec le 6,
-- un déposé par un opérateur le 7.
insert into public.stock_imports (org_id, storage_path, file_name, status, processed_at) values
  ('ORG-MAJ1', 'ORG-MAJ1/a.xlsx', 'a.xlsx', 'done',   '2026-11-03 01:00+00'),
  ('ORG-MAJ1', 'ORG-MAJ1/b.xlsx', 'b.xlsx', 'done',   '2026-11-03 15:30+00'),
  ('ORG-MAJ1', 'ORG-MAJ1/c.xlsx', 'c.xlsx', 'done',   '2026-11-05 02:00+00'),
  ('ORG-MAJ1', 'ORG-MAJ1/d.xlsx', 'd.xlsx', 'failed', '2026-11-06 02:00+00'),
  ('ORG-MAJ1', 'ORG-MAJ1/e.xlsx', 'e.xlsx', 'done',   '2026-11-07 02:00+00');
insert into public.operator_uploads (storage_path, org_id, by_who) values ('ORG-MAJ1/e.xlsx', 'ORG-MAJ1', 'operator');

-- Reconfirmations : le 5 (même jour qu'un fichier), le 8 par WeChat, le 9 par l'administrateur, le 10 sans stock,
-- et le 31 octobre (mois précédent, dans les 30 derniers jours).
insert into public.stock_reconfirmations (org_id, by_who, channel, lots, at) values
  ('ORG-MAJ1', 'oX', 'depot',  10, '2026-11-05 08:00+00'),
  ('ORG-MAJ1', 'oX', 'wechat', 10, '2026-11-08 03:00+00'),
  ('ORG-MAJ1', 'operator', 'admin', 10, '2026-11-09 03:00+00'),
  ('ORG-MAJ1', 'link', 'lien',  0, '2026-11-10 03:00+00'),
  ('ORG-MAJ1', 'link', 'lien', 10, '2026-10-31 03:00+00');

set role service_role;
do $$
declare u jsonb := public.seller_updates('ORG-MAJ1', '2026-11-12 12:00+00');
begin
  -- Novembre : 3, 5 et 8 (le 6 en échec, le 7 opérateur, le 9 administrateur, le 10 sans stock ne comptent pas).
  perform tests.eq('mises à jour : jours du mois, un par jour au plus', (u->>'month_days')::int, 3);
  perform tests.eq('mises à jour : 30 derniers jours, mois précédent compris', (u->>'days_30')::int, 4);
  perform tests.eq('mises à jour : dernière mise à jour du vendeur lui-même', (u->>'last_update_at')::timestamptz, '2026-11-08 03:00+00'::timestamptz);
  -- Changement de mois à Pékin : 16:30 UTC le 31 octobre = 1er novembre 00:30 à Pékin.
  perform tests.eq('mises à jour : mois de Pékin', (public.seller_updates('ORG-MAJ1', '2026-10-31 16:30+00')->>'month_days')::int, 0);
  perform tests.eq('état des offres : bloc « updates »', (public.seller_offer_status('ORG-MAJ1')->'updates') ? 'month_days', true);
  perform tests.eq('note du fournisseur : bloc « updates »', (public.supplier_score('ORG-MAJ1')->'updates') ? 'days_30', true);
end $$;
reset role;

-- Ni le public ni un compte connecté ne lisent la fonction directement.
do $$
begin
  -- 15:30 UTC le 3 novembre = 23:30 à Pékin : même jour que 01:00 UTC (fonction interne, lue en propriétaire).
  perform tests.eq('mises à jour : jour de Pékin', (select count(*)::int from app.seller_update_days('ORG-MAJ1', '2026-11-03 00:00+08')
                                                     where day = '2026-11-03'), 1);
  perform tests.eq('seller_updates : réservé au service', has_function_privilege('anon', 'public.seller_updates(text, timestamptz)', 'execute'), false);
  perform tests.eq('seller_updates : réservé au service (authenticated)', has_function_privilege('authenticated', 'public.seller_updates(text, timestamptz)', 'execute'), false);
  perform tests.eq('operator_uploads : RLS active', (select relrowsecurity from pg_class where oid = 'public.operator_uploads'::regclass), true);
end $$;

delete from public.stock_reconfirmations where org_id = 'ORG-MAJ1';
delete from public.operator_uploads where org_id = 'ORG-MAJ1';
delete from public.stock_imports where org_id = 'ORG-MAJ1';
delete from public.organizations where id = 'ORG-MAJ1';
