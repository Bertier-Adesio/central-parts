-- Panier des acheteurs : une seule demande pour plusieurs références (décision de Bertier, 3 novembre 2026). ADR 0028.
--
-- Un panier (CART-…) regroupe des demandes d'achat ordinaires (PR-…), une par ligne : chaque ligne garde son lot, son
-- fournisseur, son prix figé et son statut, et passe par la validation de l'administrateur (ADR 0026) avant tout envoi
-- au fournisseur. L'acheteur reçoit une seule référence et un seul lien de suivi pour tout le panier.
-- Ajoute purchase_requests.cart_id, create_purchase_cart, purchase_cart_status ; request_for_operator donne le panier.
-- Rejouable.

create sequence if not exists app.cart_seq start 1;
grant usage on sequence app.cart_seq to service_role;
alter table public.purchase_requests add column if not exists cart_id text;
create index if not exists purchase_requests_cart_idx on public.purchase_requests (cart_id) where cart_id is not null;

-- Contrôle des coordonnées de l'acheteur, commun à la demande seule et au panier. Erreur 22023 sinon.
create or replace function app.check_buyer(p jsonb) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if coalesce(btrim(p->>'company'), '') = '' or coalesce(btrim(p->>'name'), '') = '' or coalesce(btrim(p->>'address'), '') = ''
     or coalesce(p->>'email', '') !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
     or upper(regexp_replace(coalesce(p->>'vat', ''), '[\s.-]', '', 'g')) !~ '^(AT|BE|BG|CY|CZ|DE|DK|EE|EL|ES|FI|FR|HR|HU|IE|IT|LT|LU|LV|MT|NL|PL|PT|RO|SE|SI|SK|XI|GB|CH|NO)[0-9A-Z]{2,13}$'
     or upper(coalesce(p->>'country', '')) !~ '^[A-Z]{2}$' then
    raise exception 'Champ manquant ou invalide' using errcode = '22023';
  end if;
end $$;

-- Enregistre un panier. p jsonb : lines [{mpn, source, ship_from, qty}] (1 à 30 lignes), currency, company, vat,
-- vat_checked, name, email, phone, country, address, message. Tout ou rien : une ligne invalide annule le panier.
-- Renvoie la référence du panier, le jeton de suivi (affiché une seule fois) et le devis de chaque ligne.
-- Erreurs : 22023 champ ou ligne invalide, P0002 offre introuvable (detail : la référence), CP429 trop de demandes.
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

-- Suivi du panier par l'acheteur, avec son jeton : chaque ligne et son statut, jamais le fournisseur.
create or replace function public.purchase_cart_status(p_cart text, p_token text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when count(*) > 0 then jsonb_build_object('ref', upper(p_cart), 'cart', true, 'currency', min(r.currency),
    'created_at', min(r.created_at), 'updated_at', max(r.updated_at),
    'total', case when bool_and(r.unit_price is not null) then sum(round(r.unit_price * r.qty, 2)) end,
    'lines', jsonb_agg(jsonb_build_object('ref', r.id, 'status', r.status, 'mpn', r.mpn, 'qty', r.qty,
      'unit_price', r.unit_price, 'total', round(r.unit_price * r.qty, 2), 'source', r.source, 'ship_from', r.ship_from)
      order by r.id)) end
    from public.purchase_requests r
   where r.cart_id = upper(p_cart) and r.access_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
$$;

-- Fiche opérateur : même fiche qu'en 20261103000024, avec le panier.
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
    'created_at', r.created_at, 'updated_at', r.updated_at, 'decided_at', r.decided_at, 'decided_by', r.decided_by,
    'reject_reason', r.reject_reason, 'answered_at', r.answered_at)
    from public.purchase_requests r left join public.organizations o on o.id = r.seller_id
   where r.id = upper(p_ref)
$$;

revoke execute on function app.check_buyer(jsonb), public.create_purchase_cart(text, jsonb), public.purchase_cart_status(text, text),
  public.request_for_operator(text) from public, anon, authenticated;
grant execute on function public.create_purchase_cart(text, jsonb), public.purchase_cart_status(text, text),
  public.request_for_operator(text) to service_role;
