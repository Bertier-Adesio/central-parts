-- Inscription des fournisseurs simplifiée et adaptée au profil (note de Bertier du 11 novembre 2026, ADR 0034).
-- À appliquer à la main dans le SQL Editor. Rejouable. Ne modifie aucune société déjà inscrite : les profils
-- existants (Manufacturer, Distributor, Reseller, Broker, Surplus …) gardent leur valeur et leurs règles.
--
--   - 3 profils à l'inscription : Manufacturer (原厂), Distributor (授权分销商), Spot (现货 / 库存 : revendeur, broker,
--     surplus). « Spot » est une valeur provisoire : app.source_category la range déjà avec les brokers (rail
--     Opportunity, 7 jours). L'administrateur la remplace à l'approbation par Broker ou Surplus (obligatoire).
--   - Vérification : photo de la licence OU numéro d'immatriculation, l'un des deux suffit. La photo peut être
--     déposée avant l'inscription, dans un dossier « pending/<empreinte de l'openid>/ » du compartiment privé.
--   - Fabricant et distributeur déclarent leurs marques (texte libre, indication pour l'administrateur : ne crée
--     aucun rattachement ni libellé) ; le distributeur peut joindre sa lettre d'agrément.
--   - Ville et région facultatives : l'administrateur les complète avant d'approuver (admin_supplier_complete).
--   - Devise des prix obligatoire, sans valeur par défaut.

-- ------------------------------------------------------------ colonnes
alter table public.organizations
  add column if not exists declared_brands  text,   -- marques déclarées à l'inscription (fabricant, distributeur)
  add column if not exists auth_letter_path text;   -- lettre d'agrément du distributeur, compartiment privé supplier-docs

-- Journal des décisions : changement de profil par l'administrateur.
alter table public.supplier_decisions drop constraint if exists supplier_decisions_action_check;
alter table public.supplier_decisions add constraint supplier_decisions_action_check
  check (action in ('approved', 'rejected', 'pending', 'profile'));

-- Dossier des pièces déposées avant l'inscription (le compte n'a pas encore de société). Même calcul que la
-- fonction Edge depot (pendingDocPrefix, _shared/depot.js).
create or replace function app.pending_doc_prefix(p_openid text) returns text
language sql immutable set search_path = '' as $$
  select 'pending/' || left(encode(extensions.digest(coalesce(p_openid, ''), 'sha256'), 'hex'), 32) || '/'
$$;

-- ------------------------------------------------------------ inscription
-- Erreurs : CP001 numéro invalide, CP002 société déjà enregistrée, CP003 compte déjà rattaché, CP004 champ manquant
-- (detail : name, profile, currency, region, brands, license, auth_letter), CP008 ni photo ni numéro.
drop function if exists public.register_supplier(text, text, text, text, text, text, text);
-- Ordre des paramètres d'origine gardé (appels positionnels existants) ; les nouveaux viennent à la fin.
-- La devise reste « USD » par défaut au niveau SQL pour ces appels ; la fonction Edge depot l'exige (pas de défaut).
-- Numéro sans région : règle chinoise, comme avant.
create or replace function public.register_supplier(p_openid text, p_name text, p_code text, p_city text,
  p_profile text, p_currency text default 'USD', p_region text default null, p_license_path text default null,
  p_brands text default null, p_auth_path text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_org text;
  v_prefix text := app.pending_doc_prefix(p_openid);
  v_region text := nullif(upper(btrim(coalesce(p_region, ''))), '');
  v_code text := nullif(btrim(coalesce(p_code, '')), '');
  v_profile text := btrim(coalesce(p_profile, ''));
  v_brands text := nullif(left(regexp_replace(btrim(coalesce(p_brands, '')), '\s+', ' ', 'g'), 300), '');
  v_cur text := upper(btrim(coalesce(p_currency, '')));
begin
  if exists (select 1 from public.wechat_identities where openid = p_openid and revoked_at is null) then
    raise exception 'Compte déjà rattaché à une société' using errcode = 'CP003';
  end if;
  if coalesce(btrim(p_name), '') = '' then raise exception 'Nom manquant' using errcode = 'CP004', detail = 'name'; end if;
  -- Les anciennes valeurs restent acceptées (page restée en cache) ; la page propose les trois nouvelles.
  if v_profile not in ('Manufacturer', 'Distributor', 'Spot', 'Reseller', 'Broker') then
    raise exception 'Profil invalide' using errcode = 'CP004', detail = 'profile';
  end if;
  if v_cur not in ('USD', 'CNH', 'EUR', 'HKD') then raise exception 'Devise manquante' using errcode = 'CP004', detail = 'currency'; end if;
  if v_profile in ('Manufacturer', 'Distributor') and v_brands is null then
    raise exception 'Marques manquantes' using errcode = 'CP004', detail = 'brands';
  end if;
  if p_license_path is not null and (left(p_license_path, length(v_prefix)) <> v_prefix or p_license_path !~ '/licence-[0-9-]+\.(jpg|png|heic|webp|pdf)$') then
    raise exception 'Chemin de licence invalide' using errcode = 'CP004', detail = 'license';
  end if;
  if p_auth_path is not null and (left(p_auth_path, length(v_prefix)) <> v_prefix or p_auth_path !~ '/agrement-[0-9-]+\.(jpg|png|heic|webp|pdf)$') then
    raise exception 'Chemin de lettre d''agrément invalide' using errcode = 'CP004', detail = 'auth_letter';
  end if;
  -- Numéro : la région sert à contrôler sa longueur (mêmes règles qu'avant) ; sans numéro, la région est facultative.
  if v_code is not null then
    v_region := case when p_region is null then 'CN' else upper(btrim(p_region)) end;
    if v_region not in ('CN', 'HK', 'OTHER') then
      raise exception 'Région manquante' using errcode = 'CP004', detail = 'region';
    end if;
    v_code := case when v_region = 'CN' then upper(v_code) else upper(regexp_replace(v_code, '\s+', ' ', 'g')) end;
    if not app.registration_number_ok(v_region, v_code) then raise exception 'Numéro invalide : %', v_code using errcode = 'CP001'; end if;
    if exists (select 1 from public.organizations where upper(registration_number) = v_code) then
      raise exception 'Société déjà enregistrée' using errcode = 'CP002';
    end if;
  elsif v_region is not null and v_region not in ('CN', 'HK', 'OTHER') then
    v_region := null;
  end if;
  if v_code is null and p_license_path is null then
    raise exception 'Photo de la licence ou numéro d''immatriculation requis' using errcode = 'CP008';
  end if;
  insert into public.organizations (type, name, alias, city, country, currency, lang, profile, registration_number,
                                    registration_region, kyb, registered_by, license_path, declared_brands, auth_letter_path)
  values ('seller', btrim(p_name),
          'P-' || coalesce(v_code, upper(left(encode(extensions.digest(p_openid || clock_timestamp()::text, 'sha256'), 'hex'), 12))),
          nullif(btrim(coalesce(p_city, '')), ''),
          case v_region when 'CN' then 'CN' when 'HK' then 'HK' end,   -- autre pays ou inconnu : complété par l'opérateur
          v_cur, 'zh', v_profile, v_code, v_region, 'pending', p_openid, p_license_path,
          case when v_profile in ('Manufacturer', 'Distributor') then v_brands end,
          case when v_profile = 'Distributor' then p_auth_path end)
  returning id into v_org;
  insert into public.wechat_identities (openid, org_id, role) values (p_openid, v_org, 'admin')
  on conflict (openid) do update set org_id = excluded.org_id, role = 'admin', revoked_at = null, bound_at = now();
  insert into public.events (actor, text, ref) values ('depot', 'Société enregistrée par le fournisseur (' || v_profile || ', '
    || case when v_code is not null and p_license_path is not null then 'licence et numéro'
            when v_code is not null then 'numéro' else 'licence' end || '), en attente de validation', v_org);
  return public.depot_identity(p_openid);
end $$;

-- Copie de 20261031000007, avec le numéro (pièce fournie) et le profil.
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
                   'has_code', o.registration_number is not null, 'profile', o.profile,
                   'rejected_reason', o.rejected_reason)
            from public.organizations o where o.id = r.org_id);
end $$;

-- Pièces fournies : « both », « license », « number », ou « none » (société inscrite avant cette migration).
create or replace function app.verification_piece(o public.organizations) returns text
language sql immutable set search_path = '' as $$
  select case when o.license_path is not null and o.registration_number is not null then 'both'
              when o.license_path is not null then 'license' when o.registration_number is not null then 'number' else 'none' end
$$;

-- Copie de 20261102000013, avec la pièce fournie, les marques déclarées et la lettre d'agrément (commande pending).
create or replace function public.pending_suppliers()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('org_id', o.id, 'name', o.name, 'code', o.registration_number,
           'region', o.registration_region,
           'city', o.city, 'profile', o.profile, 'license_path', o.license_path,
           'piece', app.verification_piece(o), 'brands', o.declared_brands, 'auth_letter_path', o.auth_letter_path,
           'lines', (select count(*) from public.lots l where l.seller_id = o.id and l.qty > 0),
           'registered_at', o.created_at) order by o.created_at), '[]'::jsonb)
    from public.organizations o where o.type = 'seller' and o.kyb = 'pending'
$$;

-- ------------------------------------------------------------ approbation
-- Copie de 20261102000014, avec la sous-catégorie d'un profil « Spot » : p_spot « broker » ou « surplus »,
-- obligatoire pour lui (CP007), ignorée pour les autres profils. Le choix est inscrit au journal.
drop function if exists public.approve_supplier(text, text);
create or replace function public.approve_supplier(p_org text, p_by text default null, p_spot text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare o public.organizations; v_alias text; v_profile text;
begin
  select * into o from public.organizations where id = p_org and type = 'seller' for update;
  if o.id is null then raise exception 'Société inconnue : %', p_org using errcode = 'P0002'; end if;
  if o.kyb = 'validated' then return o.alias; end if;
  if o.profile = 'Spot' then
    v_profile := case lower(btrim(coalesce(p_spot, ''))) when 'broker' then 'Broker' when 'surplus' then 'Surplus' end;
    if v_profile is null then
      raise exception '% est un stock disponible : préciser broker ou surplus', p_org using errcode = 'CP007';
    end if;
    update public.organizations set profile = v_profile where id = p_org;
    insert into public.supplier_decisions (org_id, action, from_status, reason, decided_by)
    values (p_org, 'profile', o.kyb, 'Spot → ' || v_profile, p_by);
  end if;
  if o.alias ~ '^V-\d+$' then
    v_alias := o.alias;
  else
    -- Verrou de transaction : deux validations simultanées n'obtiennent pas le même pseudonyme.
    perform pg_advisory_xact_lock(hashtext('app.alias_v'));
    v_alias := 'V-' || (coalesce((select max(substring(alias from '^V-(\d+)$')::int) from public.organizations), 0) + 1);
  end if;
  update public.organizations set kyb = 'validated', kyb_decided_at = now(), alias = v_alias, rejected_reason = null
   where id = p_org;
  insert into public.subscriptions (org_id, plan, until)
  select p_org, 'Gratuit jusqu''à la première vente', current_date + 365
   where not exists (select 1 from public.subscriptions s where s.org_id = p_org and s.until >= current_date);
  insert into public.supplier_decisions (org_id, action, from_status, decided_by) values (p_org, 'approved', o.kyb, p_by);
  insert into public.events (actor, text, ref) values ('ops', 'Société validée (' || v_alias || ')' || coalesce(' par ' || p_by, ''), p_org);
  return v_alias;
end $$;

drop function if exists public.admin_approve(text);
create or replace function public.admin_approve(p_org text, p_spot text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_by text := app.require_admin(); v_alias text;
begin
  v_alias := public.approve_supplier(p_org, v_by, p_spot);
  return jsonb_build_object('org_id', p_org, 'status', 'validated', 'alias', v_alias);
end $$;

-- Avant l'approbation : région, ville et profil complétés ou corrigés par l'administrateur, d'après la licence.
-- p : { region?, city?, profile? } ; profil parmi Manufacturer, Distributor, Spot, Broker, Surplus, Reseller.
-- Un changement de profil est inscrit au journal (supplier_decisions, action « profile »). Société approuvée :
-- refusé (P0002), la remettre d'abord en attente.
create or replace function public.admin_supplier_complete(p_org text, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_by text := app.require_admin(); o public.organizations; v_region text; v_profile text;
begin
  select * into o from public.organizations where id = upper(btrim(coalesce(p_org, ''))) and type = 'seller' and kyb <> 'validated' for update;
  if o.id is null then raise exception 'Société inconnue ou déjà approuvée : %', p_org using errcode = 'P0002'; end if;
  v_region := case when p ? 'region' then nullif(upper(btrim(coalesce(p->>'region', ''))), '') else o.registration_region end;
  if v_region is not null and v_region not in ('CN', 'HK', 'OTHER') then raise exception 'Région invalide' using errcode = '22023'; end if;
  v_profile := case when p ? 'profile' then btrim(coalesce(p->>'profile', '')) else o.profile end;
  if v_profile not in ('Manufacturer', 'Distributor', 'Spot', 'Broker', 'Surplus', 'Reseller') then
    raise exception 'Profil invalide' using errcode = '22023';
  end if;
  update public.organizations set registration_region = v_region,
    country = case v_region when 'CN' then 'CN' when 'HK' then 'HK' else country end,
    city = case when p ? 'city' then nullif(left(btrim(coalesce(p->>'city', '')), 60), '') else city end,
    profile = v_profile
   where id = o.id;
  if v_profile is distinct from o.profile then
    insert into public.supplier_decisions (org_id, action, from_status, reason, decided_by)
    values (o.id, 'profile', o.kyb, o.profile || ' → ' || v_profile, v_by);
    -- Un compte qui n'est plus fabricant ni distributeur perd ses rattachements (jamais « agréé » ni « direct »).
    if app.source_category(v_profile) not in ('manufacturer', 'distributor') then
      delete from public.manufacturer_distributors where org_id = o.id;
    end if;
  end if;
  insert into public.events (actor, text, ref) values ('ops', 'Fiche complétée avant approbation par ' || v_by, o.id);
  return public.admin_supplier_signup(o.id);
end $$;

-- Inscription vue par l'administrateur : profil, pièce fournie, marques déclarées, lettre d'agrément.
create or replace function public.admin_supplier_signup(p_org text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare o public.organizations;
begin
  perform app.require_admin();
  select * into o from public.organizations where id = upper(btrim(coalesce(p_org, ''))) and type = 'seller';
  if o.id is null then raise exception 'Société inconnue : %', p_org using errcode = 'P0002'; end if;
  return jsonb_build_object('org_id', o.id, 'profile', o.profile, 'category', app.source_category(o.profile),
    'piece', app.verification_piece(o), 'has_license', o.license_path is not null, 'has_code', o.registration_number is not null,
    'brands', o.declared_brands, 'has_auth_letter', o.auth_letter_path is not null,
    'region', o.registration_region, 'city', o.city, 'status', o.kyb,
    'spot_pending', o.profile = 'Spot' and o.kyb <> 'validated');
end $$;

-- Message d'accueil : catégorie et rattachements au moment de l'approbation (fonctions Edge, clé de service).
create or replace function public.supplier_welcome(p_org text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('org_id', o.id, 'alias', o.alias, 'category', app.source_category(o.profile),
    'links', coalesce((select jsonb_agg(m.name order by m.name) from public.manufacturer_distributors d
                         join public.manufacturers m on m.id = d.manufacturer_id where d.org_id = o.id), '[]'::jsonb))
    from public.organizations o where o.id = p_org
$$;

-- ------------------------------------------------------------ droits
revoke execute on function app.pending_doc_prefix(text), app.verification_piece(public.organizations) from public, anon, authenticated;
revoke execute on function public.register_supplier(text, text, text, text, text, text, text, text, text, text),
  public.approve_supplier(text, text, text), public.supplier_welcome(text) from public, anon, authenticated;
grant execute on function public.register_supplier(text, text, text, text, text, text, text, text, text, text),
  public.approve_supplier(text, text, text), public.supplier_welcome(text) to service_role;
revoke execute on function public.admin_approve(text, text), public.admin_supplier_complete(text, jsonb),
  public.admin_supplier_signup(text) from public, anon;
grant execute on function public.admin_approve(text, text), public.admin_supplier_complete(text, jsonb),
  public.admin_supplier_signup(text) to authenticated, service_role;
