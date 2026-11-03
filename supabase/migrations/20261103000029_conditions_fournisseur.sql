-- Conditions de vente de Central.Parts : transport, délais, retours, garantie (décision de Bertier, 3 novembre 2026 :
-- « on crée notre propre règle en s'inspirant de celle de [distributeur partenaire] »). ADR 0029, complément.
--
-- Règle de Central.Parts, pour toutes les offres : app.settings « default_terms » (JSON, réglable sans code).
-- Exception pour un fournisseur : une ligne dans app.seller_terms, saisie par l'opérateur (jamais dans le dépôt),
-- qui remplace la règle pour ses offres. Champs (règle ou exception) :
--   incoterm FCA ou DAP (le fournisseur livre lui-même jusqu'à l'adresse de l'acheteur, droits à la charge de celui-ci) ;
--   livraison offerte au-delà d'un montant de commande chez ce fournisseur (dans sa devise, converti pour l'affichage) ;
--   transporteurs, délai d'expédition (heures), délai d'acheminement (jours ouvrés), paiement d'avance ;
--   retours (jours, défaut qualité seulement, frais de remise en stock), garantie (jours).
-- partner_offers, public_search et public_quote renvoient « terms » (et l'incoterm qui en découle) ; cart_shipping
-- regroupe les lignes d'un panier par fournisseur, sans le nommer, pour dire si la livraison est offerte.
-- Fonctions recopiées depuis 20261103000028 ; seules ces clés changent. Rejouable.

create table if not exists app.seller_terms (
  org_id                 text primary key references public.organizations on delete cascade,
  incoterm               text not null default 'FCA' check (incoterm in ('FCA', 'DAP')),
  free_shipping_over     numeric(12,2) check (free_shipping_over >= 0),
  free_shipping_currency char(3) references public.currencies,
  carriers               text[],
  ship_within_hours      integer check (ship_within_hours between 1 and 720),
  transit_days_min       integer check (transit_days_min between 1 and 90),
  transit_days_max       integer check (transit_days_max between 1 and 90),
  prepaid                boolean not null default true,
  returns_days           integer check (returns_days between 0 and 400),
  returns_quality_only   boolean not null default false,
  restocking_pct         numeric(5,2) check (restocking_pct between 0 and 100),
  warranty_days          integer check (warranty_days between 0 and 3650),
  updated_at             timestamptz not null default now()
);
revoke all on app.seller_terms from public, anon, authenticated;

-- Règle de Central.Parts (inspirée des conditions publiées d'un distributeur partenaire de Hong Kong) : livraison
-- express jusqu'à l'adresse de l'acheteur (DAP), droits, taxes et frais de dédouanement à sa charge ; livraison
-- offerte au-delà de 2 000 € par envoi d'un même fournisseur, sinon chiffrée sur la proforma ; paiement d'avance ;
-- retours sous 30 jours pour défaut qualité, 15 % de remise en stock si erreur de commande ; garantie 90 jours.
-- Valeurs à valider avec la relecture juridique (après le 16 novembre 2026) ; modifiables par
-- update app.settings set value = '…' where name = 'default_terms'.
insert into app.settings (name, value) values ('default_terms', '{"incoterm": "DAP", "free_shipping_over": 2000,
  "free_shipping_currency": "EUR", "carriers": ["DHL", "FedEx", "UPS", "SF"], "ship_within_hours": 48,
  "transit_days_min": 5, "transit_days_max": 7, "prepaid": true, "returns_days": 30, "returns_quality_only": true,
  "restocking_pct": 15, "warranty_days": 90}') on conflict (name) do nothing;

-- Conditions publiques d'une offre (jamais le nom du fournisseur) : exception du fournisseur, sinon règle de
-- Central.Parts ; seuil converti dans la devise demandée. Null si ni l'une ni l'autre.
create or replace function app.terms_json(p_org text, p_cur text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare t app.seller_terms; d jsonb;
begin
  select * into t from app.seller_terms where org_id = p_org;
  if t.org_id is null then
    select value::jsonb into d from app.settings where name = 'default_terms';
    if d is null or d = '{}'::jsonb then return null; end if;
    t := jsonb_populate_record(null::app.seller_terms, d || jsonb_build_object('org_id', p_org));
  end if;
  return jsonb_strip_nulls(jsonb_build_object(
    'incoterm', coalesce(t.incoterm, 'FCA'),
    'free_shipping_over', case when t.free_shipping_over is not null
      then ceil(t.free_shipping_over * coalesce(app.fx(coalesce(t.free_shipping_currency, 'EUR'), p_cur), 1)) end,
    'carriers', to_jsonb(t.carriers), 'ship_within_hours', t.ship_within_hours,
    'transit_days_min', t.transit_days_min, 'transit_days_max', t.transit_days_max, 'prepaid', t.prepaid,
    'returns_days', t.returns_days, 'returns_quality_only', t.returns_quality_only,
    'restocking_pct', t.restocking_pct, 'warranty_days', t.warranty_days));
end $$;

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
      select upper(l.mpn) as mpn, l.manufacturer, app.source_category(o.profile) as source, o.country as ship_from, app.fca_place(o.country, o.city) as place, l.seller_id, l.qty,
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
  select l.qty, l.moq, l.standard_pack_quantity, app.fca_place(o.country, o.city), l.seller_id into v_avail, v_moq, v_spq, v_place, v_seller
    from public.lots l join public.organizations o on o.id = l.seller_id where l.id = v_lot;
  v_price := app.buyer_price(v_lot, p_qty, cur);
  return jsonb_build_object('currency', cur, 'qty', p_qty, 'unit_price', v_price,
    'total', round(v_price * p_qty, 2), 'covered', v_avail >= p_qty,
    'moq', greatest(coalesce(v_moq, 1), 1), 'spq', v_spq, 'min_qty', app.lot_min_qty(v_moq, v_spq), 'qty_ok', app.qty_ok(p_qty, v_moq, v_spq),
    'incoterm', coalesce(app.terms_json(v_seller, cur)->>'incoterm', 'FCA'), 'fca_place', v_place, 'terms', app.terms_json(v_seller, cur));
end $$;

-- ------------------------------------------------------------ livraison d'un panier
-- p jsonb : lines [{mpn, source, ship_from, qty}], currency. Regroupe les lignes par fournisseur (numérotés 1, 2… dans
-- l'ordre du panier, jamais nommés) : sous-total, conditions, livraison offerte ou non, montant manquant.
create or replace function public.cart_shipping(p_ip text, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  cur text := case when upper(p->>'currency') in (select code from public.currencies) then upper(p->>'currency') else 'EUR' end;
  v_line jsonb; v_i int := 0; v_qty int; v_lot text; v_seller text; v_price numeric;
  v_groups jsonb := '[]'; v_order text[] := '{}'; v_sub jsonb := '{}';
begin
  perform app.count_search(p_ip);
  if jsonb_typeof(p->'lines') <> 'array' or jsonb_array_length(p->'lines') > 30 then
    raise exception 'Panier invalide' using errcode = '22023';
  end if;
  for v_line in select * from jsonb_array_elements(p->'lines') loop
    v_qty := case when coalesce(v_line->>'qty', '') ~ '^\d{1,8}$' then (v_line->>'qty')::int end;
    v_lot := case when v_qty > 0 then app.pick_lot(v_line->>'mpn', v_line->>'source', v_line->>'ship_from', v_qty) end;
    if v_lot is not null then
      select seller_id into v_seller from public.lots where id = v_lot;
      v_price := app.buyer_price(v_lot, v_qty, cur);
      if not v_seller = any(v_order) then v_order := v_order || v_seller; end if;
      v_sub := jsonb_set(v_sub, array[v_seller], jsonb_build_object(
        'lines', coalesce(v_sub->v_seller->'lines', '[]') || to_jsonb(v_i),
        'subtotal', coalesce((v_sub->v_seller->>'subtotal')::numeric, 0) + coalesce(round(v_price * v_qty, 2), 0),
        'priced', coalesce((v_sub->v_seller->>'priced')::boolean, true) and v_price is not null));
    end if;
    v_i := v_i + 1;
  end loop;
  for v_i in 1 .. coalesce(array_length(v_order, 1), 0) loop
    declare g jsonb := v_sub->v_order[v_i]; t jsonb := app.terms_json(v_order[v_i], cur); lim numeric := (t->>'free_shipping_over')::numeric;
    begin
      v_groups := v_groups || jsonb_strip_nulls(jsonb_build_object('group', v_i, 'lines', g->'lines', 'subtotal', g->'subtotal',
        'incoterm', coalesce(t->>'incoterm', 'FCA'), 'terms', t,
        'free_shipping', lim is not null and (g->>'priced')::boolean and (g->>'subtotal')::numeric >= lim,
        'missing_for_free', case when lim is not null and (g->>'subtotal')::numeric < lim then lim - (g->>'subtotal')::numeric end));
    end;
  end loop;
  return jsonb_build_object('currency', cur, 'groups', v_groups);
end $$;

revoke execute on function app.terms_json(text, text) from public, anon, authenticated;
revoke execute on function public.public_search(text, text, text), public.partner_offers(text, text, text),
  public.public_quote(text, text, text, int, text), public.cart_shipping(text, jsonb) from public, anon, authenticated;
grant execute on function public.public_search(text, text, text), public.partner_offers(text, text, text),
  public.public_quote(text, text, text, int, text), public.cart_shipping(text, jsonb) to service_role;
