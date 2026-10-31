-- Messages écrits au compte de service WeChat (ADR 0010, 0012). Depuis l'activation du 消息推送, la console WeChat
-- ne les garde plus : la fonction wechat-events les enregistre ici et les transfère aux opérateurs, qui répondent
-- avec la commande « reply <n°> texte ». Seuls les messages des contacts (pas les commandes des opérateurs) sont gardés.

create table public.wechat_messages (
  id          bigint generated always as identity primary key,
  openid      text not null,
  org_id      text references public.organizations on delete set null,
  direction   text not null check (direction in ('in', 'out')),
  kind        text not null default 'text' check (kind in ('text', 'image', 'voice', 'other')),
  content     text not null,
  created_at  timestamptz not null default now(),
  sent_by     text                                  -- openid de l'opérateur, pour une réponse
);
create index on public.wechat_messages (openid, created_at desc);
alter table public.wechat_messages enable row level security;
revoke all on public.wechat_messages from anon, authenticated;
create policy ops on public.wechat_messages for select to authenticated using (app.is_ops());
grant select on public.wechat_messages to authenticated;

-- Message reçu d'un contact : enregistré, avec la société s'il est rattaché. Renvoie le n° et la société.
create or replace function public.log_wechat_message(p_openid text, p_kind text, p_content text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id bigint; o record;
begin
  select w.org_id, g.name, g.alias into o
    from public.wechat_identities w join public.organizations g on g.id = w.org_id
   where w.openid = p_openid and w.revoked_at is null;
  insert into public.wechat_messages (openid, org_id, direction, kind, content)
  values (p_openid, o.org_id, 'in', case when p_kind in ('text', 'image', 'voice') then p_kind else 'other' end,
          left(coalesce(p_content, ''), 2000))
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'org_id', o.org_id, 'name', o.name, 'alias', o.alias);
end $$;

-- Réponse d'un opérateur au message n° p_id : renvoie l'openid du destinataire et enregistre la réponse.
create or replace function public.reply_wechat_message(p_id bigint, p_content text, p_by text)
returns text language plpgsql security definer set search_path = '' as $$
declare m public.wechat_messages;
begin
  select * into m from public.wechat_messages where id = p_id and direction = 'in';
  if m.id is null then raise exception 'Message inconnu : %', p_id using errcode = 'P0002'; end if;
  if coalesce(btrim(p_content), '') = '' then raise exception 'Réponse vide' using errcode = '22023'; end if;
  insert into public.wechat_messages (openid, org_id, direction, kind, content, sent_by)
  values (m.openid, m.org_id, 'out', 'text', left(btrim(p_content), 2000), p_by);
  return m.openid;
end $$;

revoke execute on function public.log_wechat_message(text, text, text), public.reply_wechat_message(bigint, text, text)
  from public, anon, authenticated;
grant execute on function public.log_wechat_message(text, text, text), public.reply_wechat_message(bigint, text, text)
  to service_role;
