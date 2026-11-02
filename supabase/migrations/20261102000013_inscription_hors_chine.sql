-- Inscription des fournisseurs de Hong Kong et d'autres pays (complète ADR 0012).
--
-- Le formulaire demandait le 统一社会信用代码 (18 caractères, Chine continentale) : une société de Hong Kong ou
-- étrangère ne pouvait pas s'inscrire. On ajoute le pays / région d'immatriculation :
--   CN    : Chine continentale, 统一社会信用代码, contrôle inchangé (18 caractères, clé modulo 31) ;
--   HK    : Hong Kong, numéro d'immatriculation libre ;
--   OTHER : autre pays, numéro d'immatriculation libre.
-- Numéro libre : 5 à 30 caractères, lettres, chiffres, tirets, espaces et barres obliques. Aucun contrôle de fond
-- à l'inscription : l'opérateur vérifie le numéro avant d'approuver la société.
--
-- Rétrocompatible : aucune colonne supprimée ni renommée, aucune donnée existante modifiée. Les sociétés déjà
-- inscrites gardent registration_region à null (lu comme Chine continentale). Rejouable.
-- Indépendante de 20261102000012_listes_vendeurs.sql (branche fournisseurs/listes-vendeurs) : aucune fonction commune.

alter table public.organizations add column if not exists registration_region text
  check (registration_region in ('CN', 'HK', 'OTHER'));

-- Numéro d'immatriculation selon le pays / région ; mêmes règles que la page (site/depot/) et
-- supabase/functions/_shared/depot.js (registrationNumberOk).
create or replace function app.registration_number_ok(p_region text, p_code text) returns boolean
language sql immutable set search_path = '' as $$
  select case p_region
    when 'CN' then app.credit_code_ok(p_code)
    when 'HK' then coalesce(p_code, '') ~ '^[A-Z0-9 /-]{5,30}$' and p_code ~ '[A-Z0-9]'
    when 'OTHER' then coalesce(p_code, '') ~ '^[A-Z0-9 /-]{5,30}$' and p_code ~ '[A-Z0-9]'
    else false
  end
$$;

-- Enregistrement d'une société par un compte WeChat sans société. Erreurs : CP001 numéro invalide,
-- CP002 société déjà enregistrée, CP003 compte déjà rattaché, CP004 champ manquant (dont le pays / région).
-- p_region vaut 'CN' par défaut : une page restée en cache (sans le champ) garde le comportement précédent.
drop function if exists public.register_supplier(text, text, text, text, text, text);
create or replace function public.register_supplier(p_openid text, p_name text, p_code text, p_city text,
  p_profile text, p_currency text default 'USD', p_region text default 'CN')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_org text;
  v_region text := upper(btrim(coalesce(p_region, '')));
  -- Chine : sans espaces ; ailleurs : espaces répétés réduits à un seul.
  v_code text := case when upper(btrim(coalesce(p_region, ''))) = 'CN' then upper(btrim(coalesce(p_code, '')))
                      else upper(regexp_replace(btrim(coalesce(p_code, '')), '\s+', ' ', 'g')) end;
begin
  if exists (select 1 from public.wechat_identities where openid = p_openid and revoked_at is null) then
    raise exception 'Compte déjà rattaché à une société' using errcode = 'CP003';
  end if;
  if coalesce(btrim(p_name), '') = '' or coalesce(btrim(p_city), '') = ''
     or p_profile not in ('Manufacturer', 'Distributor', 'Reseller', 'Broker')
     or v_region not in ('CN', 'HK', 'OTHER') then
    raise exception 'Champ manquant ou invalide' using errcode = 'CP004';
  end if;
  if not app.registration_number_ok(v_region, v_code) then raise exception 'Numéro invalide : %', v_code using errcode = 'CP001'; end if;
  if exists (select 1 from public.organizations where upper(registration_number) = v_code) then
    raise exception 'Société déjà enregistrée' using errcode = 'CP002';
  end if;
  insert into public.organizations (type, name, alias, city, country, currency, lang, profile, registration_number,
                                    registration_region, kyb, registered_by)
  values ('seller', btrim(p_name), 'P-' || v_code, btrim(p_city),
          case v_region when 'CN' then 'CN' when 'HK' then 'HK' end,   -- autre pays : complété par l'opérateur
          case when upper(p_currency) in ('USD', 'CNH', 'EUR', 'HKD') then upper(p_currency) else 'USD' end,
          'zh', p_profile, v_code, v_region, 'pending', p_openid)
  returning id into v_org;
  insert into public.wechat_identities (openid, org_id, role) values (p_openid, v_org, 'admin')
  on conflict (openid) do update set org_id = excluded.org_id, role = 'admin', revoked_at = null, bound_at = now();
  insert into public.events (actor, text, ref) values ('depot', 'Société enregistrée par le fournisseur, en attente de validation', v_org);
  return public.depot_identity(p_openid);
end $$;

-- Sociétés en attente, pour la commande pending des opérateurs : avec le pays / région d'immatriculation.
create or replace function public.pending_suppliers()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('org_id', o.id, 'name', o.name, 'code', o.registration_number,
           'region', o.registration_region,
           'city', o.city, 'profile', o.profile, 'license_path', o.license_path,
           'lines', (select count(*) from public.lots l where l.seller_id = o.id and l.qty > 0),
           'registered_at', o.created_at) order by o.created_at), '[]'::jsonb)
    from public.organizations o where o.type = 'seller' and o.kyb = 'pending'
$$;

revoke execute on function public.register_supplier(text, text, text, text, text, text, text), public.pending_suppliers()
  from public, anon, authenticated;
grant execute on function public.register_supplier(text, text, text, text, text, text, text), public.pending_suppliers()
  to service_role;
revoke execute on function app.registration_number_ok(text, text) from public, anon, authenticated;
