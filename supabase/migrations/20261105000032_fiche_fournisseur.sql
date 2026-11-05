-- Fiche fournisseur complète et page publique « fabricant » (décision de Bertier, 5 novembre 2026 : « back office +
-- page publique sous ma direction »). ADR 0032.
--
-- Back office : présentation en trois langues, chiffres clés, certifications, langues parlées, conditions de paiement,
-- marques fabriquées, logo et contacts par site (dont les adresses e-mail préférées pour les RFQ et les commandes).
-- Page publique /fabricants/ : seulement pour un fabricant approuvé dont l'administrateur active la page ; elle montre
-- la présentation, le logo et les chiffres, jamais un contact, une adresse, un site web ni le chiffre d'affaires.
-- Les données réelles sont saisies dans le back office, jamais dans le dépôt. Rejouable.

alter table public.organizations
  add column if not exists founded_year    int check (founded_year between 1800 and 2100),
  add column if not exists website         text,                               -- interne : jamais publié
  add column if not exists about           jsonb not null default '{}',        -- {fr, en, zh}
  add column if not exists positioning     jsonb not null default '{}',        -- {fr, en, zh}, une phrase
  add column if not exists hq_city         text,
  add column if not exists production_site text,
  add column if not exists area_m2         int check (area_m2 > 0),
  add column if not exists staff           int check (staff > 0),
  add column if not exists annual_units    bigint check (annual_units > 0),
  add column if not exists revenue_usd     numeric check (revenue_usd > 0),    -- interne : jamais publié
  add column if not exists certifications  text[] not null default '{}',
  add column if not exists languages       text[] not null default '{}',       -- codes : zh, en, fr, de, ja, ko…
  add column if not exists payment_methods text[] not null default '{}',
  add column if not exists payment_terms   text,
  add column if not exists min_order_usd   numeric check (min_order_usd >= 0),
  add column if not exists brands          text[] not null default '{}',       -- marques fabriquées (colonne fabricant)
  add column if not exists logo_path       text,                               -- compartiment public seller-logos
  add column if not exists public_page     boolean not null default false,
  add column if not exists public_page_by  text,
  add column if not exists public_page_at  timestamptz;

-- Contacts par société (et par site d'expédition s'il y en a plusieurs). Lus par les administrateurs seulement.
create sequence if not exists app.seller_contact_seq start 1;
create table if not exists public.seller_contacts (
  id          text primary key default app.ref('CTC', 'app.seller_contact_seq'),
  org_id      text not null references public.organizations on delete cascade,
  address_id  text references public.seller_addresses on delete set null,
  name        text not null check (btrim(name) <> ''),
  role        text,
  email       text check (email is null or email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone       text,
  wechat      text,
  languages   text[] not null default '{}',
  for_rfq     boolean not null default false,   -- adresse préférée pour les demandes de prix
  for_po      boolean not null default false,   -- adresse préférée pour les bons de commande
  created_at  timestamptz not null default now()
);
create index if not exists seller_contacts_org_idx on public.seller_contacts (org_id);
alter table public.seller_contacts enable row level security;
revoke all on public.seller_contacts from anon, authenticated;
grant usage on sequence app.seller_contact_seq to service_role;

-- Logos : compartiment public (lecture par URL), images matricielles seulement (pas de SVG, qui peut porter un script).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('seller-logos', 'seller-logos', true, 1048576, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;

-- Texte en trois langues : seules les clés fr, en, zh, chaînes nettoyées, vides retirées.
create or replace function app.tri_text(p jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_object_agg(k, btrim(p->>k)) filter (where k in ('fr', 'en', 'zh') and btrim(coalesce(p->>k, '')) <> ''), '{}')
    from jsonb_object_keys(case when jsonb_typeof(p) = 'object' then p else '{}' end) k
$$;

-- Liste de libellés courts (certifications, langues, moyens de paiement) : nettoyés, sans doublon, 20 au plus.
create or replace function app.short_list(p jsonb) returns text[]
language sql immutable set search_path = '' as $$
  select coalesce(array_agg(distinct v order by v), '{}') from (
    select left(btrim(x), 60) v from jsonb_array_elements_text(case when jsonb_typeof(p) = 'array' then p else '[]' end) x
     where btrim(x) <> '' limit 20) s
$$;

-- Page publique du fabricant d'une marque : société approuvée, page activée, marque déclarée (insensible à la casse).
create or replace function app.brand_org(p_brand text) returns text
language sql stable security definer set search_path = '' as $$
  select o.id from public.organizations o
   where o.public_page and o.type = 'seller' and o.kyb = 'validated' and not o.sandbox
     and upper(btrim(coalesce(p_brand, ''))) = any (select upper(b) from unnest(o.brands) b)
   order by o.created_at limit 1
$$;

-- ------------------------------------------------------------ back office
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
    'min_order_usd', o.min_order_usd, 'brands', to_jsonb(o.brands), 'logo_path', o.logo_path,
    'public_page', o.public_page, 'public_page_by', o.public_page_by, 'public_page_at', o.public_page_at,
    'can_publish', o.kyb = 'validated' and cardinality(o.brands) > 0 and o.about <> '{}',
    'contacts', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'address_id', c.address_id, 'name', c.name, 'role', c.role,
        'email', c.email, 'phone', c.phone, 'wechat', c.wechat, 'languages', to_jsonb(c.languages), 'for_rfq', c.for_rfq, 'for_po', c.for_po)
        order by c.created_at) from public.seller_contacts c where c.org_id = o.id), '[]'));
end $$;

-- Enregistre les champs fournis (une clé absente garde sa valeur ; null ou chaîne vide l'efface).
create or replace function public.admin_supplier_profile_save(p_org text, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_by text := app.require_admin(); v_org text := upper(btrim(coalesce(p_org, '')));
  txt constant text[] := array['website', 'hq_city', 'production_site', 'payment_terms', 'logo_path'];
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
      brands          = case when p ? 'brands' then app.short_list(p->'brands') else brands end
     where id = v_org;
  exception when invalid_text_representation or numeric_value_out_of_range or check_violation then
    raise exception 'Valeur invalide : %', sqlerrm using errcode = '22023';
  end;
  -- Une page publique sans marque ni présentation n'a plus de sens : elle est retirée.
  update public.organizations set public_page = false
   where id = v_org and public_page and (cardinality(brands) = 0 or about = '{}');
  insert into public.events (actor, text, ref) values ('ops', 'Fiche société modifiée par ' || v_by, v_org);
  return public.admin_supplier_profile(v_org);
end $$;

-- Active ou retire la page publique. Activation : fabricant approuvé, au moins une marque et une présentation.
create or replace function public.admin_supplier_publish(p_org text, p_on boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_by text := app.require_admin(); o public.organizations;
begin
  select * into o from public.organizations where id = upper(btrim(coalesce(p_org, ''))) and type = 'seller';
  if o.id is null then raise exception 'Fournisseur inconnu : %', p_org using errcode = 'P0002'; end if;
  if p_on and (o.kyb <> 'validated' or cardinality(o.brands) = 0 or o.about = '{}') then
    raise exception 'Page publique : société approuvée, marque et présentation requises' using errcode = '22023';
  end if;
  update public.organizations set public_page = p_on, public_page_by = v_by, public_page_at = now() where id = o.id;
  insert into public.events (actor, text, ref)
  values ('ops', case when p_on then 'Page fabricant publiée par ' else 'Page fabricant retirée par ' end || v_by, o.id);
  return public.admin_supplier_profile(o.id);
end $$;

-- Ajoute (sans id) ou modifie un contact.
create or replace function public.admin_seller_contact_save(p_org text, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_by text := app.require_admin(); v_org text := upper(btrim(coalesce(p_org, ''))); v_id text := nullif(p->>'id', '');
  v_addr text := nullif(p->>'address_id', '');
begin
  if not exists (select 1 from public.organizations where id = v_org and type = 'seller') then
    raise exception 'Fournisseur inconnu : %', p_org using errcode = 'P0002';
  end if;
  if v_addr is not null and not exists (select 1 from public.seller_addresses where id = v_addr and org_id = v_org) then
    raise exception 'Adresse inconnue pour ce fournisseur' using errcode = '22023';
  end if;
  begin
    if v_id is null then
      insert into public.seller_contacts (org_id, address_id, name, role, email, phone, wechat, languages, for_rfq, for_po)
      values (v_org, v_addr, btrim(coalesce(p->>'name', '')), nullif(btrim(p->>'role'), ''), nullif(lower(btrim(p->>'email')), ''),
        nullif(btrim(p->>'phone'), ''), nullif(btrim(p->>'wechat'), ''), app.short_list(p->'languages'),
        coalesce((p->>'for_rfq')::boolean, false), coalesce((p->>'for_po')::boolean, false));
    else
      update public.seller_contacts set address_id = v_addr, name = btrim(coalesce(p->>'name', '')), role = nullif(btrim(p->>'role'), ''),
        email = nullif(lower(btrim(p->>'email')), ''), phone = nullif(btrim(p->>'phone'), ''), wechat = nullif(btrim(p->>'wechat'), ''),
        languages = app.short_list(p->'languages'), for_rfq = coalesce((p->>'for_rfq')::boolean, false),
        for_po = coalesce((p->>'for_po')::boolean, false)
       where id = v_id and org_id = v_org;
      if not found then raise exception 'Contact inconnu' using errcode = 'P0002'; end if;
    end if;
  exception when check_violation or invalid_text_representation then
    raise exception 'Contact invalide : nom obligatoire, e-mail au bon format' using errcode = '22023';
  end;
  insert into public.events (actor, text, ref) values ('ops', 'Contacts modifiés par ' || v_by, v_org);
  return public.admin_supplier_profile(v_org);
end $$;

create or replace function public.admin_seller_contact_delete(p_org text, p_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_by text := app.require_admin(); v_org text := upper(btrim(coalesce(p_org, '')));
begin
  delete from public.seller_contacts where id = p_id and org_id = v_org;
  if not found then raise exception 'Contact inconnu' using errcode = 'P0002'; end if;
  insert into public.events (actor, text, ref) values ('ops', 'Contact retiré par ' || v_by, v_org);
  return public.admin_supplier_profile(v_org);
end $$;

-- ------------------------------------------------------------ page publique
-- Fiche publique d'une marque : uniquement les champs de présentation. Jamais : contacts, adresses, site web, chiffre
-- d'affaires, conditions de paiement, identifiant interne ni pseudonyme du vendeur.
create or replace function public.public_manufacturer(p_ip text, p_brand text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_org text; o public.organizations;
begin
  perform app.count_search(p_ip);
  v_org := app.brand_org(p_brand);
  if v_org is null then return null; end if;
  select * into o from public.organizations where id = v_org;
  return jsonb_build_object('brand', (select b from unnest(o.brands) b where upper(b) = upper(btrim(p_brand)) limit 1),
    'brands', to_jsonb(o.brands), 'name', o.name, 'logo_path', o.logo_path, 'founded_year', o.founded_year,
    'about', o.about, 'positioning', o.positioning, 'hq_city', o.hq_city, 'production_site', o.production_site,
    'country', o.country, 'area_m2', o.area_m2, 'staff', o.staff, 'annual_units', o.annual_units,
    'certifications', to_jsonb(o.certifications), 'languages', to_jsonb(o.languages),
    'offers', (select count(*) from public.lots l where l.seller_id = o.id and l.qty > 0
                 and l.confirmed_at > now() - app.org_ttl(o.offer_ttl_days, o.profile))::int,
    'updated_at', greatest(o.public_page_at, (select max(l.confirmed_at) from public.lots l where l.seller_id = o.id)));
end $$;

-- ------------------------------------------------------------ offres publiques (remplace 20261103000030)
-- Ajoute le lien vers la page du fabricant (brand_page, marque déclarée par un fabricant dont la page est publiée) et
-- l'offre directe du fabricant (factory_direct). Le vendeur reste anonyme pour toutes les autres offres.
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
               'factory_direct', bo.id = p.seller_id,
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

revoke execute on function app.tri_text(jsonb), app.short_list(jsonb), app.brand_org(text) from public, anon, authenticated;
grant execute on function app.brand_org(text) to service_role;
revoke execute on function public.partner_offers(text, text, text), public.public_manufacturer(text, text) from public, anon, authenticated;
grant execute on function public.partner_offers(text, text, text), public.public_manufacturer(text, text) to service_role;
do $$
declare f text;
begin
  foreach f in array array['public.admin_supplier_profile(text)', 'public.admin_supplier_profile_save(text, jsonb)',
    'public.admin_supplier_publish(text, boolean)', 'public.admin_seller_contact_save(text, jsonb)',
    'public.admin_seller_contact_delete(text, text)']
  loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;
