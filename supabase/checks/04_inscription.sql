-- Tests de l'inscription des fournisseurs, de la validation par l'opérateur et des invitations par l'administrateur (ADR 0012).
-- Prérequis : checks précédents. Lancé par tools/test-db.sh.
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
grant usage on schema tests to authenticated, anon, service_role;
grant execute on all functions in schema tests to service_role, authenticated;
create table tests.vars (k text primary key, v text);
grant all on tests.vars to service_role;

-- 统一社会信用代码 : exemple de la norme GB 32100-2015, clé fausse, longueur et caractères interdits.
do $$ begin
  perform tests.eq('numéro : exemple de la norme accepté', app.credit_code_ok('91350100M000100Y43'), true);
  perform tests.eq('numéro : minuscules acceptées', app.credit_code_ok('91350100m000100y43'), true);
  perform tests.eq('numéro : clé fausse refusée', app.credit_code_ok('91350100M000100Y44'), false);
  perform tests.eq('numéro : longueur et lettres I, O, S, V, Z refusées', app.credit_code_ok('91350100M000100Y4') or app.credit_code_ok('91350100M00010OY43'), false);
end $$;

set role service_role;
do $$
declare who jsonb; v_link text;
begin
  -- Lien personnel envoyé dans WeChat à un compte sans société : la page reçoit une connexion « à inscrire ».
  v_link := public.depot_login_link('oNOUVEAU');
  perform tests.eq('lien d''accueil : compte sans société → inscription', public.depot_login_poll(v_link)->>'status', 'register');
  perform tests.eq('lien d''accueil : remis une seule fois', public.depot_login_poll(v_link)->>'status', 'consumed');

  -- Inscription.
  perform tests.fails('inscription : numéro invalide', $s$select public.register_supplier('oNOUVEAU', 'Société A', '91350100M000100Y44', 'Shenzhen', 'Broker')$s$, 'CP001');
  perform tests.fails('inscription : profil inconnu', $s$select public.register_supplier('oNOUVEAU', 'Société A', '91350100M000100Y43', 'Shenzhen', 'Autre')$s$, 'CP004');
  who := public.register_supplier('oNOUVEAU', ' Société A ', '91350100m000100y43', 'Shenzhen', 'Manufacturer', 'cnh');
  insert into tests.vars values ('org', who->>'org_id');
  perform tests.eq('inscription : en attente, administrateur, sans licence',
    who - 'org_id' - 'alias' - 'lang' - 'rejected_reason', '{"name": "Société A", "status": "pending", "role": "admin", "has_license": false}'::jsonb);
  perform tests.eq('inscription : société chinoise, devise CNH, numéro en majuscules',
    (select country || ' ' || currency || ' ' || registration_number from public.organizations where id = who->>'org_id'), 'CN CNH 91350100M000100Y43');
  perform tests.eq('inscription : pas vérifiée, donc rien de publié', app.is_verified(who->>'org_id'), false);
  perform tests.fails('inscription : même compte une seconde fois', $s$select public.register_supplier('oNOUVEAU', 'Société B', '91310000MA1FL1MMXL', 'Shanghai', 'Broker')$s$, 'CP003');
  perform tests.fails('inscription : société déjà enregistrée par un autre', $s$select public.register_supplier('oAUTRE2', 'Copie', '91350100M000100Y43', 'Shenzhen', 'Broker')$s$, 'CP002');

  -- Licence, puis liste des sociétés en attente pour l'opérateur.
  perform tests.fails('licence : hors du dossier de la société', format($s$select public.set_supplier_license(%L, 'S2/licence.jpg')$s$, who->>'org_id'), 'P0001');
  perform public.set_supplier_license(who->>'org_id', (who->>'org_id') || '/licence-1.jpg');
  perform tests.eq('licence enregistrée', public.depot_identity('oNOUVEAU')->>'has_license', 'true');
  perform tests.eq('opérateur : société en attente listée', (select count(*) from jsonb_array_elements(public.pending_suppliers()) e where e->>'org_id' = who->>'org_id'), 1::bigint);
  perform tests.eq('opérateur : administrateur à prévenir', (select array_agg(a) from public.org_admins(who->>'org_id') a), array['oNOUVEAU']);
end $$;
reset role;

-- Invitation d'un collègue par l'administrateur ; un membre ne peut pas inviter.
set role service_role;
do $$
declare v_org text := (select v from tests.vars where k = 'org'); v_inv text; v_link text;
begin
  v_inv := public.create_member_invite('oNOUVEAU', 'Collègue');
  perform public.redeem_depot_invite(v_inv, 'oCOLLEGUE');
  perform tests.eq('collègue rattaché comme membre', public.depot_identity('oCOLLEGUE')->>'role', 'member');
  perform tests.fails('membre : invitation refusée', $s$select public.create_member_invite('oCOLLEGUE', 'x')$s$, '42501');
  perform tests.fails('membre : liste des contacts refusée', $s$select public.org_contacts('oCOLLEGUE')$s$, '42501');
  perform tests.eq('administrateur : deux contacts', jsonb_array_length(public.org_contacts('oNOUVEAU')->'members'), 2);
  -- Lien d'accueil d'un compte rattaché : connexion directe.
  v_link := public.depot_login_link('oCOLLEGUE');
  perform tests.eq('lien d''accueil : compte rattaché → connecté', public.depot_login_poll(v_link)->'org'->>'org_id', v_org);
end $$;
reset role;

-- Société créée par l'opérateur : le premier contact invité en devient l'administrateur, le suivant est membre.
insert into public.organizations (type, name, alias, city, country, currency, lang, profile, kyb)
values ('seller', 'Société de l''opérateur (fictif)', 'V-OPS-TEST', 'Shenzhen', 'CN', 'USD', 'zh', 'Broker', 'validated');
set role service_role;
do $$
declare v_org text := (select id from public.organizations where alias = 'V-OPS-TEST');
begin
  perform public.redeem_depot_invite(public.create_depot_invite(v_org, 'Premier'), 'oPREMIER');
  perform public.redeem_depot_invite(public.create_depot_invite(v_org, 'Second'), 'oSECOND');
  perform tests.eq('société de l''opérateur : premier contact administrateur, second membre',
    (public.depot_identity('oPREMIER')->>'role') || ' ' || (public.depot_identity('oSECOND')->>'role'), 'admin member');
end $$;
reset role;

-- Validation et refus par l'opérateur.
set role service_role;
do $$
declare v_org text := (select v from tests.vars where k = 'org'); v_alias text; v_max int; who jsonb;
begin
  v_max := (select max(substring(alias from '^V-(\d+)$')::int) from public.organizations);
  v_alias := public.approve_supplier(v_org, 'test');
  perform tests.eq('validation : pseudonyme V-n suivant', v_alias, 'V-' || (v_max + 1));
  perform tests.eq('validation : vérifiée, donc publiable', app.is_verified(v_org), true);
  perform tests.eq('validation : deux fois, même pseudonyme', public.approve_supplier(v_org), v_alias);
  perform tests.fails('refus d''une société validée', format($s$select public.reject_supplier(%L, 'x')$s$, v_org), 'P0002');
  who := public.register_supplier('oREFUS', 'Société R', '91310000MA1FL1MMXL', 'Shanghai', 'Broker');
  perform public.reject_supplier(who->>'org_id', '营业执照不清晰', 'test');
  perform tests.eq('refus : statut et motif visibles du fournisseur',
    public.depot_identity('oREFUS')->>'status' || ' ' || (public.depot_identity('oREFUS')->>'rejected_reason'), 'rejected 营业执照不清晰');
end $$;
reset role;

-- Droits : rien de tout cela n'est accessible à un utilisateur connecté.
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
do $$ begin
  begin perform public.register_supplier('x', 'y', '91350100M000100Y43', 'z', 'Broker'); raise exception 'ÉCHEC inscription par un utilisateur';
  exception when insufficient_privilege then raise notice 'ok  inscription réservée au serveur'; end;
  begin perform public.approve_supplier('S2'); raise exception 'ÉCHEC validation par un utilisateur';
  exception when insufficient_privilege then raise notice 'ok  validation réservée au serveur'; end;
  begin perform 1 from public.operators; raise exception 'ÉCHEC opérateurs lisibles';
  exception when insufficient_privilege then raise notice 'ok  liste des opérateurs inaccessible'; end;
end $$;
reset role;

drop schema tests cascade;
select 'Tous les tests de l''inscription sont passés.' as resultat;
