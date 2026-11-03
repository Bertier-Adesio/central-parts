-- Validité des offres propre à chaque vendeur, reconfirmation en un geste et rappels avant expiration (ADR 0025).
--
-- Décision de Bertier (3 novembre 2026) : 14 jours pour un fabricant, 7 jours pour un broker, un revendeur ou un
-- distributeur ; réglable vendeur par vendeur (organizations.offer_ttl_days). Au-delà, l'offre est « à reconfirmer » et
-- n'est plus montrée aux acheteurs (recherche publique, /offres/, API d'offres), comme depuis l'ADR 0021.
-- Le vendeur peut reconfirmer toutes ses offres d'un geste, sans nouveau fichier : il atteste que son stock n'a pas
-- changé ; chaque reconfirmation est journalisée (stock_reconfirmations).
-- Les fonctions qui filtraient les offres avec la durée unique (app.offer_ttl) sont recopiées telles quelles depuis
-- leur dernière migration, seule l'expression de la durée changeant.
--
-- Rejouable. À appliquer avant de fusionner la PR qui déploie les fonctions « rappels », « depot », « listes » et
-- « wechat-events » correspondantes.

-- ------------------------------------------------------------ durées
insert into app.settings (name, value) values ('offer_ttl_days_manufacturer', '14') on conflict (name) do nothing;

-- Durée propre à un vendeur (null : selon son type). 1 à 90 jours.
alter table public.organizations add column if not exists offer_ttl_days integer check (offer_ttl_days between 1 and 90);

-- Durée de validité d'après la durée propre (si saisie) et le type du vendeur : fabricant ou autre.
create or replace function app.org_ttl(p_ttl_days integer, p_profile text) returns interval
language sql stable security definer set search_path = '' as $$
  select make_interval(days => coalesce(p_ttl_days,
    case when app.source_category(p_profile) = 'manufacturer'
         then (select value::int from app.settings where name = 'offer_ttl_days_manufacturer')
         else (select value::int from app.settings where name = 'offer_ttl_days') end, 7))
$$;

-- Durée de validité d'un vendeur.
create or replace function app.seller_ttl(p_org text) returns interval
language sql stable security definer set search_path = '' as $$
  select coalesce((select app.org_ttl(o.offer_ttl_days, o.profile) from public.organizations o where o.id = p_org), app.offer_ttl())
$$;

revoke execute on function app.org_ttl(integer, text), app.seller_ttl(text) from public, anon;

-- ------------------------------------------------------------ journal des reconfirmations sans fichier
create table if not exists public.stock_reconfirmations (
  id       bigint generated always as identity primary key,
  org_id   text not null references public.organizations on delete cascade,
  by_who   text,                                   -- openid WeChat, « link » (lien personnel) ou adresse de l'administrateur
  channel  text not null check (channel in ('depot', 'lien', 'wechat', 'admin')),
  lots     integer not null,
  at       timestamptz not null default now()
);
create index if not exists stock_reconfirmations_org on public.stock_reconfirmations (org_id, at desc);
alter table public.stock_reconfirmations enable row level security;
revoke all on public.stock_reconfirmations from public, anon, authenticated;

-- ------------------------------------------------------------ fonctions recopiées (durée du vendeur)
create or replace function app.catalog_offer_json(p_lot text, p_qty int, p_requested text, p_now timestamptz)
returns jsonb language sql volatile security definer set search_path = '' as $$
  with x as (
    select l.*, o.profile, o.country, o.sandbox, o.offer_ttl_days as org_ttl_days, app.catalog_currency(l.currency, p_requested) as out_cur,
           greatest(coalesce(l.moq, 1), 1) as min_qty, app.offer_margin(l.seller_id) as margin
      from public.lots l join public.organizations o on o.id = l.seller_id where l.id = p_lot),
  breaks as (
    -- Paliers : le minimum de commande au prix de base, puis les paliers du fournisseur au-delà.
    select q, app.catalog_price(x.id, q, x.out_cur) as price from x,
      lateral (select x.min_qty as q union select b.min_qty from public.lot_price_breaks b where b.lot_id = x.id and b.min_qty > x.min_qty) s)
  select jsonb_strip_nulls(jsonb_build_object(
    'offer_id', app.catalog_offer_id(x.id),
    'source_category', app.api_source_category(x.profile),
    'price_status', case when x.margin is null or (x.unit_price is null and not exists (select 1 from public.lot_price_breaks b where b.lot_id = x.id))
                         then 'on_request' else 'priced' end,
    'stock', x.qty,
    'moq', x.min_qty,
    'order_multiple', 1,
    'standard_pack_quantity', x.standard_pack_quantity,
    'currency', case when x.margin is not null then x.out_cur end,
    'price_breaks', case when x.margin is null then '[]'::jsonb else coalesce(
       (select jsonb_agg(jsonb_build_object('quantity', b.q, 'unit_price', b.price) order by b.q) from breaks b where b.price is not null), '[]') end,
    'quote', case when p_qty is not null and x.margin is not null and p_qty >= x.min_qty then jsonb_build_object(
       'quantity', p_qty, 'unit_price', app.catalog_price(x.id, p_qty, x.out_cur),
       'extended_price', round(app.catalog_price(x.id, p_qty, x.out_cur) * p_qty, 2), 'covered', x.qty >= p_qty) end,
    'lead_time_days', x.lead_days,
    'packaging', app.packaging_code(x.pack),
    -- Libellé tel que déposé, sauf s'il s'agit en fait du boîtier (« 封装 » des anciens fichiers).
    'packaging_label', case when app.packaging_code(x.pack) is not null or btrim(coalesce(x.package_case, '')) = '' then nullif(btrim(x.pack), '') end,
    'date_code', nullif(x.date_code, ''),
    'ship_from', x.country,
    'country_of_origin', case when upper(x.country_of_origin) ~ '^[A-Z]{2}$' then upper(x.country_of_origin) end,
    'price_valid_until', case when x.sandbox then p_now + make_interval(hours => app.catalog_price_hours())
                         else least(p_now + make_interval(hours => app.catalog_price_hours()), x.confirmed_at + app.org_ttl(x.org_ttl_days, x.profile)) end,
    'updated_at', x.confirmed_at))
  from x
$$;

create or replace function app.catalog_lots(p_mpn text, p_manufacturer text, p_sources text[], p_sandbox boolean, p_now timestamptz)
returns table (lot_id text, sort_eur numeric)
language sql stable security definer set search_path = '' as $$
  select l.id, app.lot_price_for(l.id, greatest(coalesce(l.moq, 1), 1)) * c.eur_rate * (1 + app.offer_margin(l.seller_id) / 100)
    from public.lots l
    join public.organizations o on o.id = l.seller_id
    join public.currencies c on c.code = l.currency
   where upper(regexp_replace(l.mpn, '\s+', '', 'g')) = upper(regexp_replace(coalesce(p_mpn, ''), '\s+', '', 'g'))
     -- Les lots du bac à sable (fictifs) ne vieillissent pas : le bac à sable reste utilisable sans entretien.
     and l.qty > 0 and (o.sandbox or l.confirmed_at > p_now - app.org_ttl(o.offer_ttl_days, o.profile))
     and o.type = 'seller' and app.is_verified(o.id) and o.sandbox = p_sandbox
     and (p_manufacturer is null or btrim(p_manufacturer) = '' or btrim(l.manufacturer) = ''
          or app.mfr_key(l.manufacturer) = app.mfr_key(p_manufacturer)
          or app.manufacturer_id(l.manufacturer) = app.manufacturer_id(p_manufacturer))
     and (p_sources is null or app.api_source_category(o.profile) = any (p_sources))
   order by 2 asc nulls last, l.qty desc, l.id
   limit 20
$$;

create or replace function public.catalog_offer(p_org text, p_offer_id text, p_qty int default null, p_currency text default null,
  p_sandbox boolean default false, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_lot text; v_moq int; v_mpn text;
begin
  select i.lot_id, greatest(coalesce(l.moq, 1), 1), upper(regexp_replace(l.mpn, '\s+', '', 'g')) into v_lot, v_moq, v_mpn
    from app.catalog_offer_ids i join public.lots l on l.id = i.lot_id join public.organizations o on o.id = l.seller_id
   where i.offer_id = p_offer_id and l.qty > 0 and (o.sandbox or l.confirmed_at > p_now - app.org_ttl(o.offer_ttl_days, o.profile))
     and app.is_verified(o.id) and o.sandbox = p_sandbox;
  if v_lot is null then raise exception 'Offre inconnue ou expirée' using errcode = 'P0002'; end if;
  if p_qty is not null and p_qty < v_moq then raise exception 'Quantité sous le minimum de commande (%)', v_moq using errcode = '22023', detail = 'qty'; end if;
  if p_currency is not null and app.norm_currency(p_currency) is null then raise exception 'Devise non acceptée' using errcode = '22023', detail = 'currency'; end if;
  perform app.count_offer_views(array[v_lot], p_now);
  return app.catalog_offer_json(v_lot, p_qty, p_currency, p_now)
      || jsonb_build_object('product', app.catalog_product_json(v_mpn, array[v_lot], p_qty, p_currency, p_now, false));
end $$;

create or replace function public.catalog_manufacturers(p_q text default '', p_sandbox boolean default false, p_now timestamptz default now())
returns jsonb language sql stable security definer set search_path = '' as $$
  with l as (
    select l.mpn, btrim(l.manufacturer) as raw, app.manufacturer_id(l.manufacturer) as mid
      from public.lots l join public.organizations o on o.id = l.seller_id
     where btrim(l.manufacturer) <> '' and l.qty > 0 and (o.sandbox or l.confirmed_at > p_now - app.org_ttl(o.offer_ttl_days, o.profile))
       and app.is_verified(o.id) and o.sandbox = p_sandbox),
  g as (
    -- Graphie la plus fréquente pour un nom hors référentiel (indépendante de la collation de la base).
    select l.mid, coalesce(m.name, mode() within group (order by l.raw)) as name, m.aliases,
           count(distinct upper(regexp_replace(l.mpn, '\s+', '', 'g'))) as parts
      from l left join app.manufacturers m on m.id = l.mid
     group by l.mid, m.name, m.aliases, case when l.mid is null then app.mfr_key(l.raw) end)
  select jsonb_build_object('manufacturers', coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'id', g.mid, 'name', g.name, 'aliases', case when cardinality(g.aliases) > 0 then to_jsonb(g.aliases) end, 'parts', g.parts))
           order by g.name), '[]'))
    from g
   where coalesce(p_q, '') = '' or app.mfr_key(g.name) like app.mfr_key(p_q) || '%'
      or exists (select 1 from unnest(coalesce(g.aliases, '{}')) a where app.mfr_key(a) like app.mfr_key(p_q) || '%')
$$;

create or replace function public.supplier_data_quality(p_org text, p_now timestamptz default now())
returns jsonb language sql stable security definer set search_path = '' as $$
  with l as (
    select (app.manufacturer_id(l.manufacturer) is not null) as mfr, coalesce(btrim(l.description), '') <> '' as descr,
           coalesce(btrim(l.datasheet_url), '') <> '' as ds, l.package_case is not null as pc, l.lifecycle is not null as lc,
           l.eccn is not null as ec, l.hts_code is not null as hs
      from public.lots l join public.organizations o on o.id = l.seller_id
     where l.seller_id = p_org and l.qty > 0 and (o.sandbox or l.confirmed_at > p_now - app.org_ttl(o.offer_ttl_days, o.profile))),
  r as (
    select count(*) as n,
           round(avg(mfr::int), 3) as mfr, round(avg(descr::int), 3) as descr, round(avg(ds::int), 3) as ds,
           round(avg(pc::int), 3) as pc, round(avg(lc::int), 3) as lc, round(avg(ec::int), 3) as ec, round(avg(hs::int), 3) as hs
      from l)
  select jsonb_strip_nulls(jsonb_build_object('org', p_org, 'lots', r.n,
    'rates', case when r.n > 0 then jsonb_build_object('manufacturer', r.mfr, 'description', r.descr, 'datasheet', r.ds,
              'package_case', r.pc, 'lifecycle', r.lc, 'eccn', r.ec, 'hts_code', r.hs) end,
    -- Moyenne des sept taux, de 0 à 1.
    'completeness', case when r.n > 0 then round((r.mfr + r.descr + r.ds + r.pc + r.lc + r.ec + r.hs) / 7, 3) end,
    'counts_for_ranking', false))
    from r
$$;

create or replace function public.public_search(p_ip text, q text, p_currency text default 'EUR')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  k text := upper(regexp_replace(coalesce(q, ''), '\s+', '', 'g'));
  cur text := case when upper(p_currency) in (select code from public.currencies) then upper(p_currency) else 'EUR' end;
begin
  if length(k) < 3 then raise exception 'Saisir au moins 3 caractères' using errcode = '22023'; end if;
  perform app.count_search(p_ip);
  return jsonb_build_object('query', k, 'currency', cur, 'results', (
    select coalesce(jsonb_agg(r order by r->>'mpn', r->>'source'), '[]') from (
      select jsonb_build_object(
               'mpn', upper(l.mpn),
               'manufacturer', max(l.manufacturer),
               'source', app.source_category(o.profile),
               'ship_from', o.country,
               'currency', l.currency,
               'availability', app.qty_band(sum(l.qty)),
               'price_from', round(min(
                  least(l.unit_price, (select min(b.unit_price) from public.lot_price_breaks b where b.lot_id = l.id))
                  * (1 + app.offer_margin(o.id) / 100)), 4),
               'price_1k', round(min(case when coalesce(l.moq, 1) <= 1000 then app.lot_price_for(l.id, 1000) end
                  * (1 + app.offer_margin(o.id) / 100)), 4)) as r
        from public.lots l
        join public.organizations o on o.id = l.seller_id
       where upper(l.mpn) like k || '%' and l.qty > 0 and l.confirmed_at > now() - app.org_ttl(o.offer_ttl_days, o.profile)
         and app.is_verified(l.seller_id) and not o.sandbox
       group by upper(l.mpn), app.source_category(o.profile), o.country, l.currency
       limit 50) s));
end $$;

create or replace function public.partner_offers(p_ip text, q text default '', p_currency text default 'EUR')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  k text := upper(regexp_replace(coalesce(q, ''), '\s+', '', 'g'));
  cur text := case when upper(p_currency) in (select code from public.currencies) then upper(p_currency) else 'EUR' end;
begin
  if length(k) between 1 and 2 then raise exception 'Saisir au moins 3 caractères' using errcode = '22023'; end if;
  perform app.count_search(p_ip);
  return jsonb_build_object('query', k, 'currency', cur, 'ttl_days', extract(day from app.offer_ttl())::int,
    'ttl_days_manufacturer', extract(day from app.org_ttl(null, 'Manufacturer'))::int, 'offers', (
    select coalesce(jsonb_agg(r order by r->>'mpn', r->>'updated_at' desc), '[]') from (
      select jsonb_build_object(
               'mpn', upper(l.mpn),
               'manufacturer', l.manufacturer,
               'supplier', 'partner',
               'seller_category', null,
               'source', app.source_category(o.profile),
               'ship_from', o.country,
               'currency', l.currency,
               'availability', app.qty_band(l.qty),
               'moq', l.moq,
               'price_from', round(least(l.unit_price, (select min(b.unit_price) from public.lot_price_breaks b where b.lot_id = l.id))
                                   * (1 + app.offer_margin(o.id) / 100), 4),
               'price_1k', round(case when coalesce(l.moq, 1) <= 1000 then app.lot_price_for(l.id, 1000) end
                                 * (1 + app.offer_margin(o.id) / 100), 4),
               'updated_at', l.confirmed_at) as r
        from public.lots l
        join public.organizations o on o.id = l.seller_id
       where (k = '' or upper(l.mpn) like k || '%') and l.qty > 0 and l.confirmed_at > now() - app.org_ttl(o.offer_ttl_days, o.profile)
         and app.is_verified(l.seller_id) and not o.sandbox
       order by l.confirmed_at desc
       limit 50) s));
end $$;

create or replace function public.depot_link_identity(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare k public.depot_links; o public.organizations;
begin
  select * into k from public.depot_links
   where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex') and revoked_at is null;
  if k.id is null then return null; end if;
  select * into o from public.organizations where id = k.org_id;
  if not app.is_verified(o.id) then return null; end if;
  update public.depot_links set last_used_at = now() where id = k.id;
  return jsonb_build_object('org_id', o.id, 'name', o.name, 'currency', o.currency,
    'ttl_days', extract(day from app.seller_ttl(o.id))::int);
end $$;

-- ------------------------------------------------------------ état des offres d'un vendeur (remplace 20261102000012)
-- En ligne, à reconfirmer, dernière confirmation, échéance, durée et dernière reconfirmation sans fichier.
create or replace function public.seller_offer_status(p_org text)
returns jsonb language sql stable security definer set search_path = '' as $$
  with t as (select app.seller_ttl(p_org) as ttl)
  select jsonb_build_object(
    'live', count(*) filter (where l.confirmed_at > now() - t.ttl),
    'to_reconfirm', count(*) filter (where l.confirmed_at <= now() - t.ttl),
    'last_confirmed', max(l.confirmed_at),
    'expires_at', max(l.confirmed_at) + t.ttl,
    'ttl_days', extract(day from t.ttl)::int,
    'last_reconfirmed', (select max(r.at) from public.stock_reconfirmations r where r.org_id = p_org))
  from t left join public.lots l on l.seller_id = p_org and l.qty > 0
  group by t.ttl
$$;

-- ------------------------------------------------------------ reconfirmation sans fichier (suite)

-- Le vendeur atteste que son stock n'a pas changé : toutes ses offres en stock repartent pour une période.
-- Renvoie le nombre d'offres reconfirmées et la nouvelle échéance. Erreur P0002 si le vendeur n'a aucune offre en stock.
create or replace function public.seller_reconfirm(p_org text, p_by text, p_channel text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if p_channel not in ('depot', 'lien', 'wechat', 'admin') then raise exception 'Canal inconnu : %', p_channel using errcode = '22023'; end if;
  update public.lots set confirmed_at = now() where seller_id = p_org and qty > 0;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'Aucune offre en stock à reconfirmer' using errcode = 'P0002'; end if;
  insert into public.stock_reconfirmations (org_id, by_who, channel, lots) values (p_org, left(p_by, 120), p_channel, n);
  insert into public.events (actor, text, ref) values (p_channel, format('Stock reconfirmé sans fichier : %s offre(s)', n), p_org);
  return jsonb_build_object('lots', n, 'expires_at', now() + app.seller_ttl(p_org), 'ttl_days', extract(day from app.seller_ttl(p_org))::int);
end $$;

-- ------------------------------------------------------------ rappels avant expiration
-- Un rappel par vendeur, par type et par échéance : « soon » dans les 48 heures avant, « expired » dans les 24 heures
-- après. delivered : WeChat a accepté le message pour au moins un administrateur du vendeur.
create table if not exists app.stock_reminders (
  org_id     text not null references public.organizations on delete cascade,
  kind       text not null check (kind in ('soon', 'expired')),
  expires_at timestamptz not null,
  sent_at    timestamptz not null default now(),
  delivered  boolean not null default false,
  primary key (org_id, kind, expires_at)
);
revoke all on app.stock_reminders from public, anon, authenticated;

-- Rappels à envoyer maintenant : vendeurs approuvés, hors bac à sable, dont les offres en stock les plus récentes
-- expirent dans les 48 heures (soon) ou ont expiré depuis moins de 24 heures (expired), pas encore prévenus.
create or replace function public.due_stock_reminders(p_now timestamptz default now())
returns jsonb language sql stable security definer set search_path = '' as $$
  with s as (
    select o.id, o.name, count(*) as lots, max(l.confirmed_at) + app.org_ttl(o.offer_ttl_days, o.profile) as expires_at,
           extract(day from app.org_ttl(o.offer_ttl_days, o.profile))::int as ttl_days
      from public.organizations o join public.lots l on l.seller_id = o.id and l.qty > 0
     where o.type = 'seller' and not o.sandbox and app.is_verified(o.id)
     group by o.id),
  d as (
    select s.*, case when s.expires_at > p_now and s.expires_at <= p_now + interval '48 hours' then 'soon'
                     when s.expires_at <= p_now and s.expires_at > p_now - interval '24 hours' then 'expired' end as kind
      from s)
  select coalesce(jsonb_agg(jsonb_build_object('org_id', d.id, 'name', d.name, 'kind', d.kind, 'lots', d.lots,
           'expires_at', d.expires_at, 'ttl_days', d.ttl_days,
           'admins', coalesce((select jsonb_agg(a) from public.org_admins(d.id) a), '[]'::jsonb)) order by d.expires_at), '[]'::jsonb)
    from d
   where d.kind is not null
     and not exists (select 1 from app.stock_reminders r where r.org_id = d.id and r.kind = d.kind and r.expires_at = d.expires_at)
$$;

create or replace function public.record_stock_reminder(p_org text, p_kind text, p_expires timestamptz, p_delivered boolean)
returns void language sql security definer set search_path = '' as $$
  insert into app.stock_reminders (org_id, kind, expires_at, delivered) values (p_org, p_kind, p_expires, p_delivered)
  on conflict (org_id, kind, expires_at) do update set delivered = app.stock_reminders.delivered or excluded.delivered, sent_at = now()
$$;

revoke execute on function public.seller_reconfirm(text, text, text), public.due_stock_reminders(timestamptz),
  public.record_stock_reminder(text, text, timestamptz, boolean) from public, anon, authenticated;
grant execute on function public.seller_reconfirm(text, text, text), public.due_stock_reminders(timestamptz),
  public.record_stock_reminder(text, text, timestamptz, boolean) to service_role;
