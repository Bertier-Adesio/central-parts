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

drop schema tests cascade;
select 'Tous les tests du dépôt WeChat sont passés.' as resultat;
