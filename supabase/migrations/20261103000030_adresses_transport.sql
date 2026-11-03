-- Adresses des acheteurs et des vendeurs, et choix du transport (décision de Bertier, 3 novembre 2026 : « les
-- acheteurs ont une adresse de billing, une de livraison ; les vendeurs ont une adresse d'expédition, ou plusieurs »).
-- ADR 0030.
--
-- Acheteur (demande d'achat, panier) : adresse de facturation et adresse de livraison ; transport « central »
-- (Central.Parts organise, DAP, transporteur préféré facultatif) ou « own » (compte transporteur de l'acheteur, FCA :
-- transporteur et numéro de compte).
-- Vendeur : une ou plusieurs adresses d'expédition (public.seller_addresses), dont une par défaut ; un lot peut être
-- rattaché à l'une d'elles (lots.ship_address_id). Le lieu FCA affiché vient de l'adresse du lot, sinon de l'adresse
-- par défaut, sinon de la société. Les adresses ne sont jamais montrées aux acheteurs : seul le code du lieu l'est.
-- Remplace public_search, partner_offers, public_quote (20261103000029), create_purchase_cart (20261103000027) et
-- request_for_operator (20261103000026), recopiées. Rejouable.

-- ------------------------------------------------------------ adresses d'expédition des vendeurs
create sequence if not exists app.seller_address_seq start 1;
create table if not exists public.seller_addresses (
  id          text primary key default app.ref('ADR', 'app.seller_address_seq'),
  org_id      text not null references public.organizations on delete cascade,
  label       text not null default 'Entrepôt',
  address     text not null,
  city        text not null,
  postal_code text,
  country     char(2) not null check (country ~ '^[A-Z]{2}$'),
  contact     text,
  phone       text,
  is_default  boolean not null default false,
  created_at  timestamptz not null default now()
);
create unique index if not exists seller_addresses_default_idx on public.seller_addresses (org_id) where is_default;
alter table public.seller_addresses enable row level security;
revoke all on public.seller_addresses from anon, authenticated;
drop policy if exists ops on public.seller_addresses;
create policy ops on public.seller_addresses for select to authenticated using (app.is_ops());
grant select on public.seller_addresses to authenticated;
grant usage on sequence app.seller_address_seq to service_role;
alter table public.lots add column if not exists ship_address_id text references public.seller_addresses on delete set null;

-- Adresse d'expédition d'un lot : la sienne, sinon l'adresse par défaut du vendeur (null sinon).
create or replace function app.lot_address_id(p_lot text) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(l.ship_address_id, (select a.id from public.seller_addresses a where a.org_id = l.seller_id and a.is_default))
    from public.lots l where l.id = p_lot
$$;

-- Lieu FCA d'un lot (code court) : ville et pays de son adresse d'expédition, sinon ceux de la société.
create or replace function app.lot_place(p_lot text) returns text
language sql stable security definer set search_path = '' as $$
  select app.fca_place(coalesce(a.country, o.country), coalesce(a.city, o.city))
    from public.lots l join public.organizations o on o.id = l.seller_id
    left join public.seller_addresses a on a.id = app.lot_address_id(l.id)
   where l.id = p_lot
$$;

-- Back office : adresses d'expédition d'un vendeur (lecture).
create or replace function public.admin_seller_addresses(p_org text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_admin();
  return coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'label', a.label, 'address', a.address, 'city', a.city,
    'postal_code', a.postal_code, 'country', a.country, 'contact', a.contact, 'phone', a.phone, 'is_default', a.is_default,
    'lots', (select count(*) from public.lots l where l.ship_address_id = a.id))
    order by a.is_default desc, a.created_at) from public.seller_addresses a where a.org_id = upper(p_org)), '[]');
end $$;

-- ------------------------------------------------------------ adresses de l'acheteur et transport
alter table public.purchase_requests add column if not exists billing_country char(2);
alter table public.purchase_requests add column if not exists billing_address text;
alter table public.purchase_requests add column if not exists transport_mode text not null default 'central';
alter table public.purchase_requests drop constraint if exists purchase_requests_transport_mode_check;
alter table public.purchase_requests add constraint purchase_requests_transport_mode_check check (transport_mode in ('central', 'own'));
alter table public.purchase_requests add column if not exists carrier text;
alter table public.purchase_requests add column if not exists carrier_account text; -- compte de l'acheteur, jamais montré au public

-- Contrôle de l'adresse de facturation (facultative : à défaut, celle de la livraison) et du transport. 22023 sinon.
create or replace function app.check_addresses_transport(p jsonb) returns void
language plpgsql immutable set search_path = '' as $$
declare m text := coalesce(p->'transport'->>'mode', 'central'); c text := p->'transport'->>'carrier';
begin
  if coalesce(p->>'billing_country', '') <> '' and upper(p->>'billing_country') !~ '^[A-Z]{2}$' then
    raise exception 'Pays de facturation invalide' using errcode = '22023';
  end if;
  if m not in ('central', 'own') then raise exception 'Mode de transport invalide' using errcode = '22023'; end if;
  if c is not null and c <> '' and c not in ('DHL', 'FedEx', 'UPS', 'SF', 'TNT', 'Other') then
    raise exception 'Transporteur invalide' using errcode = '22023';
  end if;
  if m = 'own' and (coalesce(c, '') = '' or upper(regexp_replace(coalesce(p->'transport'->>'account', ''), '\s', '', 'g')) !~ '^[A-Z0-9-]{5,20}$') then
    raise exception 'Transporteur et numéro de compte obligatoires' using errcode = '22023';
  end if;
end $$;

-- Complétion d'adresses par la fonction Edge « order » (Photon, OpenStreetMap) : même limite que la recherche
-- publique (30 appels par minute et par adresse IP, comptés ensemble).
create or replace function public.address_lookup_hit(p_ip text) returns void
language plpgsql security definer set search_path = '' as $$
begin perform app.count_search(p_ip); end $$;

-- ------------------------------------------------------------ recherche publique (/recherche/)
create or replace function public.public_search(p_ip text, q text, p_currency text default 'EUR')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  k text := upper(regexp_replace(coalesce(q, ''), '\s+', '', 'g'));
  cur text := case when upper(p_currency) in (select code from public.currencies) then upper(p_currency) else 'EUR' end;
begin
  if length(k) < 3 then raise exception 'Saisir au moins 3 caractères' using errcode = '22023'; end if;
  perform app.count_search(p_ip);
  return (
    with offers as (
      select upper(l.mpn) as mpn, l.manufacturer, app.source_category(o.profile) as source, o.country as ship_from, app.lot_place(l.id) as place, l.seller_id, l.qty,
             l.currency as lot_currency,
             least(l.unit_price, (select min(b.unit_price) from public.lot_price_breaks b where b.lot_id = l.id))
               * app.fx(l.currency, cur) * (1 + app.offer_margin(o.id) / 100) as p_from,
             case when coalesce(l.moq, 1) <= 1000 then app.lot_price_for(l.id, 1000) end
               * app.fx(l.currency, cur) * (1 + app.offer_margin(o.id) / 100) as p_1k
        from public.lots l
        join public.organizations o on o.id = l.seller_id
       where upper(l.mpn) like k || '%' and l.qty > 0 and l.confirmed_at > now() - app.org_ttl(o.offer_ttl_days, o.profile)
         and app.is_verified(l.seller_id) and not o.sandbox)
    select jsonb_build_object('query', k, 'currency', cur,
      'rates_at', (select min(c.rate_at) from public.currencies c where c.code in (select lot_currency from offers) and c.code <> cur),
      'results', (select coalesce(jsonb_agg(r order by r->>'mpn', r->>'source'), '[]') from (
        select jsonb_build_object(
                 'mpn', mpn, 'manufacturer', max(manufacturer), 'source', source, 'ship_from', ship_from, 'currency', cur,
                 'incoterm', case when count(distinct seller_id) = 1 then coalesce(app.terms_json(min(seller_id), cur)->>'incoterm', 'FCA') else 'FCA' end,
                 'fca_place', case when count(distinct place) = 1 then min(place) else ship_from end,
                 'terms', case when count(distinct seller_id) = 1 then app.terms_json(min(seller_id), cur) end,
                 'availability', app.qty_band(sum(qty)::int),
                 'price_from', round(min(p_from), 4), 'price_1k', round(min(p_1k), 4)) as r
          from offers group by mpn, source, ship_from
          limit 50) s)));
end $$;

-- ------------------------------------------------------------ offres des fournisseurs partenaires (/offres/)
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
               'updated_at', p.confirmed_at) order by upper(p.mpn), p.confirmed_at desc), '[]') from picked p)));
end $$;

-- ------------------------------------------------------------ devis d'une ligne (panier)
create or replace function public.public_quote(p_mpn text, p_source text, p_ship_from text, p_qty int, p_currency text default 'EUR')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_lot text; v_price numeric; v_avail int; v_moq int; v_spq int; v_place text; v_seller text;
  cur text := case when upper(p_currency) in (select code from public.currencies) then upper(p_currency) else 'EUR' end;
begin
  if coalesce(p_qty, 0) < 1 or p_qty > 10000000 then raise exception 'Quantité invalide' using errcode = '22023'; end if;
  v_lot := app.pick_lot(p_mpn, p_source, p_ship_from, p_qty);
  if v_lot is null then raise exception 'Offre introuvable' using errcode = 'P0002'; end if;
  select l.qty, l.moq, l.standard_pack_quantity, app.lot_place(l.id), l.seller_id into v_avail, v_moq, v_spq, v_place, v_seller
    from public.lots l join public.organizations o on o.id = l.seller_id where l.id = v_lot;
  v_price := app.buyer_price(v_lot, p_qty, cur);
  return jsonb_build_object('currency', cur, 'qty', p_qty, 'unit_price', v_price,
    'total', round(v_price * p_qty, 2), 'covered', v_avail >= p_qty,
    'moq', greatest(coalesce(v_moq, 1), 1), 'spq', v_spq, 'min_qty', app.lot_min_qty(v_moq, v_spq), 'qty_ok', app.qty_ok(p_qty, v_moq, v_spq),
    'incoterm', coalesce(app.terms_json(v_seller, cur)->>'incoterm', 'FCA'), 'fca_place', v_place, 'terms', app.terms_json(v_seller, cur));
end $$;

-- ------------------------------------------------------------ panier
create or replace function public.create_purchase_cart(p_ip text, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_token text := encode(extensions.gen_random_bytes(18), 'hex');
  v_ip text := encode(extensions.digest(coalesce(p_ip, '') || current_date::text, 'sha256'), 'hex');
  v_cart text; v_cur text; v_line jsonb; v_qty int; v_lot text; v_price numeric; v_id text; l public.lots;
  v_out jsonb := '[]'; v_total numeric := 0; v_priced boolean := true; n int;
begin
  -- 5 envois par heure et par adresse (un panier compte pour un envoi).
  if (select count(distinct coalesce(cart_id, id)) from public.purchase_requests
       where ip_hash = v_ip and created_at > now() - interval '1 hour') >= 5 then
    raise exception 'Trop de demandes, réessayer plus tard' using errcode = 'CP429';
  end if;
  n := case when jsonb_typeof(p->'lines') = 'array' then jsonb_array_length(p->'lines') else 0 end;
  if n < 1 or n > 30 then raise exception 'Panier vide ou trop long (30 lignes au plus)' using errcode = '22023'; end if;
  perform app.check_buyer(p);
  perform app.check_addresses_transport(p);
  v_cur := case when upper(p->>'currency') in (select code from public.currencies) then upper(p->>'currency') else 'EUR' end;
  v_cart := app.ref('CART', 'app.cart_seq');
  for v_line in select * from jsonb_array_elements(p->'lines') loop
    v_qty := case when coalesce(v_line->>'qty', '') ~ '^\d{1,8}$' then (v_line->>'qty')::int end;
    if v_qty is null or v_qty < 1 then raise exception 'Quantité invalide : %', v_line->>'mpn' using errcode = '22023'; end if;
    v_lot := app.pick_lot(v_line->>'mpn', v_line->>'source', v_line->>'ship_from', v_qty);
    if v_lot is null then
      raise exception 'Offre introuvable : %', v_line->>'mpn' using errcode = 'P0002', detail = coalesce(v_line->>'mpn', '');
    end if;
    select * into l from public.lots where id = v_lot;
    if not app.qty_ok(v_qty, l.moq, l.standard_pack_quantity) then
      raise exception 'Quantité incompatible avec le MOQ (%) ou le SPQ (%) : %', coalesce(l.moq, 1), coalesce(l.standard_pack_quantity, 1), upper(l.mpn)
        using errcode = 'CP422', detail = upper(l.mpn), hint = app.lot_min_qty(l.moq, l.standard_pack_quantity)::text || '/' || coalesce(l.standard_pack_quantity, 1)::text;
    end if;
    v_price := app.buyer_price(v_lot, v_qty, v_cur);
    insert into public.purchase_requests (cart_id, mpn, source, ship_from, qty, lot_id, seller_id, currency, unit_price,
        supplier_unit_price, supplier_currency, buyer_company, buyer_vat, vat_checked, buyer_name, buyer_email, buyer_phone,
        delivery_country, delivery_address, message, access_hash, ip_hash,
        billing_country, billing_address, transport_mode, carrier, carrier_account)
    values (v_cart, upper(l.mpn), v_line->>'source', v_line->>'ship_from', v_qty, v_lot, l.seller_id, v_cur, v_price,
        app.lot_price_for(v_lot, v_qty), l.currency, left(btrim(p->>'company'), 160),
        upper(regexp_replace(p->>'vat', '[\s.-]', '', 'g')), coalesce((p->>'vat_checked')::boolean, false),
        left(btrim(p->>'name'), 120), lower(btrim(p->>'email')), left(nullif(btrim(p->>'phone'), ''), 40),
        upper(p->>'country'), left(btrim(p->>'address'), 500), left(nullif(btrim(p->>'message'), ''), 1000),
        encode(extensions.digest(v_token, 'sha256'), 'hex'), v_ip,
        upper(coalesce(nullif(p->>'billing_country', ''), p->>'country')), left(btrim(coalesce(nullif(btrim(p->>'billing_address'), ''), p->>'address')), 500),
        coalesce(p->'transport'->>'mode', 'central'), nullif(p->'transport'->>'carrier', ''),
        case when p->'transport'->>'mode' = 'own' then upper(regexp_replace(p->'transport'->>'account', '\s', '', 'g')) end)
    returning id into v_id;
    insert into public.events (actor, text, ref) values ('buyer', 'Panier ' || v_cart || ', demande ' || v_id || ' : ' || upper(l.mpn) || ' × ' || v_qty, l.seller_id);
    v_out := v_out || jsonb_build_object('ref', v_id, 'mpn', upper(l.mpn), 'qty', v_qty, 'unit_price', v_price,
      'total', round(v_price * v_qty, 2), 'covered', l.qty >= v_qty);
    if v_price is null then v_priced := false; else v_total := v_total + round(v_price * v_qty, 2); end if;
  end loop;
  return jsonb_build_object('ref', v_cart, 'token', v_token, 'currency', v_cur, 'lines', v_out,
    'total', case when v_priced then v_total end);
end $$;

-- ------------------------------------------------------------ fiche opérateur
create or replace function public.request_for_operator(p_ref text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('ref', r.id, 'origin', 'site', 'cart_id', r.cart_id,
    'cart_lines', (select count(*) from public.purchase_requests c where c.cart_id = r.cart_id),
    'status', r.status, 'mpn', r.mpn, 'qty', r.qty, 'currency', r.currency,
    'unit_price', r.unit_price, 'total', round(r.unit_price * r.qty, 2), 'supplier', o.id || ' ' || o.alias,
    'seller_id', r.seller_id, 'source', r.source, 'ship_from', r.ship_from,
    'supplier_unit_price', r.supplier_unit_price, 'supplier_currency', r.supplier_currency,
    'lot_qty', (select qty from public.lots where id = r.lot_id), 'buyer_company', r.buyer_company,
    'buyer_vat', r.buyer_vat, 'vat_checked', r.vat_checked, 'buyer_name', r.buyer_name, 'buyer_email', r.buyer_email,
    'buyer_phone', r.buyer_phone, 'delivery', r.delivery_country || ' · ' || r.delivery_address, 'message', r.message,
    'billing', case when r.billing_address is not null then r.billing_country || ' · ' || r.billing_address end,
    'transport', jsonb_strip_nulls(jsonb_build_object('mode', r.transport_mode, 'carrier', r.carrier, 'account', r.carrier_account)),
    'ship_address', (select jsonb_build_object('label', a.label, 'city', a.city, 'country', a.country) from public.lots l
                     join public.seller_addresses a on a.id = app.lot_address_id(l.id) where l.id = r.lot_id),
    'created_at', r.created_at, 'updated_at', r.updated_at, 'decided_at', r.decided_at, 'decided_by', r.decided_by,
    'reject_reason', r.reject_reason, 'answered_at', r.answered_at)
    from public.purchase_requests r left join public.organizations o on o.id = r.seller_id
   where r.id = upper(p_ref)
$$;

revoke execute on function app.lot_address_id(text), app.lot_place(text), app.check_addresses_transport(jsonb)
  from public, anon, authenticated;
revoke execute on function public.public_search(text, text, text), public.partner_offers(text, text, text),
  public.public_quote(text, text, text, int, text), public.create_purchase_cart(text, jsonb), public.request_for_operator(text),
  public.admin_seller_addresses(text), public.address_lookup_hit(text) from public, anon, authenticated;
grant execute on function public.address_lookup_hit(text) to service_role;
grant execute on function public.public_search(text, text, text), public.partner_offers(text, text, text),
  public.public_quote(text, text, text, int, text), public.create_purchase_cart(text, jsonb), public.request_for_operator(text)
  to service_role;
grant execute on function public.admin_seller_addresses(text) to authenticated, service_role;
