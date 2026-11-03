-- Incoterm des prix publics : FCA au lieu d'expédition, Incoterms® 2020 (décision de Bertier, 3 novembre 2026,
-- sur l'analyse de Cowork). ADR 0029.
--
-- Le fournisseur remet la marchandise, dédouanée à l'export, au transporteur désigné ; le prix est hors transport,
-- droits et TVA à l'import. Le lieu est un code court (HK, SZ, DG, GZ, SH, XM ; sinon le pays : CN, TW…), déduit de
-- la ville et du pays du fournisseur ; les pages l'affichent dans leur langue (« FCA Hong Kong », « FCA 深圳 »).
-- public_search, partner_offers et public_quote renvoient incoterm et fca_place. Fonctions recopiées depuis
-- 20261103000025 et 20261103000027 ; seules ces clés changent. Rejouable.

create or replace function app.fca_place(p_country text, p_city text) returns text
language sql immutable set search_path = '' as $$
  select case
    when lower(btrim(coalesce(p_city, ''))) in ('hong kong', 'hongkong', 'hk', '香港', '香港特别行政区') or upper(p_country) = 'HK' then 'HK'
    when lower(btrim(coalesce(p_city, ''))) in ('shenzhen', '深圳', '深圳市') then 'SZ'
    when lower(btrim(coalesce(p_city, ''))) in ('dongguan', '东莞', '东莞市') then 'DG'
    when lower(btrim(coalesce(p_city, ''))) in ('guangzhou', 'canton', '广州', '广州市') then 'GZ'
    when lower(btrim(coalesce(p_city, ''))) in ('shanghai', '上海', '上海市') then 'SH'
    when lower(btrim(coalesce(p_city, ''))) in ('xiamen', '厦门', '厦门市') then 'XM'
    else upper(coalesce(nullif(btrim(p_country), ''), 'CN')) end
$$;

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
      select upper(l.mpn) as mpn, l.manufacturer, app.source_category(o.profile) as source, o.country as ship_from, app.fca_place(o.country, o.city) as place, l.qty,
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
                 'incoterm', 'FCA', 'fca_place', case when count(distinct place) = 1 then min(place) else ship_from end,
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
      select l.*, o.profile, o.country, app.fca_place(o.country, o.city) as place
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
               'ship_from', p.country, 'incoterm', 'FCA', 'fca_place', p.place,
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
  v_lot text; v_price numeric; v_avail int; v_moq int; v_spq int; v_place text;
  cur text := case when upper(p_currency) in (select code from public.currencies) then upper(p_currency) else 'EUR' end;
begin
  if coalesce(p_qty, 0) < 1 or p_qty > 10000000 then raise exception 'Quantité invalide' using errcode = '22023'; end if;
  v_lot := app.pick_lot(p_mpn, p_source, p_ship_from, p_qty);
  if v_lot is null then raise exception 'Offre introuvable' using errcode = 'P0002'; end if;
  select l.qty, l.moq, l.standard_pack_quantity, app.fca_place(o.country, o.city) into v_avail, v_moq, v_spq, v_place
    from public.lots l join public.organizations o on o.id = l.seller_id where l.id = v_lot;
  v_price := app.buyer_price(v_lot, p_qty, cur);
  return jsonb_build_object('currency', cur, 'qty', p_qty, 'unit_price', v_price,
    'total', round(v_price * p_qty, 2), 'covered', v_avail >= p_qty,
    'moq', greatest(coalesce(v_moq, 1), 1), 'spq', v_spq, 'min_qty', app.lot_min_qty(v_moq, v_spq), 'qty_ok', app.qty_ok(p_qty, v_moq, v_spq),
    'incoterm', 'FCA', 'fca_place', v_place);
end $$;

revoke execute on function app.fca_place(text, text) from public, anon, authenticated;
revoke execute on function public.public_search(text, text, text), public.partner_offers(text, text, text),
  public.public_quote(text, text, text, int, text) from public, anon, authenticated;
grant execute on function public.public_search(text, text, text), public.partner_offers(text, text, text),
  public.public_quote(text, text, text, int, text) to service_role;
