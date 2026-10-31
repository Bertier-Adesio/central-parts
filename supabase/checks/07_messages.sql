-- Tests des messages WeChat transférés aux opérateurs. Prérequis : checks précédents. Lancé par tools/test-db.sh.
\set ON_ERROR_STOP 1

create schema if not exists tests;
create or replace function tests.eq(label text, got anyelement, want anyelement) returns void language plpgsql as $$
begin
  if got is distinct from want then raise exception 'ÉCHEC % : obtenu %, attendu %', label, got, want; end if;
  raise notice 'ok  %', label;
end $$;
grant usage on schema tests to service_role, authenticated;
grant execute on all functions in schema tests to service_role, authenticated;

insert into public.wechat_identities (openid, org_id, role) values ('oMSG', 'S2', 'admin') on conflict (openid) do nothing;

set role service_role;
do $$
declare a jsonb; b jsonb;
begin
  a := public.log_wechat_message('oMSG', 'text', '你好，有现货吗？');
  perform tests.eq('message d''un contact rattaché : société et pseudonyme', (a->>'org_id') || ' ' || (a->>'alias'), 'S2 V-2');
  b := public.log_wechat_message('oINCONNU-MSG', 'image', 'https://example.com/photo.jpg');
  perform tests.eq('message d''un inconnu : sans société', b->>'org_id', null::text);
  perform tests.eq('réponse : destinataire du message', public.reply_wechat_message((a->>'id')::bigint, 'Bonjour, oui.', 'oOPS'), 'oMSG');
  perform tests.eq('réponse enregistrée', (select count(*) from public.wechat_messages where openid = 'oMSG' and direction = 'out'), 1::bigint);
  begin perform public.reply_wechat_message(999999, 'x', 'oOPS'); raise exception 'ÉCHEC réponse à un message inconnu';
  exception when no_data_found then raise notice 'ok  réponse à un message inconnu refusée'; end;
  begin perform public.reply_wechat_message((a->>'id')::bigint, '  ', 'oOPS'); raise exception 'ÉCHEC réponse vide';
  exception when invalid_parameter_value then raise notice 'ok  réponse vide refusée'; end;
end $$;
reset role;

set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
do $$ begin
  perform tests.eq('vendeur connecté : messages invisibles', (select count(*) from public.wechat_messages), 0::bigint);
  begin perform public.log_wechat_message('x', 'text', 'y'); raise exception 'ÉCHEC enregistrement par un utilisateur';
  exception when insufficient_privilege then raise notice 'ok  enregistrement réservé au serveur'; end;
end $$;
reset role;

drop schema tests cascade;
select 'Tous les tests des messages WeChat sont passés.' as resultat;
