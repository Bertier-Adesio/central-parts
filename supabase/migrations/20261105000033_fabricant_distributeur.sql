-- Fabricant distribué par un distributeur agréé (décision de Bertier, 5 novembre 2026 : le stock d'un fabricant est
-- déposé par son distributeur). ADR 0032, complément.
--
-- Le compte qui dépose le stock n'est pas toujours le fabricant : un distributeur agréé dépose les offres d'une marque
-- et la page publique présente le fabricant. Deux champs :
--   brand_name : nom du fabricant affiché sur la page publique (jamais le nom de la société du compte) ;
--   brand_role : « manufacturer » (le compte est le fabricant : « Direct fabricant ») ou « authorized_distributor »
--                (distributeur agréé de la marque : « Distributeur agréé » sur ses offres).
-- Remplace admin_supplier_profile, admin_supplier_profile_save, admin_supplier_publish, public_manufacturer et
-- partner_offers (20261105000032), recopiées. Rejouable.

alter table public.organizations
  add column if not exists brand_name text,
  add column if not exists brand_role text not null default 'manufacturer'
    check (brand_role in ('manufacturer', 'authorized_distributor'));

-- Une page déjà publiée sans nom de fabricant afficherait le nom du compte : elle est retirée.
update public.organizations set public_page = false where public_page and brand_name is null;

create or replace function public.admin_supplier_profile(p_org text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare o public.organizations;
begin
  perform app.require_admin();
  select * into o from public.organizations where id = upper(btrim(coalesce(p_org, ''))) and type = 'seller';
  if o.id is null then raise exception 'Fournisseur inconnu : %', p_org using errcode = 'P0002'; end if;
  return jsonb_build_object('org_id', o.id, 'brand_name', o.brand_name, 'brand_role', o.brand_role, 'founded_year', o.founded_year, 'website', o.website, 'about', o.about,
    'positioning', o.positioning, 'hq_city', o.hq_city, 'production_site', o.production_site, 'area_m2', o.area_m2,
    'staff', o.staff, 'annual_units', o.annual_units, 'revenue_usd', o.revenue_usd, 'certifications', to_jsonb(o.certifications),
    'languages', to_jsonb(o.languages), 'payment_methods', to_jsonb(o.payment_methods), 'payment_terms', o.payment_terms,
    'min_order_usd', o.min_order_usd, 'brands', to_jsonb(o.brands), 'logo_path', o.logo_path,
    'public_page', o.public_page, 'public_page_by', o.public_page_by, 'public_page_at', o.public_page_at,
    'can_publish', o.kyb = 'validated' and cardinality(o.brands) > 0 and o.about <> '{}' and o.brand_name is not null,
    'contacts', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'address_id', c.address_id, 'name', c.name, 'role', c.role,
        'email', c.email, 'phone', c.phone, 'wechat', c.wechat, 'languages', to_jsonb(c.languages), 'for_rfq', c.for_rfq, 'for_po', c.for_po)
        order by c.created_at) from public.seller_contacts c where c.org_id = o.id), '[]'));
end $$;

create or replace function public.admin_supplier_profile_save(p_org text, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_by text := app.require_admin(); v_org text := upper(btrim(coalesce(p_org, '')));
  txt constant text[] := array['brand_name', 'website', 'hq_city', 'production_site', 'payment_terms', 'logo_path'];
  k text;
begin
  if not exists (select 1 from public.organizations where id = v_org and type = 'seller') then
    raise exception 'Fournisseur inconnu : %', p_org using errcode = 'P0002';
  end if;
  if jsonb_typeof(p) <> 'object' then raise exception 'Fiche invalide' using errcode = '22023'; end if;
  if p ? 'website' and nullif(btrim(p->>'website'), '') is not null and p->>'website' !~ '^https?://' then
    raise exception 'Site web : adresse http(s) attendue' using errcode = '22023';
  end if;
  if p ? 'logo_path' and nullif(btrim(p->>'logo_path'), '') is not null and p->>'logo_path' !~ ('^' || v_org || '/[A-Za-z0-9._-]+$') then
    raise exception 'Logo : chemin invalide' using errcode = '22023';
  end if;
  if p ? 'brand_role' and coalesce(p->>'brand_role', '') not in ('manufacturer', 'authorized_distributor') then
    raise exception 'Rôle : fabricant ou distributeur agréé' using errcode = '22023';
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
      payment_methods = case when p ? 'payment_methods' then app.short_list(p->'payment_methods') else payment_methods end,
      brands          = case when p ? 'brands' then app.short_list(p->'brands') else brands end,
      brand_role      = case when p ? 'brand_role' then p->>'brand_role' else brand_role end
     where id = v_org;
  exception when invalid_text_representation or numeric_value_out_of_range or check_violation then
    raise exception 'Valeur invalide : %', sqlerrm using errcode = '22023';
  end;
  -- Une page publique sans marque, nom du fabricant ni présentation n'a plus de sens : elle est retirée.
  update public.organizations set public_page = false
   where id = v_org and public_page and (cardinality(brands) = 0 or about = '{}' or brand_name is null);
  insert into public.events (actor, text, ref) values ('ops', 'Fiche société modifiée par ' || v_by, v_org);
  return public.admin_supplier_profile(v_org);
end $$;

create or replace function public.admin_supplier_publish(p_org text, p_on boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_by text := app.require_admin(); o public.organizations;
begin
  select * into o from public.organizations where id = upper(btrim(coalesce(p_org, ''))) and type = 'seller';
  if o.id is null then raise exception 'Fournisseur inconnu : %', p_org using errcode = 'P0002'; end if;
  if p_on and (o.kyb <> 'validated' or cardinality(o.brands) = 0 or o.about = '{}' or o.brand_name is null) then
    raise exception 'Page publique : société approuvée, marque, nom du fabricant et présentation requis' using errcode = '22023';
  end if;
  update public.organizations set public_page = p_on, public_page_by = v_by, public_page_at = now() where id = o.id;
  insert into public.events (actor, text, ref)
  values ('ops', case when p_on then 'Page fabricant publiée par ' else 'Page fabricant retirée par ' end || v_by, o.id);
  return public.admin_supplier_profile(o.id);
end $$;

create or replace function public.public_manufacturer(p_ip text, p_brand text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_org text; o public.organizations;
begin
  perform app.count_search(p_ip);
  v_org := app.brand_org(p_brand);
  if v_org is null then return null; end if;
  select * into o from public.organizations where id = v_org;
  return jsonb_build_object('brand', (select b from unnest(o.brands) b where upper(b) = upper(btrim(p_brand)) limit 1),
    'brands', to_jsonb(o.brands), 'name', o.brand_name, 'channel', o.brand_role, 'logo_path', o.logo_path, 'founded_year', o.founded_year,
    'about', o.about, 'positioning', o.positioning, 'hq_city', o.hq_city, 'production_site', o.production_site,
    'country', o.country, 'area_m2', o.area_m2, 'staff', o.staff, 'annual_units', o.annual_units,
    'certifications', to_jsonb(o.certifications), 'languages', to_jsonb(o.languages),
    'offers', (select count(*) from public.lots l where l.seller_id = o.id and l.qty > 0
                 and l.confirmed_at > now() - app.org_ttl(o.offer_ttl_days, o.profile))::int,
    'updated_at', greatest(o.public_page_at, (select max(l.confirmed_at) from public.lots l where l.seller_id = o.id)));
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
               'brand_page', (select b from unnest(bo.brands) b where upper(b) = upper(btrim(p.manufacturer)) limit 1),
               'factory_direct', bo.id = p.seller_id and bo.brand_role = 'manufacturer',
               'authorized_distributor', bo.id = p.seller_id and bo.brand_role = 'authorized_distributor',
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
               'updated_at', p.confirmed_at) order by upper(p.mpn), p.confirmed_at desc), '[]') from picked p left join public.organizations bo on bo.id = app.brand_org(p.manufacturer))));
end $$;
