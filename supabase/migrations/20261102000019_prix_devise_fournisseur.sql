-- Prix publics dans la devise du fournisseur (devise de l'import), sans conversion (décision du 2 novembre 2026 ;
-- la conversion sera traitée plus tard).
--
-- public_search et partner_offers renvoient price_from et price_1k dans la devise du lot, marge comprise, avec la
-- devise sur chaque offre (« currency »). La recherche regroupe désormais aussi par devise : deux vendeurs de la même
-- référence dans deux devises donnent deux offres. Le paramètre p_currency est gardé pour compatibilité ; la clé
-- « currency » de premier niveau reprend sa valeur, pour les pages encore en cache, et ne doit plus être utilisée.
-- Remplace public_search et partner_offers (20261102000018). Rejouable.

-- ------------------------------------------------------------ recherche publique (/recherche/) : offres à jour seulement
-- Même réponse qu'en 20261101000010 ; les lots non reconfirmés depuis le seuil n'y figurent plus.
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
       where upper(l.mpn) like k || '%' and l.qty > 0 and app.lot_fresh(l.confirmed_at)
         and app.is_verified(l.seller_id) and not o.sandbox
       group by upper(l.mpn), app.source_category(o.profile), o.country, l.currency
       limit 50) s));
end $$;
revoke execute on function public.public_search(text, text, text) from public, anon, authenticated;
grant execute on function public.public_search(text, text, text) to service_role;

-- ------------------------------------------------------------ API acheteur : une ligne par offre, vendeur anonyme
-- GET /functions/v1/offers?q=TPS&cur=EUR. Sans q : les 50 offres confirmées le plus récemment.
-- Le vendeur n'apparaît jamais (ni nom, ni pseudonyme, ni SKU, ni lien) : « supplier » vaut toujours « partner ».
-- Quantité par tranche et prix « à partir de » tout compris, comme la recherche publique (ADR 0013).
-- seller_category est réservé au modèle à deux axes (ADR 0021), null tant qu'il n'est pas défini.
create or replace function public.partner_offers(p_ip text, q text default '', p_currency text default 'EUR')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  k text := upper(regexp_replace(coalesce(q, ''), '\s+', '', 'g'));
  cur text := case when upper(p_currency) in (select code from public.currencies) then upper(p_currency) else 'EUR' end;
begin
  if length(k) between 1 and 2 then raise exception 'Saisir au moins 3 caractères' using errcode = '22023'; end if;
  perform app.count_search(p_ip);
  return jsonb_build_object('query', k, 'currency', cur, 'ttl_days', extract(day from app.offer_ttl())::int, 'offers', (
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
       where (k = '' or upper(l.mpn) like k || '%') and l.qty > 0 and app.lot_fresh(l.confirmed_at)
         and app.is_verified(l.seller_id) and not o.sandbox
       order by l.confirmed_at desc
       limit 50) s));
end $$;
