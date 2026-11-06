-- Recherche rapide par fabricant sur /offres/ (décision de Bertier, 6 novembre 2026 : « dans les offres ajouter une
-- recherche rapide par fabricant »).
--   p_mfr        : fabricant choisi (insensible à la casse), combiné avec la recherche par référence ;
--   manufacturer : fabricant appliqué ; manufacturers : les 30 fabricants les plus présents dans les offres de la recherche
--                  (sans le filtre fabricant), avec leur nombre d'offres, pour les boutons de la page.
-- Les totaux (20261106000036) suivent les deux filtres. Remplace partner_offers (20261106000036), recopiée avec un
-- paramètre de plus. Rejouable.

drop function if exists public.partner_offers(text, text, text);

create or replace function public.partner_offers(p_ip text, q text default '', p_currency text default 'EUR', p_mfr text default '')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  k text := upper(regexp_replace(coalesce(q, ''), '\s+', '', 'g'));
  mf text := upper(btrim(coalesce(p_mfr, '')));
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
    live as (select * from base where mf = '' or upper(btrim(manufacturer)) = mf),
    facet as (
      -- Nom affiché : de préférence une graphie qui n'est pas tout en capitales.
      select (array_agg(btrim(manufacturer) order by btrim(manufacturer) = upper(btrim(manufacturer)), btrim(manufacturer)))[1] as name, count(*)::int as n
        from base where btrim(coalesce(manufacturer, '')) <> ''
       group by upper(btrim(manufacturer)) order by count(*) desc, 1 limit 30),
    picked as (
      select l.*, o.profile, o.country, app.lot_place(l.id) as place
        from public.lots l
        join public.organizations o on o.id = l.seller_id
       where (k = '' or upper(l.mpn) like k || '%') and l.qty > 0 and l.confirmed_at > now() - app.org_ttl(o.offer_ttl_days, o.profile)
         and app.is_verified(l.seller_id) and not o.sandbox and (mf = '' or upper(btrim(l.manufacturer)) = mf)
       order by l.confirmed_at desc
       limit 50)
    select jsonb_build_object('query', k, 'currency', cur, 'manufacturer', nullif(mf, ''),
      'manufacturers', (select coalesce(jsonb_agg(jsonb_build_object('name', f.name, 'offers', f.n) order by f.n desc, f.name), '[]') from facet f),
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

revoke execute on function public.partner_offers(text, text, text, text) from public, anon, authenticated;
grant execute on function public.partner_offers(text, text, text, text) to service_role;
