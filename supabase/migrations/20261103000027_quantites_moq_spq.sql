-- Quantités compatibles avec le MOQ et le SPQ du fournisseur (décision de Bertier, 3 novembre 2026). ADR 0028.
--
-- Une quantité est valide si elle atteint le MOQ du lot et si elle est un multiple de son SPQ (conditionnement
-- standard : bobine, plateau). Quantité minimale = plus petit multiple du SPQ qui atteint le MOQ.
-- partner_offers donne spq et min_qty ; public_quote donne moq, spq, min_qty et qty_ok du lot retenu ;
-- create_purchase_cart refuse une ligne invalide (CP422). Remplace ces trois fonctions (20261103000025,
-- 20261031000009, 20261103000026), recopiées ; seules les lignes ci-dessus changent. Rejouable.

create or replace function app.lot_min_qty(p_moq int, p_spq int) returns int
language sql immutable set search_path = '' as $$
  select case when coalesce(p_spq, 1) > 1
              then (ceil(greatest(coalesce(p_moq, 1), 1)::numeric / p_spq) * p_spq)::int
              else greatest(coalesce(p_moq, 1), 1) end
$$;

create or replace function app.qty_ok(p_qty int, p_moq int, p_spq int) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(p_qty, 0) >= greatest(coalesce(p_moq, 1), 1) and (coalesce(p_spq, 1) <= 1 or p_qty % p_spq = 0)
$$;

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
      select l.*, o.profile, o.country
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
               'ship_from', p.country,
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

-- ------------------------------------------------------------ devis d'une ligne
create or replace function public.public_quote(p_mpn text, p_source text, p_ship_from text, p_qty int, p_currency text default 'EUR')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_lot text; v_price numeric; v_avail int; v_moq int; v_spq int;
  cur text := case when upper(p_currency) in (select code from public.currencies) then upper(p_currency) else 'EUR' end;
begin
  if coalesce(p_qty, 0) < 1 or p_qty > 10000000 then raise exception 'Quantité invalide' using errcode = '22023'; end if;
  v_lot := app.pick_lot(p_mpn, p_source, p_ship_from, p_qty);
  if v_lot is null then raise exception 'Offre introuvable' using errcode = 'P0002'; end if;
  select qty, moq, standard_pack_quantity into v_avail, v_moq, v_spq from public.lots where id = v_lot;
  v_price := app.buyer_price(v_lot, p_qty, cur);
  return jsonb_build_object('currency', cur, 'qty', p_qty, 'unit_price', v_price,
    'total', round(v_price * p_qty, 2), 'covered', v_avail >= p_qty,
    'moq', greatest(coalesce(v_moq, 1), 1), 'spq', v_spq, 'min_qty', app.lot_min_qty(v_moq, v_spq), 'qty_ok', app.qty_ok(p_qty, v_moq, v_spq));
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
        delivery_country, delivery_address, message, access_hash, ip_hash)
    values (v_cart, upper(l.mpn), v_line->>'source', v_line->>'ship_from', v_qty, v_lot, l.seller_id, v_cur, v_price,
        app.lot_price_for(v_lot, v_qty), l.currency, left(btrim(p->>'company'), 160),
        upper(regexp_replace(p->>'vat', '[\s.-]', '', 'g')), coalesce((p->>'vat_checked')::boolean, false),
        left(btrim(p->>'name'), 120), lower(btrim(p->>'email')), left(nullif(btrim(p->>'phone'), ''), 40),
        upper(p->>'country'), left(btrim(p->>'address'), 500), left(nullif(btrim(p->>'message'), ''), 1000),
        encode(extensions.digest(v_token, 'sha256'), 'hex'), v_ip)
    returning id into v_id;
    insert into public.events (actor, text, ref) values ('buyer', 'Panier ' || v_cart || ', demande ' || v_id || ' : ' || upper(l.mpn) || ' × ' || v_qty, l.seller_id);
    v_out := v_out || jsonb_build_object('ref', v_id, 'mpn', upper(l.mpn), 'qty', v_qty, 'unit_price', v_price,
      'total', round(v_price * v_qty, 2), 'covered', l.qty >= v_qty);
    if v_price is null then v_priced := false; else v_total := v_total + round(v_price * v_qty, 2); end if;
  end loop;
  return jsonb_build_object('ref', v_cart, 'token', v_token, 'currency', v_cur, 'lines', v_out,
    'total', case when v_priced then v_total end);
end $$;

revoke execute on function app.lot_min_qty(int, int), app.qty_ok(int, int, int) from public, anon, authenticated;
revoke execute on function public.partner_offers(text, text, text), public.public_quote(text, text, text, int, text),
  public.create_purchase_cart(text, jsonb) from public, anon, authenticated;
grant execute on function public.partner_offers(text, text, text), public.public_quote(text, text, text, int, text),
  public.create_purchase_cart(text, jsonb) to service_role;
