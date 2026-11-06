-- Fabricants partenaires et fabricants distribués sur /offres/ (décision de Bertier, 6 novembre 2026 : « il faut
-- distinguer les fabricants partenaires et les fabricants distribués »), et regroupement des variantes de nom.
--   app.mfr_key : nom normalisé (capitales, ponctuation et suffixes de société retirés : Inc., Co., Ltd., Corporation, AG…),
--                 pour regrouper « Analog Devices » et « Analog Devices Inc. » dans les boutons et le filtre ;
--   manufacturers[] : { name, key, offers, partner } ; partner : fabricant rattaché à un compte dans le back office
--                 (canal direct, ADR 0032), affiché à part ; manufacturer : clé du filtre appliqué.
-- Remplace partner_offers (20261106000038), recopiée. Rejouable.

create or replace function app.mfr_key(p text) returns text
language sql immutable set search_path = '' as $$
  select nullif(btrim(regexp_replace(regexp_replace(regexp_replace(upper(coalesce(p, '')), '[().,]', ' ', 'g'),
    '\m(INC|INCORPORATED|CO|COMPANY|LTD|LIMITED|CORP|CORPORATION|AG|GMBH|LLC|PLC|SA|SAS|BV|NV|GROUP|HOLDINGS?)\M', ' ', 'g'),
    '\s+', ' ', 'g')), '')
$$;
revoke execute on function app.mfr_key(text) from public, anon, authenticated;

create or replace function public.partner_offers(p_ip text, q text default '', p_currency text default 'EUR', p_mfr text default '')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  k text := upper(regexp_replace(coalesce(q, ''), '\s+', '', 'g'));
  mf text := app.mfr_key(p_mfr);
  cur text := case when upper(p_currency) in (select code from public.currencies) then upper(p_currency) else 'EUR' end;
begin
  if length(k) between 1 and 2 then raise exception 'Saisir au moins 3 caractères' using errcode = '22023'; end if;
  perform app.count_search(p_ip);
  return (
    with base as (
      select l.mpn, l.qty, l.manufacturer
        from public.lots l
        join public.organizations o on o.id = l.seller_id
       where (k = '' or upper(l.mpn) like k || '%') and l.qty > 0 and l.confirmed_at > now() - app.org_ttl(o.offer_ttl_days, o.profile)
         and app.is_verified(l.seller_id) and not o.sandbox),
    live as (select * from base where mf is null or app.mfr_key(manufacturer) = mf),
    -- Fabricants regroupés par nom normalisé (« Analog Devices » et « Analog Devices Inc. ») ; nom affiché : le plus court,
    -- de préférence pas tout en capitales. Partenaire : fabricant rattaché à un compte dans le back office (canal direct).
    groups as (
      select app.mfr_key(manufacturer) as key,
             (array_agg(btrim(manufacturer) order by btrim(manufacturer) = upper(btrim(manufacturer)), length(btrim(manufacturer)), btrim(manufacturer)))[1] as name,
             count(*)::int as n
        from base where app.mfr_key(manufacturer) is not null group by 1),
    facet as (
      select g.*, exists (select 1 from public.manufacturers m join public.manufacturer_distributors d on d.manufacturer_id = m.id
                            where g.key in (select app.mfr_key(b) from unnest(m.brands) b)) as partner
        from groups g),
    facet_top as (select * from facet order by partner desc, n desc, name limit 40),
    picked as (
      select l.*, o.profile, o.country, app.lot_place(l.id) as place
        from public.lots l
        join public.organizations o on o.id = l.seller_id
       where (k = '' or upper(l.mpn) like k || '%') and l.qty > 0 and l.confirmed_at > now() - app.org_ttl(o.offer_ttl_days, o.profile)
         and app.is_verified(l.seller_id) and not o.sandbox and (mf is null or app.mfr_key(l.manufacturer) = mf)
       order by l.confirmed_at desc
       limit 50)
    select jsonb_build_object('query', k, 'currency', cur, 'manufacturer', mf,
      'manufacturers', (select coalesce(jsonb_agg(jsonb_build_object('name', f.name, 'key', f.key, 'offers', f.n, 'partner', f.partner)
                          order by f.partner desc, f.n desc, f.name), '[]') from facet_top f),
      'total_refs', (select count(distinct upper(mpn)) from live), 'total_offers', (select count(*) from live),
      'total_units', (select coalesce(sum(qty), 0) from live), 'ttl_days', extract(day from app.offer_ttl())::int,
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
