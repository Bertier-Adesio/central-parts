-- Connexion des fournisseurs par WeChat pour déposer leurs fichiers de stock (ADR 0010).
--
-- 1. L'opérateur crée une invitation pour la société : select public.create_depot_invite('ORG-0100');
--    et envoie le lien https://central.parts/depot/?invite=<jeton> au fournisseur, sur WeChat.
-- 2. Le fournisseur ouvre le lien dans WeChat ; l'autorisation de page web du compte de service renvoie son openid.
--    La fonction Edge depot rattache cet openid à la société (redeem_depot_invite) ; ensuite, il se connecte sans lien.
-- 3. À chaque connexion, depot_identity(openid) donne la société ; la fonction délivre un lien de dépôt signé
--    vers le seul dossier de la société (compartiment stock-imports).

create table public.wechat_identities (
  openid      text primary key,
  unionid     text,
  org_id      text not null references public.organizations on delete cascade,
  label       text,                                   -- par exemple le prénom du contact, pour l'opérateur
  bound_at    timestamptz not null default now(),
  last_login_at timestamptz,
  revoked_at  timestamptz
);
create index on public.wechat_identities (org_id);

-- Invitations : seule l'empreinte du jeton est gardée ; usage unique, 14 jours.
create table public.depot_invites (
  token_hash  text primary key,
  org_id      text not null references public.organizations on delete cascade,
  label       text,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '14 days',
  used_at     timestamptz,
  used_by     text                                    -- openid qui a utilisé l'invitation
);

alter table public.wechat_identities enable row level security;
alter table public.depot_invites enable row level security;
revoke all on public.wechat_identities, public.depot_invites from anon;
revoke insert, update, delete, truncate on public.wechat_identities, public.depot_invites from authenticated;
create policy own_or_ops on public.wechat_identities for select to authenticated using (org_id = app.my_org() or app.is_ops());
create policy ops on public.depot_invites for select to authenticated using (app.is_ops());

-- Crée une invitation (éditeur SQL ou console opérateur) ; renvoie le jeton à mettre dans le lien, affiché une seule fois.
create or replace function public.create_depot_invite(p_org text, p_label text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare v_token text := encode(extensions.gen_random_bytes(18), 'hex');
begin
  if not exists (select 1 from public.organizations o where o.id = p_org and o.type = 'seller') then
    raise exception 'Vendeur inconnu : %', p_org;
  end if;
  insert into public.depot_invites (token_hash, org_id, label)
  values (encode(extensions.digest(v_token, 'sha256'), 'hex'), p_org, p_label);
  return v_token;
end $$;

-- Utilise une invitation : rattache l'openid à la société. Renvoie l'identifiant de la société.
create or replace function public.redeem_depot_invite(p_token text, p_openid text, p_unionid text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare inv public.depot_invites;
begin
  select * into inv from public.depot_invites
   where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex') for update;
  if inv.token_hash is null then raise exception 'Invitation inconnue' using errcode = 'P0002'; end if;
  if inv.used_at is not null and inv.used_by is distinct from p_openid then raise exception 'Invitation déjà utilisée' using errcode = 'P0002'; end if;
  if inv.expires_at < now() then raise exception 'Invitation expirée' using errcode = 'P0002'; end if;
  update public.depot_invites set used_at = coalesce(used_at, now()), used_by = p_openid where token_hash = inv.token_hash;
  insert into public.wechat_identities (openid, unionid, org_id, label)
  values (p_openid, p_unionid, inv.org_id, inv.label)
  on conflict (openid) do update set org_id = excluded.org_id, unionid = coalesce(excluded.unionid, wechat_identities.unionid),
    label = coalesce(excluded.label, wechat_identities.label), revoked_at = null, bound_at = now();
  insert into public.events (actor, text, ref) values ('depot', 'Compte WeChat rattaché pour le dépôt de stock' ||
    coalesce(' (' || inv.label || ')', ''), inv.org_id);
  return inv.org_id;
end $$;

-- Société rattachée à un openid (null si inconnu ou révoqué) ; note la connexion.
create or replace function public.depot_identity(p_openid text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  update public.wechat_identities set last_login_at = now()
   where openid = p_openid and revoked_at is null
  returning org_id into r;
  if r.org_id is null then return null; end if;
  return (select jsonb_build_object('org_id', o.id, 'name', o.name, 'alias', o.alias, 'lang', o.lang)
            from public.organizations o where o.id = r.org_id);
end $$;

revoke execute on function public.create_depot_invite(text, text), public.redeem_depot_invite(text, text, text),
  public.depot_identity(text) from public, anon, authenticated;
grant execute on function public.redeem_depot_invite(text, text, text), public.depot_identity(text) to service_role;
grant execute on function public.create_depot_invite(text, text) to service_role;
