-- Tests du rattachement WeChat pour le dépôt de stock (invitations, identités, droits).
-- Prérequis : checks précédents (comptes de test). Lancé par tools/test-db.sh.
\set ON_ERROR_STOP 1

create schema if not exists tests;
create or replace function tests.eq(label text, got anyelement, want anyelement) returns void language plpgsql as $$
begin
  if got is distinct from want then raise exception 'ÉCHEC % : obtenu %, attendu %', label, got, want; end if;
  raise notice 'ok  %', label;
end $$;
grant usage on schema tests to authenticated, anon, service_role;
create table tests.vars (k text primary key, v text);
grant all on tests.vars to service_role;

-- L'opérateur crée deux invitations (éditeur SQL).
insert into tests.vars values ('inv', public.create_depot_invite('S2', 'Contact achats')), ('inv2', public.create_depot_invite('S2'));
update public.depot_invites set expires_at = now() - interval '1 day'
 where token_hash = encode(extensions.digest((select v from tests.vars where k = 'inv2'), 'sha256'), 'hex');
do $$ begin
  perform tests.eq('invitation : jeton de 36 caractères', (select length(v) from tests.vars where k = 'inv'), 36);
  perform tests.eq('invitation : seule l''empreinte est gardée', (select count(*) from public.depot_invites where token_hash = (select v from tests.vars where k = 'inv')), 0::bigint);
  begin perform public.create_depot_invite('B1'); raise exception 'ÉCHEC invitation pour un acheteur';
  exception when raise_exception then
    if sqlerrm like 'ÉCHEC%' then raise; end if; raise notice 'ok  invitation réservée aux vendeurs'; end;
end $$;

-- La fonction Edge (service_role) rattache l'openid renvoyé par WeChat.
set role service_role;
do $$
declare inv text := (select v from tests.vars where k = 'inv');
begin
  perform tests.eq('openid inconnu : pas de société', public.depot_identity('oFOURNISSEUR'), null::jsonb);
  perform tests.eq('invitation utilisée : société S2', public.redeem_depot_invite(inv, 'oFOURNISSEUR', 'uFOURNISSEUR'), 'S2');
  perform tests.eq('connexion suivante : société et pseudonyme', public.depot_identity('oFOURNISSEUR') - 'name' - 'lang', '{"org_id": "S2", "alias": "V-2"}'::jsonb);
  perform tests.eq('même openid peut réutiliser son lien', public.redeem_depot_invite(inv, 'oFOURNISSEUR'), 'S2');
  begin perform public.redeem_depot_invite(inv, 'oAUTRE'); raise exception 'ÉCHEC invitation réutilisée par un autre';
  exception when no_data_found then raise notice 'ok  invitation à usage unique'; end;
  begin perform public.redeem_depot_invite((select v from tests.vars where k = 'inv2'), 'oAUTRE'); raise exception 'ÉCHEC invitation expirée acceptée';
  exception when no_data_found then raise notice 'ok  invitation expirée refusée'; end;
  begin perform public.redeem_depot_invite('faux', 'oAUTRE'); raise exception 'ÉCHEC jeton inventé accepté';
  exception when no_data_found then raise notice 'ok  jeton inventé refusé'; end;
  perform tests.eq('connexion notée', (select last_login_at is not null from public.wechat_identities where openid = 'oFOURNISSEUR'), true);
end $$;
reset role;

-- Droits : ni un acheteur, ni un vendeur connecté ne peuvent rattacher un compte ou lire les invitations.
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
do $$ begin
  begin perform public.redeem_depot_invite('x', 'y'); raise exception 'ÉCHEC acheteur rattache un compte';
  exception when insufficient_privilege then raise notice 'ok  acheteur : rattachement refusé'; end;
  begin perform public.create_depot_invite('S2'); raise exception 'ÉCHEC acheteur crée une invitation';
  exception when insufficient_privilege then raise notice 'ok  acheteur : invitation refusée'; end;
  perform tests.eq('acheteur : aucune identité visible', (select count(*) from public.wechat_identities), 0::bigint);
end $$;
reset role;
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
do $$ begin
  perform tests.eq('vendeur S2 : son compte WeChat rattaché visible', (select count(*) from public.wechat_identities), 1::bigint);
  perform tests.eq('vendeur S2 : invitations invisibles', (select count(*) from public.depot_invites), 0::bigint);
end $$;
reset role;

-- Révocation par l'opérateur : la connexion ne donne plus de société.
update public.wechat_identities set revoked_at = now() where openid = 'oFOURNISSEUR';
set role service_role;
do $$ begin
  perform tests.eq('compte révoqué : plus de société', public.depot_identity('oFOURNISSEUR'), null::jsonb);
end $$;
reset role;

-- ---------------------------------------------------------------- connexion par QR code (扫码登录)
update public.wechat_identities set revoked_at = null where openid = 'oFOURNISSEUR';
insert into tests.vars values ('inv3', public.create_depot_invite('S3', 'Contact quotidien'));
set role service_role;
do $$
declare inv3 text := (select v from tests.vars where k = 'inv3');
begin
  -- Fournisseur déjà rattaché : scan, puis la page récupère sa session une seule fois.
  perform public.depot_login_start('dl_00000000000000000000000000000001');
  perform tests.eq('tentative en attente', public.depot_login_poll('dl_00000000000000000000000000000001')->>'status', 'pending');
  perform tests.eq('scan reconnu', public.depot_login_scan('dl_00000000000000000000000000000001', 'oFOURNISSEUR')->>'status', 'ok');
  perform tests.eq('second scan sans effet', public.depot_login_scan('dl_00000000000000000000000000000001', 'oAUTRE')->>'status', 'ok');
  perform tests.eq('page : connexion remise avec la société', public.depot_login_poll('dl_00000000000000000000000000000001')->'org'->>'org_id', 'S2');
  perform tests.eq('connexion remise une seule fois', public.depot_login_poll('dl_00000000000000000000000000000001')->>'status', 'consumed');
  -- Compte inconnu sans invitation.
  perform public.depot_login_start('dl_00000000000000000000000000000002');
  perform tests.eq('compte non rattaché', public.depot_login_scan('dl_00000000000000000000000000000002', 'oINCONNU')->>'status', 'not_bound');
  perform tests.eq('page : non rattaché', public.depot_login_poll('dl_00000000000000000000000000000002')->>'status', 'not_bound');
  -- Nouveau contact avec invitation : rattaché à sa société au scan.
  perform public.depot_login_start('dl_00000000000000000000000000000003', inv3);
  perform tests.eq('invitation au scan : rattachement', public.depot_login_scan('dl_00000000000000000000000000000003', 'oCONTACT')->>'status', 'ok');
  perform tests.eq('nouveau contact rattaché à S3', (select org_id from public.wechat_identities where openid = 'oCONTACT'), 'S3');
  perform tests.eq('invitation effacée de la tentative', (select invite from public.depot_logins where scene = 'dl_00000000000000000000000000000003'), null::text);
  -- Invitation déjà utilisée : refusée dès l'ouverture si inconnue ; refusée au scan si déjà prise par un autre.
  begin perform public.depot_login_start('dl_00000000000000000000000000000004', 'faux'); raise exception 'ÉCHEC invitation inventée acceptée';
  exception when no_data_found then raise notice 'ok  invitation inventée refusée à l''ouverture'; end;
  perform public.depot_login_start('dl_00000000000000000000000000000005', inv3);
  perform tests.eq('invitation prise par un autre : refusée au scan', public.depot_login_scan('dl_00000000000000000000000000000005', 'oINTRUS')->>'status', 'invite_invalid');
  -- QR code expiré.
  perform public.depot_login_start('dl_00000000000000000000000000000006');
  update public.depot_logins set expires_at = now() - interval '1 second' where scene = 'dl_00000000000000000000000000000006';
  perform tests.eq('QR code expiré au scan', public.depot_login_scan('dl_00000000000000000000000000000006', 'oFOURNISSEUR')->>'status', 'expired');
  begin perform public.depot_login_start('court'); raise exception 'ÉCHEC scène invalide acceptée';
  exception when raise_exception then
    if sqlerrm like 'ÉCHEC%' then raise; end if; raise notice 'ok  scène invalide refusée'; end;
end $$;
reset role;
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
do $$ begin
  begin perform public.depot_login_poll('dl_00000000000000000000000000000001'); raise exception 'ÉCHEC vendeur interroge une tentative';
  exception when insufficient_privilege then raise notice 'ok  tentatives réservées au serveur'; end;
  begin perform 1 from public.wechat_access_tokens; raise exception 'ÉCHEC jetons WeChat lisibles';
  exception when insufficient_privilege then raise notice 'ok  jetons WeChat inaccessibles'; end;
end $$;
reset role;

drop schema tests cascade;
select 'Tous les tests du dépôt WeChat sont passés.' as resultat;
