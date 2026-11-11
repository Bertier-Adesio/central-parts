-- Inscription des fournisseurs simplifiée et adaptée au profil (note de Bertier du 11 novembre 2026, ADR 0034).
-- À appliquer à la main dans le SQL Editor. Rejouable. Ne modifie aucune société déjà inscrite : les profils
-- existants (Manufacturer, Distributor, Reseller, Broker, Surplus …) gardent leur valeur et leurs règles.
--
--   - 3 profils à l'inscription : Manufacturer (原厂), Distributor (授权分销商), Spot (现货 / 库存 : revendeur, broker,
--     surplus). « Spot » est une valeur provisoire : app.source_category la range déjà avec les brokers (rail
--     Opportunity, 7 jours). L'administrateur la remplace à l'approbation par Broker ou Surplus (obligatoire).
--   - Vérification : photo de la licence OU numéro d'immatriculation, l'un des deux suffit. La photo peut être
--     déposée avant l'inscription, dans un dossier « pending/<empreinte de l'openid>/ » du compartiment privé.
--   - Principe (note mise à jour du 11 novembre) : on DEMANDE tout, on ne BLOQUE presque sur rien. Bloquent l'envoi :
--     nom de la société, profil, une pièce (photo ou numéro), nom du contact principal, devise. Le reste se complète
--     plus tard, par le fournisseur (supplier_signup_save) ou par l'administrateur (admin_supplier_complete).
--   - Fabricant et distributeur déclarent leurs marques (texte libre, indication pour l'administrateur : ne crée
--     aucun rattachement ni libellé) ; le distributeur peut joindre sa lettre d'agrément.
--   - Site web, compte WeChat professionnel ou compte de service, contact principal et jusqu'à 3 contacts
--     supplémentaires (table seller_contacts existante, étendue). Données personnelles : lues par la société et
--     l'administrateur seulement, jamais par un acheteur ni par l'API d'offres.
--   - Ville et région demandées, jamais exigées (la région seulement avec un numéro).

-- ------------------------------------------------------------ colonnes
alter table public.organizations
  add column if not exists declared_brands  text,   -- marques déclarées à l'inscription (fabricant, distributeur)
  add column if not exists auth_letter_path text,   -- lettre d'agrément du distributeur, compartiment privé supplier-docs
  add column if not exists wecom            text,   -- 企业微信或公众号 : nom ou identifiant, interne (jamais publié)
  add column if not exists spot_hint        text check (spot_hint in ('broker', 'surplus')),  -- stock disponible : origine indiquée par le fournisseur
  -- Logo de la société : PNG de préférence (JPG, WebP acceptés), 1 Mo au plus, compartiment privé supplier-docs.
  -- Usage interne (fiche, back office) : jamais montré aux acheteurs ; la page publique d'un fabricant garde son propre logo.
  add column if not exists company_logo_path text;

-- Marques déclarées : séparateurs chinois et occidentaux, espaces, doublons (sans tenir compte de la casse) ; 20 au plus.
create or replace function app.norm_brands(p text) returns text
language sql immutable set search_path = '' as $$
  select nullif(left(string_agg(b, ', ' order by n), 300), '') from (
    select min(btrim(x)) as b, min(o) as n
      from regexp_split_to_table(coalesce(p, ''), '\s*[,，、;；/|]+\s*') with ordinality t(x, o)
     where btrim(x) <> '' group by upper(btrim(x)) order by min(o) limit 20) s
$$;

-- Ville d'après le 统一社会信用代码 : caractères 3 à 8 = code de la division administrative (GB/T 2260). Table des
-- villes les plus fréquentes chez les fournisseurs ; une ville absente reste à compléter (administrateur, fournisseur).
create table if not exists app.cn_city_codes (code text primary key, zh text not null, en text not null);
insert into app.cn_city_codes (code, zh, en) values
  ('11', '北京', 'Beijing'), ('12', '天津', 'Tianjin'), ('31', '上海', 'Shanghai'), ('50', '重庆', 'Chongqing'),
  ('4401', '广州', 'Guangzhou'), ('4403', '深圳', 'Shenzhen'), ('4404', '珠海', 'Zhuhai'), ('4405', '汕头', 'Shantou'),
  ('4406', '佛山', 'Foshan'), ('4407', '江门', 'Jiangmen'), ('4413', '惠州', 'Huizhou'), ('4419', '东莞', 'Dongguan'),
  ('4420', '中山', 'Zhongshan'), ('3201', '南京', 'Nanjing'), ('3202', '无锡', 'Wuxi'), ('3204', '常州', 'Changzhou'),
  ('3205', '苏州', 'Suzhou'), ('3301', '杭州', 'Hangzhou'), ('3302', '宁波', 'Ningbo'), ('3303', '温州', 'Wenzhou'),
  ('3501', '福州', 'Fuzhou'), ('3502', '厦门', 'Xiamen'), ('3701', '济南', 'Jinan'), ('3702', '青岛', 'Qingdao'),
  ('3401', '合肥', 'Hefei'), ('4101', '郑州', 'Zhengzhou'), ('4201', '武汉', 'Wuhan'), ('4301', '长沙', 'Changsha'),
  ('5101', '成都', 'Chengdu'), ('6101', '西安', 'Xi''an'), ('2101', '沈阳', 'Shenyang'), ('2102', '大连', 'Dalian')
on conflict (code) do update set zh = excluded.zh, en = excluded.en;
revoke all on app.cn_city_codes from public, anon, authenticated;
create or replace function app.city_from_code(p_code text) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select zh from app.cn_city_codes where code = substr(p_code, 3, 4)),
                  (select zh from app.cn_city_codes where code = substr(p_code, 3, 2)))
   where p_code ~ '^[0-9A-HJ-NPQRTUWXY]{18}$'
$$;

-- Contacts : contact principal (administrateur du compte, son openid) et rôle des contacts supplémentaires.
alter table public.seller_contacts
  add column if not exists duty   text check (duty in ('main', 'sales', 'logistics', 'finance', 'other')),
  add column if not exists openid text;             -- compte WeChat du contact principal, s'il s'est inscrit lui-même
-- Un e-mail mal formé n'empêche plus d'enregistrer un contact : la page avertit, la base n'exige plus de format.
alter table public.seller_contacts drop constraint if exists seller_contacts_email_check;

-- Adresse de site web sans « https:// » : complétée.
create or replace function app.norm_website(p text) returns text
language sql immutable set search_path = '' as $$
  select case when nullif(btrim(coalesce(p, '')), '') is null then null
              when btrim(p) ~* '^https?://' then left(btrim(p), 300)
              else left('https://' || btrim(p), 300) end
$$;

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
-- (detail : name, profile, currency, region, contact, license, auth_letter), CP008 ni photo ni numéro.
drop function if exists public.register_supplier(text, text, text, text, text, text, text);
drop function if exists public.register_supplier(text, text, text, text, text, text, text, text, text, text);
drop function if exists public.register_supplier(text, text, text, text, text, text, text, text, text, text, text, text, jsonb);
drop function if exists public.register_supplier(text, text, text, text, text, text, text, text, text, text, text, text, jsonb, text);
-- Ordre des paramètres d'origine gardé (appels positionnels existants) ; les nouveaux viennent à la fin.
-- La devise reste « USD » par défaut au niveau SQL pour ces appels ; la fonction Edge depot l'exige (pas de défaut).
-- Numéro sans région : règle chinoise, comme avant. p_contacts : [{family_name, given_name, role, phone, wechat,
-- email, duty}], le premier étant le contact principal (nom ou prénom exigé) ; une ligne entièrement vide est ignorée ;
-- 4 contacts au plus. Sans p_contacts (page restée en cache), aucun contact n'est exigé.
create or replace function public.register_supplier(p_openid text, p_name text, p_code text, p_city text,
  p_profile text, p_currency text default 'USD', p_region text default null, p_license_path text default null,
  p_brands text default null, p_auth_path text default null, p_website text default null, p_wecom text default null,
  p_contacts jsonb default null, p_spot_hint text default null, p_logo_path text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_org text;
  v_prefix text := app.pending_doc_prefix(p_openid);
  v_region text := nullif(upper(btrim(coalesce(p_region, ''))), '');
  v_code text := nullif(btrim(coalesce(p_code, '')), '');
  v_profile text := btrim(coalesce(p_profile, ''));
  v_brands text := app.norm_brands(p_brands);
  v_cur text := upper(btrim(coalesce(p_currency, '')));
  v_contacts jsonb := '[]';
  c jsonb; v_i int := 0;
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
  if p_license_path is not null and (left(p_license_path, length(v_prefix)) <> v_prefix or p_license_path !~ '/licence-[0-9-]+\.(jpg|png|heic|webp|pdf)$') then
    raise exception 'Chemin de licence invalide' using errcode = 'CP004', detail = 'license';
  end if;
  if p_auth_path is not null and (left(p_auth_path, length(v_prefix)) <> v_prefix or p_auth_path !~ '/agrement-[0-9-]+\.(jpg|png|heic|webp|pdf)$') then
    raise exception 'Chemin de lettre d''agrément invalide' using errcode = 'CP004', detail = 'auth_letter';
  end if;
  if p_logo_path is not null and not app.logo_path_ok(p_logo_path, v_prefix) then
    raise exception 'Chemin de logo invalide' using errcode = 'CP004', detail = 'logo';
  end if;
  -- Numéro : la région sert à contrôler sa longueur (mêmes règles qu'avant). Sans numéro, une région inconnue est ignorée.
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
  -- Contacts : lignes entièrement vides ignorées ; le premier (contact principal) doit avoir un nom ou un prénom.
  if jsonb_typeof(p_contacts) = 'array' then
    for c in select * from jsonb_array_elements(p_contacts) loop
      v_i := v_i + 1;
      if v_i > 4 then exit; end if;
      if v_i > 1 and btrim(concat(c->>'family_name', c->>'given_name', c->>'role', c->>'phone', c->>'wechat', c->>'email')) = '' then continue; end if;
      v_contacts := v_contacts || jsonb_build_array(c || jsonb_build_object('main', v_i = 1));
    end loop;
    if v_i = 0 or btrim(concat(p_contacts->0->>'family_name', p_contacts->0->>'given_name')) = '' then
      raise exception 'Nom du contact principal manquant' using errcode = 'CP004', detail = 'contact';
    end if;
  end if;
  insert into public.organizations (type, name, alias, city, country, currency, lang, profile, registration_number,
                                    registration_region, kyb, registered_by, license_path, declared_brands, auth_letter_path,
                                    website, wecom, spot_hint, company_logo_path)
  values ('seller', btrim(p_name),
          'P-' || coalesce(v_code, upper(left(encode(extensions.digest(p_openid || clock_timestamp()::text, 'sha256'), 'hex'), 12))),
          coalesce(nullif(left(btrim(coalesce(p_city, '')), 60), ''), case when v_region = 'CN' then app.city_from_code(v_code) end),
          case v_region when 'CN' then 'CN' when 'HK' then 'HK' end,   -- autre pays ou inconnu : complété par l'opérateur
          v_cur, 'zh', v_profile, v_code, v_region, 'pending', p_openid, p_license_path,
          case when v_profile in ('Manufacturer', 'Distributor') then v_brands end,
          case when v_profile = 'Distributor' then p_auth_path end,
          app.norm_website(p_website), nullif(left(btrim(coalesce(p_wecom, '')), 100), ''),
          case when v_profile = 'Spot' and p_spot_hint in ('broker', 'surplus') then p_spot_hint end, p_logo_path)
  returning id into v_org;
  insert into public.seller_contacts (org_id, name, role, email, phone, wechat, duty, openid)
  select v_org, left(coalesce(nullif(app.contact_name(x->>'family_name', x->>'given_name'), ''), nullif(btrim(coalesce(x->>'wechat', '')), ''),
                              nullif(btrim(coalesce(x->>'phone', '')), ''), btrim(coalesce(x->>'email', ''))), 120),
         nullif(left(btrim(coalesce(x->>'role', '')), 80), ''),
         nullif(left(lower(btrim(coalesce(x->>'email', ''))), 200), ''), nullif(left(btrim(coalesce(x->>'phone', '')), 40), ''),
         nullif(left(btrim(coalesce(x->>'wechat', '')), 60), ''),
         case when (x->>'main')::boolean then 'main' when x->>'duty' in ('sales', 'logistics', 'finance', 'other') then x->>'duty' else 'other' end,
         case when (x->>'main')::boolean then p_openid end
    from jsonb_array_elements(v_contacts) x
   where btrim(concat(app.contact_name(x->>'family_name', x->>'given_name'), x->>'wechat', x->>'phone', x->>'email')) <> '';
  insert into public.wechat_identities (openid, org_id, role, label) values (p_openid, v_org, 'admin',
    nullif(left(app.contact_name(p_contacts->0->>'family_name', p_contacts->0->>'given_name'), 40), ''))
  on conflict (openid) do update set org_id = excluded.org_id, role = 'admin', revoked_at = null, bound_at = now();
  insert into public.events (actor, text, ref) values ('depot', 'Société enregistrée par le fournisseur (' || v_profile || ', '
    || case when v_code is not null and p_license_path is not null then 'licence et numéro'
            when v_code is not null then 'numéro' else 'licence' end || '), en attente de validation', v_org);
  return public.depot_identity(p_openid);
end $$;

-- Chemin d'un logo déposé : dans le dossier attendu, « logo-<horodatage>.png|jpg|webp ».
create or replace function app.logo_path_ok(p_path text, p_prefix text) returns boolean
language sql immutable set search_path = '' as $$
  select p_path is not null and left(p_path, length(p_prefix)) = p_prefix and p_path ~ '/logo-[0-9-]+\.(png|jpg|webp)$'
$$;

-- Nom d'un contact : nom de famille puis prénom ; collés en chinois (王 + 伟 = 王伟), séparés par une espace sinon.
create or replace function app.contact_name(p_family text, p_given text) returns text
language sql immutable set search_path = '' as $$
  select case when btrim(coalesce(p_family, '')) ~ '[\u3400-\u9fff]' or btrim(coalesce(p_given, '')) ~ '[\u3400-\u9fff]'
              then btrim(coalesce(p_family, '')) || btrim(coalesce(p_given, ''))
              else btrim(concat_ws(' ', nullif(btrim(coalesce(p_family, '')), ''), nullif(btrim(coalesce(p_given, '')), ''))) end
$$;

-- Ce qui manque encore à la fiche : licence, numéro, région, ville, marques (fabricant, distributeur), site web,
-- WeChat professionnel, logo, coordonnées du contact principal (téléphone, WeChat ou e-mail). Liste vide : fiche complète.
create or replace function app.signup_missing(p_org text) returns text[]
language sql stable security definer set search_path = '' as $$
  select array_remove(array[
    case when o.license_path is null then 'license' end,
    case when o.registration_number is null then 'number' end,
    case when o.registration_region is null then 'region' end,
    case when o.city is null then 'city' end,
    case when app.source_category(o.profile) in ('manufacturer', 'distributor') and o.declared_brands is null
              and not exists (select 1 from public.manufacturer_distributors d where d.org_id = o.id) then 'brands' end,
    case when o.website is null then 'website' end,
    case when o.wecom is null then 'wecom' end,
    case when o.company_logo_path is null then 'logo' end,
    case when not exists (select 1 from public.seller_contacts c where c.org_id = o.id
                           and coalesce(c.phone, c.wechat, c.email) is not null) then 'contact' end], null)
    from public.organizations o where o.id = p_org
$$;

-- Compléter sa fiche depuis /depot/, avant comme après l'approbation (responsable de la fiche). Après l'approbation,
-- le nom, le profil, la licence et le numéro ne changent plus que par l'administrateur (champs ignorés). p : { name?,
-- profile?, code?, region?, city?, brands?, website?, wecom?, logo_path? }. Erreurs : celles du numéro (CP001,
-- CP002), 42501 hors responsable.
create or replace function public.supplier_signup_save(p_openid text, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_org text := app.depot_org(p_openid, true); o public.organizations; v_code text; v_region text; v_profile text;
  v_open boolean;
begin
  select * into o from public.organizations where id = v_org for update;
  v_open := o.kyb <> 'validated';
  if jsonb_typeof(p) <> 'object' then raise exception 'Fiche invalide' using errcode = '22023'; end if;
  v_region := case when p ? 'region' then nullif(upper(btrim(coalesce(p->>'region', ''))), '') else o.registration_region end;
  if v_region is not null and v_region not in ('CN', 'HK', 'OTHER') then v_region := o.registration_region; end if;
  v_code := o.registration_number;
  if v_open and p ? 'code' and nullif(btrim(coalesce(p->>'code', '')), '') is not null then
    v_region := coalesce(v_region, 'CN');
    v_code := case when v_region = 'CN' then upper(btrim(p->>'code')) else upper(regexp_replace(btrim(p->>'code'), '\s+', ' ', 'g')) end;
    if not app.registration_number_ok(v_region, v_code) then raise exception 'Numéro invalide : %', v_code using errcode = 'CP001'; end if;
    if exists (select 1 from public.organizations where upper(registration_number) = v_code and id <> o.id) then
      raise exception 'Société déjà enregistrée' using errcode = 'CP002';
    end if;
  end if;
  v_profile := case when v_open and p->>'profile' in ('Manufacturer', 'Distributor', 'Spot') then p->>'profile' else o.profile end;
  if nullif(p->>'logo_path', '') is not null and not app.logo_path_ok(p->>'logo_path', o.id || '/') then
    raise exception 'Chemin de logo invalide' using errcode = 'CP004', detail = 'logo';
  end if;
  update public.organizations set
    company_logo_path = case when nullif(p->>'logo_path', '') is not null then p->>'logo_path' else company_logo_path end,
    name = case when v_open and nullif(btrim(coalesce(p->>'name', '')), '') is not null then left(btrim(p->>'name'), 120) else name end,
    profile = v_profile,
    registration_number = v_code,
    registration_region = v_region,
    country = case v_region when 'CN' then 'CN' when 'HK' then 'HK' else country end,
    city = coalesce(case when p ? 'city' then nullif(left(btrim(coalesce(p->>'city', '')), 60), '') else city end,
                    case when v_region = 'CN' then app.city_from_code(v_code) end),
    declared_brands = case when p ? 'brands' and app.source_category(v_profile) in ('manufacturer', 'distributor')
                           then app.norm_brands(p->>'brands') else declared_brands end,
    website = case when p ? 'website' then app.norm_website(p->>'website') else website end,
    wecom = case when p ? 'wecom' then nullif(left(btrim(coalesce(p->>'wecom', '')), 100), '') else wecom end
   where id = o.id;
  insert into public.events (actor, text, ref) values ('depot', 'Fiche complétée par le fournisseur', o.id);
  return public.depot_identity(p_openid);
end $$;

-- Licence déposée après l'inscription : avant l'approbation seulement (ensuite, par l'administrateur). Copie de
-- 20261031000007 avec cette règle.
create or replace function public.set_supplier_license(p_org text, p_path text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_path is null or split_part(p_path, '/', 1) <> p_org then raise exception 'Chemin invalide'; end if;
  update public.organizations set license_path = p_path where id = p_org and type = 'seller' and kyb <> 'validated';
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
                   'signup', jsonb_build_object('missing', to_jsonb(app.signup_missing(o.id)), 'city', o.city,
                     'region', o.registration_region, 'brands', o.declared_brands, 'website', o.website, 'wecom', o.wecom,
                     'has_logo', o.company_logo_path is not null),
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
           'logo_path', o.company_logo_path,
           'spot_hint', o.spot_hint,
           'contacts_unlinked', (select count(*) from public.seller_contacts c where c.org_id = o.id
              and not exists (select 1 from public.wechat_identities w where w.org_id = c.org_id and w.revoked_at is null
                               and (w.openid = c.openid or (c.openid is null and btrim(coalesce(w.label, '')) <> '' and w.label = c.name)))),
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
  -- Une seule pièce fournie : inscrit au journal de la décision (ADR 0034, risque « contrôle plus faible »).
  insert into public.supplier_decisions (org_id, action, from_status, reason, decided_by)
  values (p_org, 'approved', o.kyb, case app.verification_piece(o) when 'license' then 'pièce unique : licence'
                                                                 when 'number' then 'pièce unique : numéro' end, p_by);
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
    'brands', o.declared_brands, 'has_auth_letter', o.auth_letter_path is not null, 'logo_path', o.company_logo_path,
    'region', o.registration_region, 'city', o.city, 'status', o.kyb,
    'website', o.website, 'wecom', o.wecom, 'missing', to_jsonb(app.signup_missing(o.id)), 'spot_hint', o.spot_hint,
    'links', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'role', d.role) order by m.name)
        from public.manufacturer_distributors d join public.manufacturers m on m.id = d.manufacturer_id where d.org_id = o.id), '[]'),
    'brand_matches', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'brands', to_jsonb(m.brands)) order by m.name)
        from public.manufacturers m
       where exists (select 1 from unnest(m.brands) b, regexp_split_to_table(coalesce(o.declared_brands, ''), '\s*,\s*') x
                      where btrim(x) <> '' and upper(btrim(b)) = upper(btrim(x)))
         and not exists (select 1 from public.manufacturer_distributors d where d.org_id = o.id and d.manufacturer_id = m.id)), '[]'),
    'contacts', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'duty', c.duty, 'role', c.role,
        'phone', c.phone, 'wechat', c.wechat, 'email', c.email, 'linked', app.contact_linked(c)) order by c.duty = 'main' desc, c.created_at)
        from public.seller_contacts c where c.org_id = o.id), '[]'),
    'spot_pending', o.profile = 'Spot' and o.kyb <> 'validated');
end $$;

-- Contact relié au robot WeChat : son compte est lié à la société (contact principal : openid de l'inscription ;
-- autre contact : invitation acceptée sous son nom, wechat_identities.label). Sinon il ne reçoit rien.
create or replace function app.contact_linked(c public.seller_contacts) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.wechat_identities w where w.org_id = c.org_id and w.revoked_at is null
                  and (w.openid = c.openid or (c.openid is null and btrim(coalesce(w.label, '')) <> '' and w.label = c.name)))
$$;

-- Liste des fournisseurs du back office : copie de 20261102000014, avec ce qui manque à la fiche (« complète »).
create or replace function public.admin_suppliers(p_status text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_admin();
  return jsonb_build_object(
    'counts', (select jsonb_object_agg(k, n) from (select kyb as k, count(*) as n from public.organizations
                where type = 'seller' group by kyb) c),
    'rows', (select coalesce(jsonb_agg(jsonb_build_object(
        'org_id', o.id, 'name', o.name, 'alias', o.alias, 'region', app.region_of(o), 'code', o.registration_number,
        'city', o.city, 'profile', o.profile, 'currency', o.currency, 'status', o.kyb,
        'requested_at', o.created_at, 'decided_at', o.kyb_decided_at, 'missing', to_jsonb(app.signup_missing(o.id)),
        'lines', (select count(*) from public.lots l where l.seller_id = o.id and l.qty > 0))
        order by o.created_at desc, o.id desc), '[]'::jsonb)
      from public.organizations o
     where o.type = 'seller' and (p_status is null or o.kyb = p_status)));
end $$;

-- Message d'accueil : catégorie et rattachements au moment de l'approbation (fonctions Edge, clé de service).
create or replace function public.supplier_welcome(p_org text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('org_id', o.id, 'alias', o.alias, 'category', app.source_category(o.profile),
    'links', coalesce((select jsonb_agg(m.name order by m.name) from public.manufacturer_distributors d
                         join public.manufacturers m on m.id = d.manufacturer_id where d.org_id = o.id), '[]'::jsonb))
    from public.organizations o where o.id = p_org
$$;

-- Copie de 20261106000035 : fiche de la société dans /depot/, avec le WeChat professionnel et, pour chaque contact,
-- son rôle et s'il est relié au robot (pour lui transmettre une invitation sinon).
create or replace function public.supplier_company(p_openid text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org text := app.depot_org(p_openid, false); o public.organizations;
begin
  select * into o from public.organizations where id = v_org;
  return jsonb_build_object('org_id', o.id, 'name', o.name,
    'can_edit', app.org_editor(o.id) = p_openid,
    'founded_year', o.founded_year, 'website', o.website, 'wecom', o.wecom, 'about', o.about, 'hq_city', o.hq_city, 'staff', o.staff,
    'certifications', to_jsonb(o.certifications), 'languages', to_jsonb(o.languages),
    'payment_methods', to_jsonb(o.payment_methods), 'payment_terms', o.payment_terms, 'min_order_usd', o.min_order_usd,
    'contacts', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'role', c.role, 'email', c.email,
        'phone', c.phone, 'wechat', c.wechat, 'languages', to_jsonb(c.languages), 'for_rfq', c.for_rfq, 'for_po', c.for_po,
        'duty', c.duty, 'linked', app.contact_linked(c))
        order by c.duty = 'main' desc, c.created_at) from public.seller_contacts c where c.org_id = o.id), '[]'),
    'manufacturers', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'brands', to_jsonb(m.brands),
        'role', d.role, 'consent_at', d.consent_at, 'public_page', m.public_page, 'logo_path', m.logo_path,
        'about', m.about, 'positioning', m.positioning, 'founded_year', m.founded_year, 'hq_city', m.hq_city,
        'production_site', m.production_site, 'area_m2', m.area_m2, 'staff', m.staff, 'annual_units', m.annual_units,
        'certifications', to_jsonb(m.certifications), 'languages', to_jsonb(m.languages),
        'pending', exists (select 1 from public.manufacturer_proposals r where r.manufacturer_id = m.id and r.org_id = o.id and r.status = 'pending'))
        order by m.name)
        from public.manufacturer_distributors d join public.manufacturers m on m.id = d.manufacturer_id where d.org_id = o.id), '[]'));
end $$;

-- ------------------------------------------------------------ droits
revoke execute on function app.pending_doc_prefix(text), app.verification_piece(public.organizations), app.norm_website(text),
  app.contact_name(text, text), app.signup_missing(text), app.contact_linked(public.seller_contacts), app.norm_brands(text),
  app.city_from_code(text), app.logo_path_ok(text, text) from public, anon, authenticated;
revoke execute on function public.register_supplier(text, text, text, text, text, text, text, text, text, text, text, text, jsonb, text, text),
  public.approve_supplier(text, text, text), public.supplier_welcome(text), public.supplier_signup_save(text, jsonb) from public, anon, authenticated;
grant execute on function public.register_supplier(text, text, text, text, text, text, text, text, text, text, text, text, jsonb, text, text),
  public.approve_supplier(text, text, text), public.supplier_welcome(text), public.supplier_signup_save(text, jsonb) to service_role;
revoke execute on function public.admin_approve(text, text), public.admin_supplier_complete(text, jsonb),
  public.admin_supplier_signup(text) from public, anon;
grant execute on function public.admin_approve(text, text), public.admin_supplier_complete(text, jsonb),
  public.admin_supplier_signup(text) to authenticated, service_role;
