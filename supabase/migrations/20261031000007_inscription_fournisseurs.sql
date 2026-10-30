-- Inscription des fournisseurs chinois en libre-service, validation par l'opérateur dans WeChat (ADR 0012).
--
-- 1. Un compte WeChat sans société se connecte (QR code de la page, ou lien personnel reçu dans WeChat).
-- 2. Il enregistre sa société (nom, 统一社会信用代码, ville, profil, devise) : register_supplier. Il en devient
--    administrateur ; la société est « en attente » (kyb = 'pending') : elle peut déposer son stock, rien n'est publié.
-- 3. Il dépose la photo de sa licence (营业执照) : set_supplier_license. Les opérateurs sont prévenus dans WeChat.
-- 4. Un opérateur répond 通过 ou 拒绝 dans WeChat : approve_supplier (pseudonyme V-n, abonnement d'un an) ou
--    reject_supplier. L'administrateur invite ensuite ses collègues depuis la page : create_member_invite.

alter table public.organizations
  add column license_path text,              -- photo de la licence, compartiment privé supplier-docs
  add column registered_by text,             -- openid de la personne qui a enregistré la société
  add column rejected_reason text;

-- Une société n'existe qu'une fois : numéro officiel unique (统一社会信用代码 pour la Chine).
create unique index organizations_registration_number_key on public.organizations (upper(registration_number))
  where registration_number is not null;

alter table public.wechat_identities
  add column role text not null default 'member' check (role in ('admin', 'member'));
-- Les contacts rattachés avant cette migration gèrent leur société.
update public.wechat_identities set role = 'admin';

-- Invitation utilisée : le contact devient membre ; le premier contact d'une société sans administrateur
-- (société créée par l'opérateur) en devient l'administrateur.
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
  insert into public.wechat_identities (openid, unionid, org_id, label, role)
  values (p_openid, p_unionid, inv.org_id, inv.label,
          case when exists (select 1 from public.wechat_identities w where w.org_id = inv.org_id and w.role = 'admin'
                             and w.revoked_at is null and w.openid <> p_openid) then 'member' else 'admin' end)
  on conflict (openid) do update set org_id = excluded.org_id, unionid = coalesce(excluded.unionid, wechat_identities.unionid),
    label = coalesce(excluded.label, wechat_identities.label), revoked_at = null, bound_at = now(),
    role = case when wechat_identities.org_id = excluded.org_id then wechat_identities.role else excluded.role end;
  insert into public.events (actor, text, ref) values ('depot', 'Compte WeChat rattaché pour le dépôt de stock' ||
    coalesce(' (' || inv.label || ')', ''), inv.org_id);
  return inv.org_id;
end $$;

-- Comptes WeChat autorisés à valider les sociétés (commandes 待审核, 通过, 拒绝 dans WeChat).
create table public.operators (
  openid     text primary key,
  label      text,
  added_at   timestamptz not null default now()
);
alter table public.operators enable row level security;
revoke all on public.operators from anon, authenticated;

-- Compartiment privé des pièces des fournisseurs (licences), écrit par liens signés de la fonction depot.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('supplier-docs', 'supplier-docs', false, 10485760, array['image/jpeg', 'image/png', 'image/heic', 'image/webp', 'application/pdf'])
on conflict (id) do nothing;

-- 统一社会信用代码 (GB 32100-2015) : 18 caractères, clé de contrôle modulo 31.
create or replace function app.credit_code_ok(p_code text) returns boolean
language plpgsql immutable set search_path = '' as $$
declare
  cs constant text := '0123456789ABCDEFGHJKLMNPQRTUWXY';
  w constant int[] := array[1, 3, 9, 27, 19, 26, 16, 17, 20, 29, 25, 13, 8, 24, 10, 30, 28];
  c text := upper(coalesce(p_code, '')); t int := 0; k int; i int;
begin
  if c !~ '^[0-9A-HJ-NPQRTUWXY]{18}$' then return false; end if;
  for i in 1..17 loop t := t + (strpos(cs, substr(c, i, 1)) - 1) * w[i]; end loop;
  k := 31 - t % 31; if k = 31 then k := 0; end if;
  return substr(cs, k + 1, 1) = substr(c, 18, 1);
end $$;

-- Société rattachée à un openid, avec son statut et le rôle du contact (null si inconnu ou révoqué) ; note la connexion.
create or replace function public.depot_identity(p_openid text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  update public.wechat_identities set last_login_at = now()
   where openid = p_openid and revoked_at is null
  returning org_id, role into r;
  if r.org_id is null then return null; end if;
  return (select jsonb_build_object('org_id', o.id, 'name', o.name, 'alias', o.alias, 'lang', o.lang,
                   'status', o.kyb, 'role', r.role, 'has_license', o.license_path is not null,
                   'rejected_reason', o.rejected_reason)
            from public.organizations o where o.id = r.org_id);
end $$;

-- Enregistrement d'une société par un compte WeChat sans société. Erreurs : CP001 numéro invalide,
-- CP002 société déjà enregistrée, CP003 compte déjà rattaché, CP004 champ manquant.
create or replace function public.register_supplier(p_openid text, p_name text, p_code text, p_city text,
  p_profile text, p_currency text default 'USD')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_org text; v_code text := upper(btrim(coalesce(p_code, '')));
begin
  if exists (select 1 from public.wechat_identities where openid = p_openid and revoked_at is null) then
    raise exception 'Compte déjà rattaché à une société' using errcode = 'CP003';
  end if;
  if coalesce(btrim(p_name), '') = '' or coalesce(btrim(p_city), '') = ''
     or p_profile not in ('Manufacturer', 'Distributor', 'Reseller', 'Broker') then
    raise exception 'Champ manquant ou invalide' using errcode = 'CP004';
  end if;
  if not app.credit_code_ok(v_code) then raise exception 'Numéro invalide : %', v_code using errcode = 'CP001'; end if;
  if exists (select 1 from public.organizations where upper(registration_number) = v_code) then
    raise exception 'Société déjà enregistrée' using errcode = 'CP002';
  end if;
  insert into public.organizations (type, name, alias, city, country, currency, lang, profile, registration_number, kyb, registered_by)
  values ('seller', btrim(p_name), 'P-' || v_code, btrim(p_city), 'CN',
          case when upper(p_currency) in ('USD', 'CNH', 'EUR', 'HKD') then upper(p_currency) else 'USD' end,
          'zh', p_profile, v_code, 'pending', p_openid)
  returning id into v_org;
  insert into public.wechat_identities (openid, org_id, role) values (p_openid, v_org, 'admin')
  on conflict (openid) do update set org_id = excluded.org_id, role = 'admin', revoked_at = null, bound_at = now();
  insert into public.events (actor, text, ref) values ('depot', 'Société enregistrée par le fournisseur, en attente de validation', v_org);
  return public.depot_identity(p_openid);
end $$;

-- Photo de la licence déposée : chemin dans supplier-docs, dossier de la société.
create or replace function public.set_supplier_license(p_org text, p_path text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_path is null or split_part(p_path, '/', 1) <> p_org then raise exception 'Chemin invalide'; end if;
  update public.organizations set license_path = p_path where id = p_org and type = 'seller';
end $$;

-- Validation par un opérateur : pseudonyme V-n suivant, KYB validé, abonnement d'un an. Renvoie le pseudonyme.
create or replace function public.approve_supplier(p_org text, p_by text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare o public.organizations; v_alias text;
begin
  select * into o from public.organizations where id = p_org and type = 'seller' for update;
  if o.id is null then raise exception 'Société inconnue : %', p_org using errcode = 'P0002'; end if;
  if o.kyb = 'validated' then return o.alias; end if;
  -- Verrou de transaction : deux validations simultanées n'obtiennent pas le même pseudonyme.
  perform pg_advisory_xact_lock(hashtext('app.alias_v'));
  v_alias := 'V-' || (coalesce((select max(substring(alias from '^V-(\d+)$')::int) from public.organizations), 0) + 1);
  update public.organizations set kyb = 'validated', kyb_decided_at = now(), alias = v_alias, rejected_reason = null
   where id = p_org;
  insert into public.subscriptions (org_id, plan, until)
  select p_org, 'Vendeur Opportunity', current_date + 365
   where not exists (select 1 from public.subscriptions s where s.org_id = p_org and s.until >= current_date);
  insert into public.events (actor, text, ref) values ('ops', 'Société validée (' || v_alias || ')' || coalesce(' par ' || p_by, ''), p_org);
  return v_alias;
end $$;

create or replace function public.reject_supplier(p_org text, p_reason text, p_by text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.organizations set kyb = 'rejected', kyb_decided_at = now(), rejected_reason = nullif(btrim(p_reason), '')
   where id = p_org and type = 'seller' and kyb <> 'validated';
  if not found then raise exception 'Société inconnue ou déjà validée : %', p_org using errcode = 'P0002'; end if;
  insert into public.events (actor, text, ref) values ('ops', 'Société refusée' || coalesce(' par ' || p_by, ''), p_org);
end $$;

-- Sociétés en attente, pour la commande 待审核 des opérateurs.
create or replace function public.pending_suppliers()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('org_id', o.id, 'name', o.name, 'code', o.registration_number,
           'city', o.city, 'profile', o.profile, 'license_path', o.license_path,
           'lines', (select count(*) from public.lots l where l.seller_id = o.id and l.qty > 0),
           'registered_at', o.created_at) order by o.created_at), '[]'::jsonb)
    from public.organizations o where o.type = 'seller' and o.kyb = 'pending'
$$;

-- Comptes WeChat à prévenir à propos d'une société : ses administrateurs actifs.
create or replace function public.org_admins(p_org text)
returns setof text language sql stable security definer set search_path = '' as $$
  select openid from public.wechat_identities where org_id = p_org and role = 'admin' and revoked_at is null
$$;

-- Invitation d'un collègue par un administrateur de la société (pas par un simple membre).
create or replace function public.create_member_invite(p_openid text, p_label text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare v_org text;
begin
  select org_id into v_org from public.wechat_identities where openid = p_openid and role = 'admin' and revoked_at is null;
  if v_org is null then raise exception 'Réservé aux administrateurs' using errcode = '42501'; end if;
  return public.create_depot_invite(v_org, nullif(btrim(p_label), ''));
end $$;

-- Contacts de la société et invitations en cours, vus par un administrateur.
create or replace function public.org_contacts(p_openid text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org text;
begin
  select org_id into v_org from public.wechat_identities where openid = p_openid and role = 'admin' and revoked_at is null;
  if v_org is null then raise exception 'Réservé aux administrateurs' using errcode = '42501'; end if;
  return jsonb_build_object(
    'members', (select coalesce(jsonb_agg(jsonb_build_object('label', w.label, 'role', w.role, 'me', w.openid = p_openid,
                  'bound_at', w.bound_at, 'last_login_at', w.last_login_at) order by w.bound_at), '[]')
                  from public.wechat_identities w where w.org_id = v_org and w.revoked_at is null),
    'invites', (select coalesce(jsonb_agg(jsonb_build_object('label', i.label, 'expires_at', i.expires_at) order by i.created_at), '[]')
                  from public.depot_invites i where i.org_id = v_org and i.used_at is null and i.expires_at > now()));
end $$;

-- Lien de connexion personnel envoyé dans WeChat (message d'accueil) : une tentative déjà scannée, 15 minutes.
create or replace function public.depot_login_link(p_openid text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_scene text := 'dl_' || encode(extensions.gen_random_bytes(16), 'hex'); who jsonb := public.depot_identity(p_openid);
begin
  delete from public.depot_logins where expires_at < now() - interval '1 day';
  insert into public.depot_logins (scene, status, openid, org_id, expires_at, scanned_at)
  values (v_scene, case when who is null then 'not_bound' else 'ok' end, p_openid, who->>'org_id',
          now() + interval '15 minutes', now());
  return v_scene;
end $$;

-- La page interroge sa tentative. Connexion reconnue : remise une seule fois, avec la société ;
-- compte sans société : remis une fois aussi, pour l'inscription (status « register »).
create or replace function public.depot_login_poll(p_scene text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare l public.depot_logins; who jsonb;
begin
  select * into l from public.depot_logins where scene = p_scene for update;
  if l.scene is null then return jsonb_build_object('status', 'unknown'); end if;
  if l.status in ('pending', 'ok', 'not_bound') and l.expires_at < now() then
    update public.depot_logins set status = 'expired', invite = null where scene = p_scene;
    return jsonb_build_object('status', 'expired');
  end if;
  if l.status in ('ok', 'not_bound') then
    who := public.depot_identity(l.openid);
    update public.depot_logins set status = 'consumed' where scene = p_scene;
    if who is null then return jsonb_build_object('status', 'register', 'openid', l.openid); end if;
    return jsonb_build_object('status', 'ok', 'openid', l.openid, 'org', who);
  end if;
  return jsonb_build_object('status', l.status);
end $$;

revoke execute on function public.register_supplier(text, text, text, text, text, text),
  public.set_supplier_license(text, text), public.approve_supplier(text, text), public.reject_supplier(text, text, text),
  public.pending_suppliers(), public.org_admins(text), public.create_member_invite(text, text),
  public.org_contacts(text), public.depot_login_link(text) from public, anon, authenticated;
grant execute on function public.register_supplier(text, text, text, text, text, text),
  public.set_supplier_license(text, text), public.approve_supplier(text, text), public.reject_supplier(text, text, text),
  public.pending_suppliers(), public.org_admins(text), public.create_member_invite(text, text),
  public.org_contacts(text), public.depot_login_link(text) to service_role;
