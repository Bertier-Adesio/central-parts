-- API d'offres en direct pour les plateformes de chiffrage (Adesio d'abord), ADR 0024 : Central.Parts répond comme
-- l'API produit d'un distributeur, en quelques millisecondes, à partir des stocks déposés (lots à jour).
-- À appliquer à la main dans le SQL Editor, après 20261102000020 (clés d'API, rfq_auth). Rejouable.
--
--   catalog_offers      une référence (GET /v1/offers)
--   catalog_search      une nomenclature, 500 lignes au plus (POST /v1/offers/search)
--   catalog_offer       une offre et son prix à la quantité (GET /v1/offers/{offer_id})
--   catalog_manufacturers  référentiel des fabricants présents dans le stock
--
-- Règles :
--   - lots à jour seulement (app.lot_fresh), quantité > 0, fournisseur approuvé ; bac à sable avec bac à sable ;
--   - fournisseur jamais nommé : ni nom, ni pseudonyme, ni SKU, ni lien de sa fiche, ni prix net ; le fabricant oui ;
--   - prix tout compris (marge du vendeur ou de sa catégorie) ; sans marge applicable ou sans prix : « on_request » ;
--   - devise : celle du lot (décision du 2 novembre 2026, conversion traitée plus tard). Le réglage
--     app.settings 'api_convert_currency' = 'true' convertit dans la devise demandée au taux de public.currencies ;
--   - identifiant d'offre opaque (cpo_…), stable pour un lot, sans rien révéler du lot ;
--   - compteur de consultations par fournisseur, référence et semaine (aucune identité de l'appelant gardée).

-- ------------------------------------------------------------ identifiants opaques
create table if not exists app.catalog_offer_ids (
  lot_id     text primary key references public.lots on delete cascade,
  offer_id   text not null unique default ('cpo_' || encode(extensions.gen_random_bytes(10), 'hex')),
  created_at timestamptz not null default now()
);
revoke all on app.catalog_offer_ids from public, anon, authenticated;

create or replace function app.catalog_offer_id(p_lot text) returns text
language plpgsql security definer set search_path = '' as $$
declare v text;
begin
  select offer_id into v from app.catalog_offer_ids where lot_id = p_lot;
  if v is null then
    insert into app.catalog_offer_ids (lot_id) values (p_lot) on conflict (lot_id) do nothing;
    select offer_id into v from app.catalog_offer_ids where lot_id = p_lot;
  end if;
  return v;
end $$;

-- ------------------------------------------------------------ compteur de consultations
-- Une consultation = une réponse de l'API qui contient l'offre (une fois par appel). Semaine ISO (lundi).
create table if not exists app.offer_views (
  seller_id text not null references public.organizations on delete cascade,
  mpn       text not null,
  week      date not null,
  views     integer not null default 0,
  primary key (seller_id, mpn, week)
);
revoke all on app.offer_views from public, anon, authenticated;

create or replace function app.count_offer_views(p_lots text[], p_now timestamptz) returns void
language sql security definer set search_path = '' as $$
  insert into app.offer_views (seller_id, mpn, week, views)
  select l.seller_id, upper(regexp_replace(l.mpn, '\s+', '', 'g')), date_trunc('week', p_now)::date, count(*)
    from public.lots l where l.id = any (p_lots)
   group by 1, 2
  on conflict (seller_id, mpn, week) do update set views = app.offer_views.views + excluded.views
$$;

-- Consultations d'un fournisseur (administrateur ; affichage au fournisseur à décider), 8 dernières semaines.
create or replace function public.supplier_offer_views(p_org text, p_now timestamptz default now())
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('org', p_org,
    'total', coalesce(sum(v.views), 0),
    'by_week', coalesce((select jsonb_agg(jsonb_build_object('week', w.week, 'views', w.n) order by w.week desc)
        from (select week, sum(views) n from app.offer_views where seller_id = p_org and week >= (p_now - interval '8 weeks')::date
              group by week) w), '[]'),
    'top', coalesce((select jsonb_agg(jsonb_build_object('mpn', t.mpn, 'views', t.n) order by t.n desc, t.mpn)
        from (select mpn, sum(views) n from app.offer_views where seller_id = p_org and week >= (p_now - interval '8 weeks')::date
              group by mpn order by 2 desc limit 20) t), '[]'))
    from app.offer_views v where v.seller_id = p_org and v.week >= (p_now - interval '8 weeks')::date
$$;

-- ------------------------------------------------------------ prix
create or replace function app.catalog_max_lines() returns int language sql immutable as $$ select 500 $$;
-- Validité annoncée d'un prix : 24 h, et jamais au-delà de la date où le lot doit être reconfirmé.
create or replace function app.catalog_price_hours() returns int language sql immutable as $$ select 24 $$;

insert into app.settings (name, value) values ('api_convert_currency', 'false') on conflict (name) do nothing;

-- Devise de sortie : celle du lot, sauf conversion activée et devise demandée acceptée.
create or replace function app.catalog_currency(p_lot_currency text, p_requested text) returns text
language sql stable security definer set search_path = '' as $$
  select case when coalesce((select value from app.settings where name = 'api_convert_currency'), 'false') = 'true'
              and app.norm_currency(p_requested) is not null then app.norm_currency(p_requested) else p_lot_currency end
$$;

-- Prix tout compris d'un lot pour une quantité, dans la devise de sortie ; null : prix sur demande.
create or replace function app.catalog_price(p_lot text, p_qty int, p_out text) returns numeric
language sql stable security definer set search_path = '' as $$
  select round(app.lot_price_for(l.id, p_qty) * c.eur_rate / t.eur_rate * (1 + app.offer_margin(l.seller_id) / 100), 4)
    from public.lots l
    join public.currencies c on c.code = l.currency
    join public.currencies t on t.code = p_out
   where l.id = p_lot
$$;

-- Offre telle que la voit la plateforme. p_qty : quantité visée (prix à la quantité si donnée).
-- Volatile : attribue l'identifiant opaque à la première publication du lot.
create or replace function app.catalog_offer_json(p_lot text, p_qty int, p_requested text, p_now timestamptz)
returns jsonb language sql volatile security definer set search_path = '' as $$
  with x as (
    select l.*, o.profile, o.country, o.sandbox, app.catalog_currency(l.currency, p_requested) as out_cur,
           greatest(coalesce(l.moq, 1), 1) as min_qty, app.offer_margin(l.seller_id) as margin
      from public.lots l join public.organizations o on o.id = l.seller_id where l.id = p_lot),
  breaks as (
    -- Paliers : le minimum de commande au prix de base, puis les paliers du fournisseur au-delà.
    select q, app.catalog_price(x.id, q, x.out_cur) as price from x,
      lateral (select x.min_qty as q union select b.min_qty from public.lot_price_breaks b where b.lot_id = x.id and b.min_qty > x.min_qty) s)
  select jsonb_strip_nulls(jsonb_build_object(
    'offer_id', app.catalog_offer_id(x.id),
    'mpn', upper(regexp_replace(x.mpn, '\s+', '', 'g')),
    'manufacturer', nullif(x.manufacturer, ''),
    'description', x.description,
    'source_category', app.api_source_category(x.profile),
    'price_status', case when x.margin is null or (x.unit_price is null and not exists (select 1 from public.lot_price_breaks b where b.lot_id = x.id))
                         then 'on_request' else 'priced' end,
    'stock', x.qty,
    'moq', x.min_qty,
    'order_multiple', 1,
    'currency', case when x.margin is not null then x.out_cur end,
    'price_breaks', case when x.margin is null then '[]'::jsonb else coalesce(
       (select jsonb_agg(jsonb_build_object('quantity', b.q, 'price', b.price) order by b.q) from breaks b where b.price is not null), '[]') end,
    'quote', case when p_qty is not null and x.margin is not null and p_qty >= x.min_qty then jsonb_build_object(
       'quantity', p_qty, 'unit_price', app.catalog_price(x.id, p_qty, x.out_cur),
       'extended_price', round(app.catalog_price(x.id, p_qty, x.out_cur) * p_qty, 2), 'covered', x.qty >= p_qty) end,
    'lead_time_days', x.lead_days,
    'packaging', x.pack,
    'date_code', nullif(x.date_code, ''),
    'ship_from', x.country,
    'datasheet_url', x.datasheet_url,
    'price_valid_until', case when x.sandbox then p_now + make_interval(hours => app.catalog_price_hours())
                         else least(p_now + make_interval(hours => app.catalog_price_hours()), x.confirmed_at + app.offer_ttl()) end,
    'updated_at', x.confirmed_at))
  from x
$$;

-- Lots publiables pour une référence (exacte, espaces ignorés) et un appelant (bac à sable ou non).
create or replace function app.catalog_lots(p_mpn text, p_manufacturer text, p_sources text[], p_sandbox boolean, p_now timestamptz)
returns table (lot_id text, sort_eur numeric)
language sql stable security definer set search_path = '' as $$
  select l.id, app.lot_price_for(l.id, greatest(coalesce(l.moq, 1), 1)) * c.eur_rate * (1 + app.offer_margin(l.seller_id) / 100)
    from public.lots l
    join public.organizations o on o.id = l.seller_id
    join public.currencies c on c.code = l.currency
   where upper(regexp_replace(l.mpn, '\s+', '', 'g')) = upper(regexp_replace(coalesce(p_mpn, ''), '\s+', '', 'g'))
     -- Les lots du bac à sable (fictifs) ne vieillissent pas : le bac à sable reste utilisable sans entretien.
     and l.qty > 0 and (o.sandbox or l.confirmed_at > p_now - app.offer_ttl())
     and o.type = 'seller' and app.is_verified(o.id) and o.sandbox = p_sandbox
     and (p_manufacturer is null or btrim(p_manufacturer) = '' or l.manufacturer = ''
          or lower(btrim(l.manufacturer)) = lower(btrim(p_manufacturer)))
     and (p_sources is null or app.api_source_category(o.profile) = any (p_sources))
   order by 2 asc nulls last, l.qty desc, l.id
   limit 20
$$;

-- ------------------------------------------------------------ API
-- Erreurs : 22023 (detail : champ).
create or replace function public.catalog_offers(p_org text, p_mpn text, p_manufacturer text default null, p_qty int default null,
  p_currency text default null, p_sources text[] default null, p_sandbox boolean default false, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_lots text[]; v_bad text[];
begin
  if coalesce(btrim(p_mpn), '') = '' or length(p_mpn) > 80 then raise exception 'Référence (mpn) requise' using errcode = '22023', detail = 'mpn'; end if;
  if p_qty is not null and (p_qty < 1 or p_qty > 100000000) then raise exception 'Quantité invalide' using errcode = '22023', detail = 'qty'; end if;
  if p_currency is not null and app.norm_currency(p_currency) is null then raise exception 'Devise non acceptée' using errcode = '22023', detail = 'currency'; end if;
  select array_agg(s) into v_bad from unnest(coalesce(p_sources, '{}')) s where s not in ('manufacturer', 'authorized_distributor', 'broker_surplus');
  if v_bad is not null then raise exception 'Catégorie de source inconnue' using errcode = '22023', detail = 'source_category'; end if;
  select array_agg(lot_id order by sort_eur nulls last) into v_lots from app.catalog_lots(p_mpn, p_manufacturer, p_sources, p_sandbox, p_now);
  if v_lots is not null then perform app.count_offer_views(v_lots, p_now); end if;
  return jsonb_build_object('mpn', upper(regexp_replace(btrim(p_mpn), '\s+', '', 'g')), 'quantity', p_qty,
    'currency_requested', app.norm_currency(p_currency),
    'offers', coalesce((select jsonb_agg(app.catalog_offer_json(x, p_qty, p_currency, p_now) order by i)
                          from unnest(v_lots) with ordinality as t(x, i)), '[]'));
end $$;

-- Nomenclature : { currency?, lines: [{line_id?, mpn, manufacturer?, quantity?}] }, 500 lignes au plus.
create or replace function public.catalog_search(p_org text, p jsonb, p_sandbox boolean default false, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare l jsonb; v_i int := 0; v_out jsonb := '[]'; v_line text; v_qty int; r jsonb;
begin
  if jsonb_typeof(p->'lines') <> 'array' or jsonb_array_length(p->'lines') not between 1 and app.catalog_max_lines() then
    raise exception 'De 1 à % lignes', app.catalog_max_lines() using errcode = '22023', detail = 'lines';
  end if;
  if p->>'currency' is not null and app.norm_currency(p->>'currency') is null then
    raise exception 'Devise non acceptée' using errcode = '22023', detail = 'currency';
  end if;
  for l in select * from jsonb_array_elements(p->'lines') loop
    v_i := v_i + 1;
    v_line := left(coalesce(nullif(btrim(l->>'line_id'), ''), v_i::text), 80);
    if coalesce(btrim(l->>'mpn'), '') = '' then
      raise exception 'Référence (mpn) vide' using errcode = '22023', detail = 'lines[' || v_line || '].mpn';
    end if;
    v_qty := case when coalesce(l->>'quantity', '') ~ '^\d{1,9}$' then (l->>'quantity')::int end;
    if l ? 'quantity' and (v_qty is null or v_qty < 1) then
      raise exception 'Quantité invalide' using errcode = '22023', detail = 'lines[' || v_line || '].quantity';
    end if;
    r := public.catalog_offers(p_org, l->>'mpn', l->>'manufacturer', v_qty, p->>'currency', null, p_sandbox, p_now);
    v_out := v_out || jsonb_build_array(jsonb_build_object('line_id', v_line, 'mpn', r->>'mpn', 'quantity', v_qty, 'offers', r->'offers'));
  end loop;
  return jsonb_build_object('currency_requested', app.norm_currency(p->>'currency'), 'lines', v_out);
end $$;

-- Une offre et son prix à la quantité. Erreurs : P0002 inconnue ou plus publiée, 22023 quantité sous le minimum.
create or replace function public.catalog_offer(p_org text, p_offer_id text, p_qty int default null, p_currency text default null,
  p_sandbox boolean default false, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_lot text; v_moq int;
begin
  select i.lot_id, greatest(coalesce(l.moq, 1), 1) into v_lot, v_moq
    from app.catalog_offer_ids i join public.lots l on l.id = i.lot_id join public.organizations o on o.id = l.seller_id
   where i.offer_id = p_offer_id and l.qty > 0 and (o.sandbox or l.confirmed_at > p_now - app.offer_ttl())
     and app.is_verified(o.id) and o.sandbox = p_sandbox;
  if v_lot is null then raise exception 'Offre inconnue ou expirée' using errcode = 'P0002'; end if;
  if p_qty is not null and p_qty < v_moq then raise exception 'Quantité sous le minimum de commande (%)', v_moq using errcode = '22023', detail = 'qty'; end if;
  if p_currency is not null and app.norm_currency(p_currency) is null then raise exception 'Devise non acceptée' using errcode = '22023', detail = 'currency'; end if;
  perform app.count_offer_views(array[v_lot], p_now);
  return app.catalog_offer_json(v_lot, p_qty, p_currency, p_now);
end $$;

-- Fabricants présents dans le stock publiable (début du nom), 50 au plus.
create or replace function public.catalog_manufacturers(p_q text default '', p_sandbox boolean default false, p_now timestamptz default now())
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('manufacturers', coalesce(jsonb_agg(jsonb_build_object('name', m.name, 'parts', m.n) order by m.name), '[]'))
    -- Graphie la plus fréquente du fabricant (indépendante de la collation de la base).
    from (select mode() within group (order by btrim(l.manufacturer)) as name, count(distinct upper(l.mpn)) n
            from public.lots l join public.organizations o on o.id = l.seller_id
           where btrim(l.manufacturer) <> '' and l.qty > 0 and l.confirmed_at > p_now - app.offer_ttl()
             and app.is_verified(o.id) and o.sandbox = p_sandbox
             and lower(btrim(l.manufacturer)) like lower(btrim(coalesce(p_q, ''))) || '%'
           group by lower(btrim(l.manufacturer)) order by 1 limit 50) m
$$;

create or replace function public.admin_offer_views(p_org text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin perform app.require_admin(); return public.supplier_offer_views(upper(p_org)); end $$;

-- ------------------------------------------------------------ limite d'appels par clé
-- Un connecteur « une référence par appel » (format DigiKey ou TI) dépasse vite 60 appels par minute sur une
-- nomenclature : la limite se règle par clé (null : valeur par défaut, app.api_calls_per_minute()).
alter table public.api_keys add column if not exists calls_per_minute integer check (calls_per_minute between 1 and 6000);

-- Reprend rfq_auth (20261102000020) avec la limite propre à la clé.
create or replace function public.rfq_auth(p_key_hash text, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare k public.api_keys; o public.organizations; v_hits int; v_min timestamptz := date_trunc('minute', p_now); v_limit int;
begin
  select * into k from public.api_keys where key_hash = p_key_hash and revoked_at is null;
  if k.id is null then raise exception 'Clé absente ou révoquée' using errcode = 'CP401'; end if;
  select * into o from public.organizations where id = k.org_id;
  if o.type <> 'buyer' then raise exception 'Clé non autorisée' using errcode = 'CP403'; end if;
  v_limit := coalesce(k.calls_per_minute, app.api_calls_per_minute());
  insert into app.api_hits (key_id, minute) values (k.id, v_min)
  on conflict (key_id, minute) do update set hits = app.api_hits.hits + 1 returning hits into v_hits;
  delete from app.api_hits where minute < p_now - interval '1 hour';
  update public.api_keys set last_used_at = p_now where id = k.id;
  if v_hits > v_limit then
    raise exception 'Limite d''appels atteinte' using errcode = 'CP429', detail = (60 - extract(second from p_now)::int)::text;
  end if;
  return jsonb_build_object('key_id', k.id, 'org_id', o.id, 'org_name', o.name,
    'sandbox', k.environment = 'sandbox' or o.sandbox, 'environment', k.environment, 'scopes', to_jsonb(k.scopes),
    'limit', v_limit, 'remaining', greatest(v_limit - v_hits, 0),
    'reset', extract(epoch from v_min + interval '1 minute')::bigint);
end $$;
revoke execute on function public.rfq_auth(text, timestamptz) from public, anon, authenticated;
grant execute on function public.rfq_auth(text, timestamptz) to service_role;

-- ------------------------------------------------------------ droits
revoke execute on function public.catalog_offers(text, text, text, int, text, text[], boolean, timestamptz),
  public.catalog_search(text, jsonb, boolean, timestamptz), public.catalog_offer(text, text, int, text, boolean, timestamptz),
  public.catalog_manufacturers(text, boolean, timestamptz), public.supplier_offer_views(text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.catalog_offers(text, text, text, int, text, text[], boolean, timestamptz),
  public.catalog_search(text, jsonb, boolean, timestamptz), public.catalog_offer(text, text, int, text, boolean, timestamptz),
  public.catalog_manufacturers(text, boolean, timestamptz), public.supplier_offer_views(text, timestamptz)
  to service_role;
revoke execute on function public.admin_offer_views(text) from public, anon;
grant execute on function public.admin_offer_views(text) to authenticated, service_role;
revoke execute on all functions in schema app from public, anon;
grant execute on all functions in schema app to service_role;
