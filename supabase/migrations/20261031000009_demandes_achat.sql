-- Demandes d'achat depuis la recherche publique (ADR 0014).
--
-- 1. Un visiteur (société avec numéro de TVA) choisit une offre de la recherche publique et une quantité :
--    public_quote donne le prix tout compris pour cette quantité ; create_purchase_request enregistre la demande.
--    Central.Parts vend (achat-revente) : le fournisseur n'est jamais nommé à l'acheteur.
-- 2. Le fournisseur confirme ou refuse, dans WeChat (确认 / 无货 PR-…) ou sur la page /depot/ : supplier_answer.
-- 3. L'opérateur envoie la facture proforma, constate le virement, l'expédition : operator_set_request_status.
-- 4. L'acheteur suit sa demande avec le lien reçu à la création : purchase_request_status (jeton, empreinte seule gardée).

create sequence app.pr_seq start 1;

create table public.purchase_requests (
  id                 text primary key default app.ref('PR', 'app.pr_seq'),
  created_at         timestamptz not null default now(),
  status             text not null default 'submitted' check (status in
                       ('submitted', 'confirmed', 'unavailable', 'proforma_sent', 'paid', 'shipped', 'cancelled')),
  -- Offre choisie dans la recherche publique, et lot retenu.
  mpn                text not null,
  source             text not null,
  ship_from          text not null,
  qty                integer not null check (qty > 0),
  lot_id             text references public.lots on delete set null,
  seller_id          text references public.organizations,
  -- Prix tout compris pour l'acheteur (null : prix à confirmer) et prix net du fournisseur, figés à la demande.
  currency           char(3) not null references public.currencies,
  unit_price         numeric(18,6),
  supplier_unit_price numeric(18,6),
  supplier_currency  char(3) references public.currencies,
  -- Acheteur : société de l'Union européenne ou du Royaume-Uni, numéro de TVA vérifié si possible.
  buyer_company      text not null,
  buyer_vat          text not null,
  vat_checked        boolean not null default false,
  buyer_name         text not null,
  buyer_email        text not null check (buyer_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  buyer_phone        text,
  delivery_country   char(2) not null,
  delivery_address   text not null,
  message            text,
  access_hash        text not null,       -- empreinte du jeton de suivi de l'acheteur
  ip_hash            text,
  answered_at        timestamptz,
  answered_by        text,                -- openid du contact fournisseur qui a répondu
  updated_at         timestamptz not null default now()
);
create index on public.purchase_requests (seller_id, created_at desc);
alter table public.purchase_requests enable row level security;
revoke all on public.purchase_requests from anon, authenticated;
create policy ops on public.purchase_requests for select to authenticated using (app.is_ops());
grant select on public.purchase_requests to authenticated;

-- Prix net du fournisseur pour une quantité : palier le plus élevé atteint, sinon prix unitaire.
create or replace function app.lot_price_for(p_lot text, p_qty int) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce((select b.unit_price from public.lot_price_breaks b where b.lot_id = p_lot and b.min_qty <= p_qty
                    order by b.min_qty desc limit 1),
                  (select l.unit_price from public.lots l where l.id = p_lot))
$$;

-- Lot retenu pour une offre de la recherche publique (référence, catégorie, pays) et une quantité :
-- le moins cher qui couvre la quantité, sinon celui qui en a le plus (le fournisseur confirmera).
create or replace function app.pick_lot(p_mpn text, p_source text, p_ship_from text, p_qty int) returns text
language sql stable security definer set search_path = '' as $$
  select l.id from public.lots l join public.organizations o on o.id = l.seller_id
   where upper(l.mpn) = upper(p_mpn) and app.source_category(o.profile) = p_source and o.country = p_ship_from
     and l.qty > 0 and app.is_verified(l.seller_id) and not o.sandbox
   order by (l.qty >= p_qty) desc,
            case when l.qty >= p_qty then app.lot_price_for(l.id, p_qty) end asc nulls last,
            l.qty desc
   limit 1
$$;

-- Prix tout compris pour l'acheteur : prix net converti, plus la marge de la catégorie (null sans règle ou sans prix).
create or replace function app.buyer_price(p_lot text, p_qty int, p_currency text) returns numeric
language sql stable security definer set search_path = '' as $$
  select round(app.lot_price_for(l.id, p_qty) * c.eur_rate / t.eur_rate * (1 + pr.margin_pct / 100), 4)
    from public.lots l join public.organizations o on o.id = l.seller_id
    join public.currencies c on c.code = l.currency
    join public.currencies t on t.code = p_currency
    join app.price_rules pr on pr.category = app.source_category(o.profile)
   where l.id = p_lot
$$;

-- Devis affiché avant la demande : prix unitaire et total tout compris ; la quantité exacte du lot n'est jamais révélée.
create or replace function public.public_quote(p_mpn text, p_source text, p_ship_from text, p_qty int, p_currency text default 'EUR')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_lot text; v_price numeric; v_avail int;
  cur text := case when upper(p_currency) in (select code from public.currencies) then upper(p_currency) else 'EUR' end;
begin
  if coalesce(p_qty, 0) < 1 or p_qty > 10000000 then raise exception 'Quantité invalide' using errcode = '22023'; end if;
  v_lot := app.pick_lot(p_mpn, p_source, p_ship_from, p_qty);
  if v_lot is null then raise exception 'Offre introuvable' using errcode = 'P0002'; end if;
  select qty into v_avail from public.lots where id = v_lot;
  v_price := app.buyer_price(v_lot, p_qty, cur);
  return jsonb_build_object('currency', cur, 'qty', p_qty, 'unit_price', v_price,
    'total', round(v_price * p_qty, 2), 'covered', v_avail >= p_qty);
end $$;

-- Enregistre une demande d'achat. p jsonb : mpn, source, ship_from, qty, currency, company, vat, vat_checked, name,
-- email, phone, country, address, message. Renvoie la référence, le devis, et le jeton de suivi (affiché une seule fois).
-- Erreurs : 22023 champ invalide, P0002 offre introuvable, CP429 trop de demandes.
create or replace function public.create_purchase_request(p_ip text, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_qty int; v_lot text; v_cur text; v_price numeric; v_token text := encode(extensions.gen_random_bytes(18), 'hex');
  v_ip text := encode(extensions.digest(coalesce(p_ip, '') || current_date::text, 'sha256'), 'hex');
  v_id text; l public.lots;
begin
  -- 5 demandes par heure et par adresse.
  if (select count(*) from public.purchase_requests where ip_hash = v_ip and created_at > now() - interval '1 hour') >= 5 then
    raise exception 'Trop de demandes, réessayer plus tard' using errcode = 'CP429';
  end if;
  v_qty := case when coalesce(p->>'qty', '') ~ '^\d{1,8}$' then (p->>'qty')::int end;
  if v_qty is null or v_qty < 1 then raise exception 'Quantité invalide' using errcode = '22023'; end if;
  if coalesce(btrim(p->>'company'), '') = '' or coalesce(btrim(p->>'name'), '') = '' or coalesce(btrim(p->>'address'), '') = ''
     or coalesce(p->>'email', '') !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
     or upper(regexp_replace(coalesce(p->>'vat', ''), '[\s.-]', '', 'g')) !~ '^(AT|BE|BG|CY|CZ|DE|DK|EE|EL|ES|FI|FR|HR|HU|IE|IT|LT|LU|LV|MT|NL|PL|PT|RO|SE|SI|SK|XI|GB|CH|NO)[0-9A-Z]{2,13}$'
     or upper(coalesce(p->>'country', '')) !~ '^[A-Z]{2}$' then
    raise exception 'Champ manquant ou invalide' using errcode = '22023';
  end if;
  v_cur := case when upper(p->>'currency') in (select code from public.currencies) then upper(p->>'currency') else 'EUR' end;
  v_lot := app.pick_lot(p->>'mpn', p->>'source', p->>'ship_from', v_qty);
  if v_lot is null then raise exception 'Offre introuvable' using errcode = 'P0002'; end if;
  select * into l from public.lots where id = v_lot;
  v_price := app.buyer_price(v_lot, v_qty, v_cur);
  insert into public.purchase_requests (mpn, source, ship_from, qty, lot_id, seller_id, currency, unit_price,
      supplier_unit_price, supplier_currency, buyer_company, buyer_vat, vat_checked, buyer_name, buyer_email, buyer_phone,
      delivery_country, delivery_address, message, access_hash, ip_hash)
  values (upper(l.mpn), p->>'source', p->>'ship_from', v_qty, v_lot, l.seller_id, v_cur, v_price,
      app.lot_price_for(v_lot, v_qty), l.currency, left(btrim(p->>'company'), 160),
      upper(regexp_replace(p->>'vat', '[\s.-]', '', 'g')), coalesce((p->>'vat_checked')::boolean, false),
      left(btrim(p->>'name'), 120), lower(btrim(p->>'email')), left(nullif(btrim(p->>'phone'), ''), 40),
      upper(p->>'country'), left(btrim(p->>'address'), 500), left(nullif(btrim(p->>'message'), ''), 1000),
      encode(extensions.digest(v_token, 'sha256'), 'hex'), v_ip)
  returning id into v_id;
  insert into public.events (actor, text, ref) values ('buyer', 'Demande d''achat ' || v_id || ' : ' || upper(l.mpn) || ' × ' || v_qty, l.seller_id);
  return jsonb_build_object('ref', v_id, 'token', v_token, 'currency', v_cur, 'unit_price', v_price,
    'total', round(v_price * v_qty, 2), 'covered', l.qty >= v_qty);
end $$;

-- Ce que voit le fournisseur d'une demande : référence, quantité, son prix net, pays de livraison. Jamais l'acheteur.
create or replace function app.request_for_supplier(r public.purchase_requests) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('ref', r.id, 'status', r.status, 'mpn', r.mpn, 'qty', r.qty,
    'lot_qty', (select qty from public.lots where id = r.lot_id), 'unit_price', r.supplier_unit_price,
    'currency', r.supplier_currency, 'delivery_country', r.delivery_country, 'created_at', r.created_at)
$$;

-- Demandes reçues par la société d'un contact WeChat (page /depot/).
create or replace function public.supplier_requests(p_openid text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(app.request_for_supplier(r) order by r.created_at desc), '[]')
    from public.purchase_requests r
   where r.seller_id = (select org_id from public.wechat_identities where openid = p_openid and revoked_at is null)
     and r.created_at > now() - interval '90 days'
$$;

-- Réponse du fournisseur : confirmé ou indisponible. Tout contact de la société peut répondre, une seule fois.
create or replace function public.supplier_answer(p_openid text, p_ref text, p_ok boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.purchase_requests; v_org text;
begin
  select org_id into v_org from public.wechat_identities where openid = p_openid and revoked_at is null;
  select * into r from public.purchase_requests where id = upper(p_ref) for update;
  if r.id is null or v_org is null or r.seller_id is distinct from v_org then
    raise exception 'Demande inconnue : %', p_ref using errcode = 'P0002';
  end if;
  if r.status <> 'submitted' then return app.request_for_supplier(r); end if;
  update public.purchase_requests set status = case when p_ok then 'confirmed' else 'unavailable' end,
         answered_at = now(), answered_by = p_openid, updated_at = now()
   where id = r.id returning * into r;
  insert into public.events (actor, text, ref) values ('seller', 'Demande ' || r.id || (case when p_ok then ' confirmée' else ' indisponible' end), r.seller_id);
  return app.request_for_supplier(r);
end $$;

-- Suite donnée par l'opérateur : proforma envoyée, virement reçu, expédiée, annulée.
create or replace function public.operator_set_request_status(p_ref text, p_status text, p_by text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.purchase_requests;
begin
  if p_status not in ('proforma_sent', 'paid', 'shipped', 'cancelled', 'confirmed', 'unavailable') then
    raise exception 'Statut invalide : %', p_status using errcode = '22023';
  end if;
  update public.purchase_requests set status = p_status, updated_at = now() where id = upper(p_ref) returning * into r;
  if r.id is null then raise exception 'Demande inconnue : %', p_ref using errcode = 'P0002'; end if;
  insert into public.events (actor, text, ref) values ('ops', 'Demande ' || r.id || ' : ' || p_status || coalesce(' par ' || p_by, ''), r.seller_id);
  return public.request_for_operator(r.id);
end $$;

-- Fiche complète pour l'opérateur (acheteur, fournisseur, prix des deux côtés).
create or replace function public.request_for_operator(p_ref text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('ref', r.id, 'status', r.status, 'mpn', r.mpn, 'qty', r.qty, 'currency', r.currency,
    'unit_price', r.unit_price, 'total', round(r.unit_price * r.qty, 2), 'supplier', o.id || ' ' || o.alias,
    'supplier_unit_price', r.supplier_unit_price, 'supplier_currency', r.supplier_currency,
    'lot_qty', (select qty from public.lots where id = r.lot_id), 'buyer_company', r.buyer_company,
    'buyer_vat', r.buyer_vat, 'vat_checked', r.vat_checked, 'buyer_name', r.buyer_name, 'buyer_email', r.buyer_email,
    'buyer_phone', r.buyer_phone, 'delivery', r.delivery_country || ' · ' || r.delivery_address, 'message', r.message)
    from public.purchase_requests r left join public.organizations o on o.id = r.seller_id
   where r.id = upper(p_ref)
$$;

-- Suivi par l'acheteur, avec son jeton : statut et devis, jamais le fournisseur.
create or replace function public.purchase_request_status(p_ref text, p_token text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('ref', r.id, 'status', r.status, 'mpn', r.mpn, 'qty', r.qty, 'currency', r.currency,
    'unit_price', r.unit_price, 'total', round(r.unit_price * r.qty, 2), 'source', r.source, 'ship_from', r.ship_from,
    'created_at', r.created_at, 'updated_at', r.updated_at)
    from public.purchase_requests r
   where r.id = upper(p_ref) and r.access_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
$$;

revoke execute on function public.public_quote(text, text, text, int, text), public.create_purchase_request(text, jsonb),
  public.supplier_requests(text), public.supplier_answer(text, text, boolean),
  public.operator_set_request_status(text, text, text), public.request_for_operator(text),
  public.purchase_request_status(text, text) from public, anon, authenticated;
grant execute on function public.public_quote(text, text, text, int, text), public.create_purchase_request(text, jsonb),
  public.supplier_requests(text), public.supplier_answer(text, text, boolean),
  public.operator_set_request_status(text, text, text), public.request_for_operator(text),
  public.purchase_request_status(text, text) to service_role;
revoke execute on function app.lot_price_for(text, int), app.pick_lot(text, text, text, int), app.buyer_price(text, int, text),
  app.request_for_supplier(public.purchase_requests) from public, anon, authenticated;
grant usage on sequence app.pr_seq to service_role;
