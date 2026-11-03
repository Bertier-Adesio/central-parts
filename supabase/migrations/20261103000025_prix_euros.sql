-- Prix publics en euros, convertis au taux de référence de la Banque centrale européenne, mis à jour chaque jour
-- (décision de Bertier, 3 novembre 2026). ADR 0027.
--
-- Depuis le 2 novembre (migration 20261102000019), /recherche/ et /offres/ montraient les prix dans la devise du
-- fournisseur, faute de taux tenus à jour. Les taux de public.currencies sont désormais tenus par la fonction Edge
-- « rappels » (tâche planifiée horaire, une mise à jour par jour) avec set_eur_rates. public_search et partner_offers
-- convertissent chaque lot dans la devise demandée (EUR par défaut), marge comprise, et renvoient la date du taux le
-- plus ancien utilisé (« rates_at »). La recherche ne regroupe plus par devise.
-- Remplace public_search et partner_offers (20261103000023). Rejouable.

-- ------------------------------------------------------------ taux de la BCE
-- p_rates : unités de devise pour 1 euro, comme la BCE ({"USD": 1.0812, "CNY": 7.71, …}) ; p_date : date du taux.
-- Le yuan offshore (CNH) prend le taux du yuan (CNY) : la BCE ne publie pas le CNH. Un taux qui s'écarte de plus de
-- 30 % du précédent est ignoré (donnée aberrante), et noté dans la réponse. Renvoie les devises mises à jour.
create or replace function public.set_eur_rates(p_rates jsonb, p_date date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; v_src text; v_per_eur numeric; v_new numeric; v_done jsonb := '[]'; v_skip jsonb := '[]';
begin
  if p_date is null or p_date > current_date + 1 or p_date < current_date - 10 then
    raise exception 'Date de taux invalide : %', p_date using errcode = '22023';
  end if;
  for c in select code, eur_rate from public.currencies where code <> 'EUR' loop
    v_src := case when c.code = 'CNH' then 'CNY' else c.code end;
    v_per_eur := case when jsonb_typeof(p_rates->v_src) = 'number' then (p_rates->>v_src)::numeric
                      when coalesce(p_rates->>v_src, '') ~ '^\d+(\.\d+)?$' then (p_rates->>v_src)::numeric end;
    if v_per_eur is null or v_per_eur <= 0 then continue; end if;
    v_new := round(1 / v_per_eur, 8);
    if c.eur_rate > 0 and abs(v_new / c.eur_rate - 1) > 0.3 then
      v_skip := v_skip || to_jsonb(c.code);
      continue;
    end if;
    -- Taux de référence publié vers 16 h, heure de Francfort.
    update public.currencies set eur_rate = v_new, rate_at = (p_date + time '16:00') at time zone 'Europe/Berlin'
     where code = c.code;
    v_done := v_done || to_jsonb(c.code);
  end loop;
  return jsonb_build_object('date', p_date, 'updated', v_done, 'skipped', v_skip);
end $$;

-- Date du taux le plus récent (la tâche planifiée ne rappelle la BCE qu'une fois par jour).
create or replace function public.eur_rates_at()
returns timestamptz language sql stable security definer set search_path = '' as $$
  select min(rate_at) from public.currencies where code <> 'EUR'
$$;

-- Facteur de conversion d'une devise vers une autre (via l'euro).
create or replace function app.fx(p_from text, p_to text) returns numeric
language sql stable security definer set search_path = '' as $$
  select f.eur_rate / t.eur_rate from public.currencies f, public.currencies t where f.code = p_from and t.code = p_to
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
      select upper(l.mpn) as mpn, l.manufacturer, app.source_category(o.profile) as source, o.country as ship_from, l.qty,
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
               'moq', p.moq,
               'price_from', round(least(p.unit_price, (select min(b.unit_price) from public.lot_price_breaks b where b.lot_id = p.id))
                                   * app.fx(p.currency, cur) * (1 + app.offer_margin(p.seller_id) / 100), 4),
               'price_1k', round(case when coalesce(p.moq, 1) <= 1000 then app.lot_price_for(p.id, 1000) end
                                 * app.fx(p.currency, cur) * (1 + app.offer_margin(p.seller_id) / 100), 4),
               'updated_at', p.confirmed_at) order by upper(p.mpn), p.confirmed_at desc), '[]') from picked p)));
end $$;

-- ------------------------------------------------------------ droits
revoke execute on function public.set_eur_rates(jsonb, date), public.eur_rates_at(), app.fx(text, text)
  from public, anon, authenticated;
grant execute on function public.set_eur_rates(jsonb, date), public.eur_rates_at() to service_role;
revoke execute on function public.public_search(text, text, text), public.partner_offers(text, text, text) from public, anon, authenticated;
grant execute on function public.public_search(text, text, text), public.partner_offers(text, text, text) to service_role;
