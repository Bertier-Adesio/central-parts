-- Fabricants et distributeurs (décision de Bertier, 5 novembre 2026 : « dans le back office un (ou plusieurs)
-- fabricant peut être attaché à un distributeur ; un fabricant peut se distribuer soi-même »). ADR 0032, complément.
--
-- Le fabricant devient une fiche à part (public.manufacturers) : nom, marques, présentation, chiffres, logo et page
-- publique /fabricants/. Il est rattaché aux comptes fournisseurs qui vendent ses marques (manufacturer_distributors) :
--   role « self »       : le compte est le fabricant lui-même (« Direct fabricant » sur ses offres) ;
--   role « authorized » : le compte est son distributeur agréé (« Distributeur agréé »).
-- Un distributeur peut porter plusieurs fabricants ; un fabricant peut avoir plusieurs distributeurs.
-- Ces fabricants sont distribués en Europe par Central.Parts (décision de Bertier) : la mention ne vaut que pour les
-- offres de leur canal officiel ; un revendeur, un broker ou un excédent de stock ne peut pas être rattaché.
-- La fiche société d'un compte (20261105000032) garde sa présentation, ses chiffres, son paiement et ses contacts, à
-- usage interne ; ses champs de page publique (marques, logo, publication) passent sur la fiche du fabricant.
-- Remplace admin_supplier_profile, admin_supplier_profile_save, partner_offers et public_manufacturer
-- (20261105000032), recopiées ou réécrites. Rejouable.

create sequence if not exists app.manufacturer_seq start 1;
create table if not exists public.manufacturers (
  id              text primary key default app.ref('MFR', 'app.manufacturer_seq'),
  name            text not null check (btrim(name) <> ''),     -- nom affiché sur la page publique
  brands          text[] not null default '{}',                -- marques, telles qu'écrites dans la colonne fabricant
  about           jsonb not null default '{}',                 -- {fr, en, zh}
  positioning     jsonb not null default '{}',
  founded_year    int check (founded_year between 1800 and 2100),
  website         text,                                        -- interne : jamais publié
  hq_city         text,
  production_site text,
  area_m2         int check (area_m2 > 0),
  staff           int check (staff > 0),
  annual_units    bigint check (annual_units > 0),
  revenue_usd     numeric check (revenue_usd > 0),             -- interne : jamais publié
  certifications  text[] not null default '{}',
  languages       text[] not null default '{}',
  logo_path       text,                                        -- compartiment public seller-logos, dossier MFR-…
  public_page     boolean not null default false,
  public_page_by  text,
  public_page_at  timestamptz,
  created_at      timestamptz not null default now()
);
create table if not exists public.manufacturer_distributors (
  manufacturer_id text not null references public.manufacturers on delete cascade,
  org_id          text not null references public.organizations on delete cascade,
  role            text not null check (role in ('self', 'authorized')),
  created_by      text,
  created_at      timestamptz not null default now(),
  primary key (manufacturer_id, org_id)
);
create unique index if not exists manufacturer_self_idx on public.manufacturer_distributors (manufacturer_id) where role = 'self';
create index if not exists manufacturer_distributors_org_idx on public.manufacturer_distributors (org_id);
alter table public.manufacturers enable row level security;
alter table public.manufacturer_distributors enable row level security;
revoke all on public.manufacturers, public.manufacturer_distributors from anon, authenticated;
grant usage on sequence app.manufacturer_seq to service_role;

-- Reprise des fiches saisies avec 20261105000032 : chaque société qui déclarait des marques devient un fabricant,
-- rattaché à elle (« self », ou « authorized » si elle s'était déclarée distributeur agréé). Page publique remise à
-- non publiée : à vérifier puis republier depuis l'onglet Fabricants.
do $$
declare has_role boolean := exists (select 1 from information_schema.columns
  where table_schema = 'public' and table_name = 'organizations' and column_name = 'brand_role');
  has_brands boolean := exists (select 1 from information_schema.columns
  where table_schema = 'public' and table_name = 'organizations' and column_name = 'brands');
  r record; v_id text;
begin
  if not has_brands then return; end if;
  for r in execute 'select id, brands, about, positioning, founded_year, website, hq_city, production_site, area_m2, staff,
      annual_units, revenue_usd, certifications, languages, logo_path, '
      || case when has_role then 'coalesce(brand_name, brands[1]) as mname, brand_role' else 'brands[1] as mname, null::text as brand_role' end
      || ' from public.organizations where cardinality(brands) > 0'
  loop
    if exists (select 1 from public.manufacturer_distributors where org_id = r.id) then continue; end if;
    insert into public.manufacturers (name, brands, about, positioning, founded_year, website, hq_city, production_site,
      area_m2, staff, annual_units, revenue_usd, certifications, languages, logo_path)
    values (r.mname, r.brands, r.about, r.positioning, r.founded_year, r.website, r.hq_city, r.production_site,
      r.area_m2, r.staff, r.annual_units, r.revenue_usd, r.certifications, r.languages, r.logo_path)
    returning id into v_id;
    insert into public.manufacturer_distributors (manufacturer_id, org_id, role, created_by)
    values (v_id, r.id, case when r.brand_role = 'authorized_distributor' then 'authorized' else 'self' end, 'migration');
  end loop;
end $$;

-- Fabricant d'une marque (insensible à la casse ; une marque appartient à un seul fabricant).
create or replace function app.brand_manufacturer(p_brand text) returns text
language sql stable security definer set search_path = '' as $$
  select m.id from public.manufacturers m
   where upper(btrim(coalesce(p_brand, ''))) = any (select upper(b) from unnest(m.brands) b)
   order by m.created_at limit 1
$$;
revoke execute on function app.brand_manufacturer(text) from public, anon, authenticated;
grant execute on function app.brand_manufacturer(text) to service_role;

create or replace function public.admin_supplier_profile(p_org text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare o public.organizations;
begin
  perform app.require_admin();
  select * into o from public.organizations where id = upper(btrim(coalesce(p_org, ''))) and type = 'seller';
  if o.id is null then raise exception 'Fournisseur inconnu : %', p_org using errcode = 'P0002'; end if;
  return jsonb_build_object('org_id', o.id, 'founded_year', o.founded_year, 'website', o.website, 'about', o.about,
    'positioning', o.positioning, 'hq_city', o.hq_city, 'production_site', o.production_site, 'area_m2', o.area_m2,
    'staff', o.staff, 'annual_units', o.annual_units, 'revenue_usd', o.revenue_usd, 'certifications', to_jsonb(o.certifications),
    'languages', to_jsonb(o.languages), 'payment_methods', to_jsonb(o.payment_methods), 'payment_terms', o.payment_terms,
    'min_order_usd', o.min_order_usd,
    'manufacturers', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'brands', to_jsonb(m.brands),
        'role', d.role, 'public_page', m.public_page) order by m.name)
        from public.manufacturer_distributors d join public.manufacturers m on m.id = d.manufacturer_id where d.org_id = o.id), '[]'),
    'contacts', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'address_id', c.address_id, 'name', c.name, 'role', c.role,
        'email', c.email, 'phone', c.phone, 'wechat', c.wechat, 'languages', to_jsonb(c.languages), 'for_rfq', c.for_rfq, 'for_po', c.for_po)
        order by c.created_at) from public.seller_contacts c where c.org_id = o.id), '[]'));
end $$;

create or replace function public.admin_supplier_profile_save(p_org text, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_by text := app.require_admin(); v_org text := upper(btrim(coalesce(p_org, '')));
  txt constant text[] := array['website', 'hq_city', 'production_site', 'payment_terms'];
  k text;
begin
  if not exists (select 1 from public.organizations where id = v_org and type = 'seller') then
    raise exception 'Fournisseur inconnu : %', p_org using errcode = 'P0002';
  end if;
  if jsonb_typeof(p) <> 'object' then raise exception 'Fiche invalide' using errcode = '22023'; end if;
  if p ? 'website' and nullif(btrim(p->>'website'), '') is not null and p->>'website' !~ '^https?://' then
    raise exception 'Site web : adresse http(s) attendue' using errcode = '22023';
  end if;
  begin
    foreach k in array txt loop
      if p ? k then execute format('update public.organizations set %I = $1 where id = $2', k) using left(nullif(btrim(p->>k), ''), 300), v_org; end if;
    end loop;
    update public.organizations set
      founded_year    = case when p ? 'founded_year' then nullif(p->>'founded_year', '')::int else founded_year end,
      area_m2         = case when p ? 'area_m2' then nullif(p->>'area_m2', '')::int else area_m2 end,
      staff           = case when p ? 'staff' then nullif(p->>'staff', '')::int else staff end,
      annual_units    = case when p ? 'annual_units' then nullif(p->>'annual_units', '')::bigint else annual_units end,
      revenue_usd     = case when p ? 'revenue_usd' then nullif(p->>'revenue_usd', '')::numeric else revenue_usd end,
      min_order_usd   = case when p ? 'min_order_usd' then nullif(p->>'min_order_usd', '')::numeric else min_order_usd end,
      about           = case when p ? 'about' then app.tri_text(p->'about') else about end,
      positioning     = case when p ? 'positioning' then app.tri_text(p->'positioning') else positioning end,
      certifications  = case when p ? 'certifications' then app.short_list(p->'certifications') else certifications end,
      languages       = case when p ? 'languages' then app.short_list(p->'languages') else languages end,
      payment_methods = case when p ? 'payment_methods' then app.short_list(p->'payment_methods') else payment_methods end
     where id = v_org;
  exception when invalid_text_representation or numeric_value_out_of_range or check_violation then
    raise exception 'Valeur invalide : %', sqlerrm using errcode = '22023';
  end;
  insert into public.events (actor, text, ref) values ('ops', 'Fiche société modifiée par ' || v_by, v_org);
  return public.admin_supplier_profile(v_org);
end $$;

create or replace function public.partner_offers(p_ip text, q text default '', p_currency text default 'EUR')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  k text := upper(regexp_replace(coalesce(q, ''), '\s+', '', 'g'));
  cur text := case when upper(p_currency) in (select code from public.currencies) then upper(p_currency) else 'EUR' end;
begin
  if length(k) between 1 and 2 then raise exception 'Saisir au moins 3 caractères' using errcode = '22023'; end if;
  perform app.count_search(p_ip);
  return (
    with picked as (
      select l.*, o.profile, o.country, app.lot_place(l.id) as place
        from public.lots l
        join public.organizations o on o.id = l.seller_id
       where (k = '' or upper(l.mpn) like k || '%') and l.qty > 0 and l.confirmed_at > now() - app.org_ttl(o.offer_ttl_days, o.profile)
         and app.is_verified(l.seller_id) and not o.sandbox
       order by l.confirmed_at desc
       limit 50)
    select jsonb_build_object('query', k, 'currency', cur, 'ttl_days', extract(day from app.offer_ttl())::int,
      'ttl_days_manufacturer', extract(day from app.org_ttl(null, 'Manufacturer'))::int,
      'rates_at', (select min(c.rate_at) from public.currencies c where c.code in (select currency from picked) and c.code <> cur),
      'offers', (select coalesce(jsonb_agg(jsonb_build_object(
               'mpn', upper(p.mpn),
               'manufacturer', p.manufacturer,
               'brand_page', case when bm.public_page then (select b from unnest(bm.brands) b where upper(b) = upper(btrim(p.manufacturer)) limit 1) end,
               -- Canal officiel (distribution en Europe par Central.Parts) : fabricant ou distributeur rattaché, jamais
               -- un revendeur, un broker ni un excédent de stock, même s'il vend la même marque.
               'factory_direct', coalesce(bd.role = 'self', false) and app.source_category(p.profile) in ('manufacturer', 'distributor'),
               'authorized_distributor', coalesce(bd.role = 'authorized', false) and app.source_category(p.profile) in ('manufacturer', 'distributor'),
               'supplier', 'partner',
               'seller_category', null,
               'source', app.source_category(p.profile),
               'ship_from', p.country, 'incoterm', coalesce(app.terms_json(p.seller_id, cur)->>'incoterm', 'FCA'), 'fca_place', p.place,
               'terms', app.terms_json(p.seller_id, cur),
               'currency', cur,
               'availability', app.qty_band(p.qty),
               'moq', p.moq, 'spq', p.standard_pack_quantity,
               'min_qty', app.lot_min_qty(p.moq, p.standard_pack_quantity),
               'price_from', round(least(p.unit_price, (select min(b.unit_price) from public.lot_price_breaks b where b.lot_id = p.id))
                                   * app.fx(p.currency, cur) * (1 + app.offer_margin(p.seller_id) / 100), 4),
               'price_1k', round(case when coalesce(p.moq, 1) <= 1000 then app.lot_price_for(p.id, 1000) end
                                 * app.fx(p.currency, cur) * (1 + app.offer_margin(p.seller_id) / 100), 4),
               'updated_at', p.confirmed_at) order by upper(p.mpn), p.confirmed_at desc), '[]') from picked p left join public.manufacturers bm on bm.id = app.brand_manufacturer(p.manufacturer)
        left join public.manufacturer_distributors bd on bd.manufacturer_id = bm.id and bd.org_id = p.seller_id)));
end $$;

drop function if exists public.admin_supplier_publish(text, boolean);
drop function if exists app.brand_org(text);
alter table public.organizations drop column if exists brands, drop column if exists logo_path,
  drop column if exists public_page, drop column if exists public_page_by, drop column if exists public_page_at,
  drop column if exists brand_name, drop column if exists brand_role;

-- ------------------------------------------------------------ fabricants (back office)
create or replace function app.manufacturer_json(p_id text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', m.id, 'name', m.name, 'brands', to_jsonb(m.brands), 'about', m.about, 'positioning', m.positioning,
    'founded_year', m.founded_year, 'website', m.website, 'hq_city', m.hq_city, 'production_site', m.production_site,
    'area_m2', m.area_m2, 'staff', m.staff, 'annual_units', m.annual_units, 'revenue_usd', m.revenue_usd,
    'certifications', to_jsonb(m.certifications), 'languages', to_jsonb(m.languages), 'logo_path', m.logo_path,
    'public_page', m.public_page, 'public_page_by', m.public_page_by, 'public_page_at', m.public_page_at,
    'can_publish', cardinality(m.brands) > 0 and m.about <> '{}',
    'distributors', coalesce((select jsonb_agg(jsonb_build_object('org_id', o.id, 'name', o.name, 'alias', o.alias, 'role', d.role,
        'status', o.kyb, 'offers', (select count(*) from public.lots l where l.seller_id = o.id and l.qty > 0
          and upper(btrim(l.manufacturer)) = any (select upper(b) from unnest(m.brands) b)))
        order by d.role desc, o.name) from public.manufacturer_distributors d join public.organizations o on o.id = d.org_id
        where d.manufacturer_id = m.id), '[]'))
    from public.manufacturers m where m.id = p_id
$$;
revoke execute on function app.manufacturer_json(text) from public, anon, authenticated;

create or replace function public.admin_manufacturers()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_admin();
  return coalesce((select jsonb_agg(app.manufacturer_json(m.id) order by m.name) from public.manufacturers m), '[]');
end $$;

create or replace function public.admin_manufacturer(p_id text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare r jsonb;
begin
  perform app.require_admin();
  r := app.manufacturer_json(upper(btrim(coalesce(p_id, ''))));
  if r is null then raise exception 'Fabricant inconnu : %', p_id using errcode = 'P0002'; end if;
  return r;
end $$;

-- Crée (sans id) ou modifie un fabricant. Une clé absente garde sa valeur ; null ou chaîne vide l'efface.
create or replace function public.admin_manufacturer_save(p_id text, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_by text := app.require_admin(); v_id text := nullif(upper(btrim(coalesce(p_id, ''))), '');
  txt constant text[] := array['website', 'hq_city', 'production_site', 'logo_path'];
  k text; v_brands text[];
begin
  if jsonb_typeof(p) <> 'object' then raise exception 'Fiche invalide' using errcode = '22023'; end if;
  if v_id is not null and not exists (select 1 from public.manufacturers where id = v_id) then
    raise exception 'Fabricant inconnu : %', p_id using errcode = 'P0002';
  end if;
  if p ? 'website' and nullif(btrim(p->>'website'), '') is not null and p->>'website' !~ '^https?://' then
    raise exception 'Site web : adresse http(s) attendue' using errcode = '22023';
  end if;
  if v_id is not null and p ? 'logo_path' and nullif(btrim(p->>'logo_path'), '') is not null and p->>'logo_path' !~ ('^' || v_id || '/[A-Za-z0-9._-]+$') then
    raise exception 'Logo : chemin invalide' using errcode = '22023';
  end if;
  if p ? 'brands' then
    v_brands := app.short_list(p->'brands');
    if exists (select 1 from public.manufacturers m, unnest(m.brands) b
                where m.id is distinct from v_id and upper(b) in (select upper(x) from unnest(v_brands) x)) then
      raise exception 'Marque déjà attribuée à un autre fabricant' using errcode = '22023';
    end if;
  end if;
  begin
    if v_id is null then
      insert into public.manufacturers (name) values (btrim(coalesce(p->>'name', ''))) returning id into v_id;
    elsif p ? 'name' then
      update public.manufacturers set name = btrim(coalesce(p->>'name', '')) where id = v_id;
    end if;
    foreach k in array txt loop
      if p ? k then execute format('update public.manufacturers set %I = $1 where id = $2', k) using left(nullif(btrim(p->>k), ''), 300), v_id; end if;
    end loop;
    update public.manufacturers set
      founded_year   = case when p ? 'founded_year' then nullif(p->>'founded_year', '')::int else founded_year end,
      area_m2        = case when p ? 'area_m2' then nullif(p->>'area_m2', '')::int else area_m2 end,
      staff          = case when p ? 'staff' then nullif(p->>'staff', '')::int else staff end,
      annual_units   = case when p ? 'annual_units' then nullif(p->>'annual_units', '')::bigint else annual_units end,
      revenue_usd    = case when p ? 'revenue_usd' then nullif(p->>'revenue_usd', '')::numeric else revenue_usd end,
      about          = case when p ? 'about' then app.tri_text(p->'about') else about end,
      positioning    = case when p ? 'positioning' then app.tri_text(p->'positioning') else positioning end,
      certifications = case when p ? 'certifications' then app.short_list(p->'certifications') else certifications end,
      languages      = case when p ? 'languages' then app.short_list(p->'languages') else languages end,
      brands         = coalesce(v_brands, brands)
     where id = v_id;
  exception when invalid_text_representation or numeric_value_out_of_range or check_violation then
    raise exception 'Valeur invalide : %', sqlerrm using errcode = '22023';
  end;
  -- Une page sans marque ni présentation n'a plus de sens : elle est retirée.
  update public.manufacturers set public_page = false where id = v_id and public_page and (cardinality(brands) = 0 or about = '{}');
  insert into public.events (actor, text, ref) values ('ops', 'Fiche fabricant modifiée par ' || v_by, v_id);
  return app.manufacturer_json(v_id);
end $$;

-- Rattache un compte fournisseur à un fabricant : « self » (le fabricant lui-même, un seul) ou « authorized ».
create or replace function public.admin_manufacturer_link(p_id text, p_org text, p_role text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_by text := app.require_admin(); v_id text := upper(btrim(coalesce(p_id, ''))); v_org text := upper(btrim(coalesce(p_org, '')));
begin
  if not exists (select 1 from public.manufacturers where id = v_id) then raise exception 'Fabricant inconnu : %', p_id using errcode = 'P0002'; end if;
  if not exists (select 1 from public.organizations where id = v_org and type = 'seller') then
    raise exception 'Fournisseur inconnu : %', p_org using errcode = 'P0002';
  end if;
  -- Canal officiel seulement : fabricant ou distributeur. Jamais un revendeur, un broker ni un excédent de stock.
  if (select app.source_category(profile) from public.organizations where id = v_org) not in ('manufacturer', 'distributor') then
    raise exception 'Seul un fabricant ou un distributeur peut être rattaché (pas un revendeur, broker ou excédent)' using errcode = '22023';
  end if;
  if coalesce(p_role, '') not in ('self', 'authorized') then raise exception 'Rôle : self ou authorized' using errcode = '22023'; end if;
  if p_role = 'self' and exists (select 1 from public.manufacturer_distributors where manufacturer_id = v_id and role = 'self' and org_id <> v_org) then
    raise exception 'Ce fabricant a déjà un compte « fabricant lui-même »' using errcode = '22023';
  end if;
  insert into public.manufacturer_distributors (manufacturer_id, org_id, role, created_by) values (v_id, v_org, p_role, v_by)
  on conflict (manufacturer_id, org_id) do update set role = excluded.role, created_by = excluded.created_by, created_at = now();
  insert into public.events (actor, text, ref)
  values ('ops', v_org || case when p_role = 'self' then ' rattaché comme fabricant lui-même par ' else ' rattaché comme distributeur agréé par ' end || v_by, v_id);
  return app.manufacturer_json(v_id);
end $$;

create or replace function public.admin_manufacturer_unlink(p_id text, p_org text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_by text := app.require_admin(); v_id text := upper(btrim(coalesce(p_id, ''))); v_org text := upper(btrim(coalesce(p_org, '')));
begin
  delete from public.manufacturer_distributors where manufacturer_id = v_id and org_id = v_org;
  if not found then raise exception 'Rattachement inconnu' using errcode = 'P0002'; end if;
  insert into public.events (actor, text, ref) values ('ops', v_org || ' détaché par ' || v_by, v_id);
  return app.manufacturer_json(v_id);
end $$;

-- Publie ou retire la page publique. Publication : au moins une marque et une présentation.
create or replace function public.admin_manufacturer_publish(p_id text, p_on boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_by text := app.require_admin(); m public.manufacturers;
begin
  select * into m from public.manufacturers where id = upper(btrim(coalesce(p_id, '')));
  if m.id is null then raise exception 'Fabricant inconnu : %', p_id using errcode = 'P0002'; end if;
  if p_on and (cardinality(m.brands) = 0 or m.about = '{}') then
    raise exception 'Page publique : marque et présentation requises' using errcode = '22023';
  end if;
  update public.manufacturers set public_page = p_on, public_page_by = v_by, public_page_at = now() where id = m.id;
  insert into public.events (actor, text, ref)
  values ('ops', case when p_on then 'Page fabricant publiée par ' else 'Page fabricant retirée par ' end || v_by, m.id);
  return app.manufacturer_json(m.id);
end $$;

-- ------------------------------------------------------------ page publique
-- Présentation du fabricant seulement. Jamais : contacts, site web, chiffre d'affaires, identifiants, ni nom ou
-- pseudonyme des distributeurs. Offres : en ligne chez ses comptes rattachés, par canal (fabricant, distributeur agréé).
create or replace function public.public_manufacturer(p_ip text, p_brand text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare m public.manufacturers;
begin
  perform app.count_search(p_ip);
  select * into m from public.manufacturers where id = app.brand_manufacturer(p_brand) and public_page;
  if m.id is null then return null; end if;
  return jsonb_build_object('brand', (select b from unnest(m.brands) b where upper(b) = upper(btrim(p_brand)) limit 1),
    'brands', to_jsonb(m.brands), 'name', m.name, 'logo_path', m.logo_path, 'founded_year', m.founded_year,
    'about', m.about, 'positioning', m.positioning, 'hq_city', m.hq_city, 'production_site', m.production_site,
    'area_m2', m.area_m2, 'staff', m.staff, 'annual_units', m.annual_units,
    'certifications', to_jsonb(m.certifications), 'languages', to_jsonb(m.languages),
    'offers_direct', (select count(*) from public.lots l join public.manufacturer_distributors d on d.org_id = l.seller_id and d.manufacturer_id = m.id
        join public.organizations o on o.id = l.seller_id
       where d.role = 'self' and l.qty > 0 and app.is_verified(o.id) and not o.sandbox
         and l.confirmed_at > now() - app.org_ttl(o.offer_ttl_days, o.profile)
         and upper(btrim(l.manufacturer)) = any (select upper(b) from unnest(m.brands) b))::int,
    'offers_authorized', (select count(*) from public.lots l join public.manufacturer_distributors d on d.org_id = l.seller_id and d.manufacturer_id = m.id
        join public.organizations o on o.id = l.seller_id
       where d.role = 'authorized' and l.qty > 0 and app.is_verified(o.id) and not o.sandbox
         and l.confirmed_at > now() - app.org_ttl(o.offer_ttl_days, o.profile)
         and upper(btrim(l.manufacturer)) = any (select upper(b) from unnest(m.brands) b))::int,
    'updated_at', m.public_page_at);
end $$;

do $$
declare f text;
begin
  foreach f in array array['public.admin_manufacturers()', 'public.admin_manufacturer(text)', 'public.admin_manufacturer_save(text, jsonb)',
    'public.admin_manufacturer_link(text, text, text)', 'public.admin_manufacturer_unlink(text, text)', 'public.admin_manufacturer_publish(text, boolean)']
  loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;
revoke execute on function public.public_manufacturer(text, text) from public, anon, authenticated;
grant execute on function public.public_manufacturer(text, text) to service_role;
