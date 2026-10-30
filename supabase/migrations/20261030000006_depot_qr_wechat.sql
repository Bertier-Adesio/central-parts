-- Connexion au dépôt de stock par QR code WeChat (扫码登录), à la place de l'autorisation de page web :
-- le domaine d'autorisation exige une licence ICP que central.parts n'a pas (ADR 0010).
--
-- 1. La page demande une connexion : la fonction depot crée un QR code temporaire du compte de service
--    (scène aléatoire, 5 minutes) et ouvre une tentative (depot_login_start).
-- 2. Le fournisseur scanne le QR code avec WeChat ; WeChat envoie l'événement (SCAN ou subscribe) à la
--    fonction wechat-events, qui rattache son openid à la tentative (depot_login_scan) et lui répond dans WeChat.
-- 3. La page interroge la tentative (depot_login_poll) ; une fois reconnue, elle reçoit son jeton de session.

create table public.depot_logins (
  scene       text primary key,                 -- identifiant aléatoire porté par le QR code
  invite      text,                             -- jeton d'invitation éventuel, effacé à la fin de la tentative
  status      text not null default 'pending' check (status in ('pending', 'ok', 'not_bound', 'invite_invalid', 'consumed', 'expired')),
  openid      text,
  org_id      text references public.organizations on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '5 minutes',
  scanned_at  timestamptz
);

-- Jeton d'accès à l'API WeChat, partagé entre les appels (stable_token, 2 heures).
create table public.wechat_access_tokens (
  appid       text primary key,
  token       text not null,
  expires_at  timestamptz not null
);

alter table public.depot_logins enable row level security;
alter table public.wechat_access_tokens enable row level security;
revoke all on public.depot_logins, public.wechat_access_tokens from anon, authenticated;

-- Ouvre une tentative ; refuse d'emblée une invitation inconnue, expirée ou déjà utilisée par un autre compte.
create or replace function public.depot_login_start(p_scene text, p_invite text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_scene !~ '^[A-Za-z0-9_]{16,64}$' then raise exception 'Scène invalide'; end if;
  if p_invite is not null and not exists (
       select 1 from public.depot_invites i
        where i.token_hash = encode(extensions.digest(p_invite, 'sha256'), 'hex') and i.expires_at > now()) then
    raise exception 'Invitation inconnue ou expirée' using errcode = 'P0002';
  end if;
  delete from public.depot_logins where expires_at < now() - interval '1 day';
  insert into public.depot_logins (scene, invite) values (p_scene, p_invite);
end $$;

-- Événement de scan reçu de WeChat : rattache l'openid (via l'invitation s'il y en a une) et donne le résultat.
create or replace function public.depot_login_scan(p_scene text, p_openid text, p_unionid text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare l public.depot_logins; who jsonb;
begin
  select * into l from public.depot_logins where scene = p_scene for update;
  if l.scene is null then return jsonb_build_object('status', 'unknown'); end if;
  if l.status <> 'pending' then return jsonb_build_object('status', l.status); end if;
  if l.expires_at < now() then
    update public.depot_logins set status = 'expired', invite = null where scene = p_scene;
    return jsonb_build_object('status', 'expired');
  end if;
  if l.invite is not null then
    begin
      perform public.redeem_depot_invite(l.invite, p_openid, p_unionid);
    exception when no_data_found then
      update public.depot_logins set status = 'invite_invalid', openid = p_openid, invite = null, scanned_at = now() where scene = p_scene;
      return jsonb_build_object('status', 'invite_invalid');
    end;
  end if;
  who := public.depot_identity(p_openid);
  update public.depot_logins
     set status = case when who is null then 'not_bound' else 'ok' end,
         openid = p_openid, org_id = who->>'org_id', invite = null, scanned_at = now()
   where scene = p_scene;
  return jsonb_build_object('status', case when who is null then 'not_bound' else 'ok' end, 'org', who);
end $$;

-- La page interroge sa tentative : une connexion réussie n'est remise qu'une fois.
create or replace function public.depot_login_poll(p_scene text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare l public.depot_logins; who jsonb;
begin
  select * into l from public.depot_logins where scene = p_scene for update;
  if l.scene is null then return jsonb_build_object('status', 'unknown'); end if;
  if l.status = 'pending' and l.expires_at < now() then
    update public.depot_logins set status = 'expired', invite = null where scene = p_scene;
    return jsonb_build_object('status', 'expired');
  end if;
  if l.status = 'ok' then
    who := public.depot_identity(l.openid);
    update public.depot_logins set status = 'consumed' where scene = p_scene;
    if who is null then return jsonb_build_object('status', 'not_bound'); end if;
    return jsonb_build_object('status', 'ok', 'openid', l.openid, 'org', who);
  end if;
  return jsonb_build_object('status', l.status);
end $$;

revoke execute on function public.depot_login_start(text, text), public.depot_login_scan(text, text, text),
  public.depot_login_poll(text) from public, anon, authenticated;
grant execute on function public.depot_login_start(text, text), public.depot_login_scan(text, text, text),
  public.depot_login_poll(text) to service_role;
