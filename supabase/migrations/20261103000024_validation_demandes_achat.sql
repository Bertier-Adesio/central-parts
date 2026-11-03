-- Validation des demandes d'achat du site par un administrateur, avant tout envoi au fournisseur (décision de
-- Bertier, 3 novembre 2026 ; même règle que les RFQ des plateformes, ADR 0023). ADR 0026.
--
-- Une demande d'achat (PR-…) arrive désormais en « pending_validation » : le fournisseur ne la voit pas (ni dans /depot/,
-- ni dans WeChat) et ne peut pas y répondre. L'administrateur la valide (→ « submitted », le fournisseur est prévenu)
-- ou la refuse avec un motif (→ « rejected », motif interne, jamais montré à l'acheteur ni au fournisseur), depuis le
-- back office (/admin/, admin_request_approve / admin_request_reject) ou le robot WeChat (approve PR-… / reject PR-… motif,
-- decide_purchase_request). Les demandes déjà « submitted » avant cette migration ne changent pas.
-- Remplace supplier_requests, supplier_answer et request_for_operator (20261031000009). Rejouable.

-- ------------------------------------------------------------ statuts et décision
alter table public.purchase_requests drop constraint if exists purchase_requests_status_check;
alter table public.purchase_requests add constraint purchase_requests_status_check check (status in
  ('pending_validation', 'rejected', 'submitted', 'confirmed', 'unavailable', 'proforma_sent', 'paid', 'shipped', 'cancelled'));
alter table public.purchase_requests alter column status set default 'pending_validation';
alter table public.purchase_requests add column if not exists decided_at timestamptz;
alter table public.purchase_requests add column if not exists decided_by text;    -- « admin:adresse » ou openid de l'opérateur
alter table public.purchase_requests add column if not exists reject_reason text; -- interne, jamais montré
create index if not exists purchase_requests_status_idx on public.purchase_requests (status, created_at desc);

-- ------------------------------------------------------------ fiche opérateur (enrichie)
create or replace function public.request_for_operator(p_ref text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('ref', r.id, 'origin', 'site', 'status', r.status, 'mpn', r.mpn, 'qty', r.qty, 'currency', r.currency,
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

-- ------------------------------------------------------------ fournisseur : rien avant la validation
create or replace function public.supplier_requests(p_openid text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(app.request_for_supplier(r) order by r.created_at desc), '[]')
    from public.purchase_requests r
   where r.seller_id = (select org_id from public.wechat_identities where openid = p_openid and revoked_at is null)
     and r.status not in ('pending_validation', 'rejected')
     and r.created_at > now() - interval '90 days'
$$;

create or replace function public.supplier_answer(p_openid text, p_ref text, p_ok boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.purchase_requests; v_org text;
begin
  select org_id into v_org from public.wechat_identities where openid = p_openid and revoked_at is null;
  select * into r from public.purchase_requests where id = upper(p_ref) for update;
  if r.id is null or v_org is null or r.seller_id is distinct from v_org or r.status in ('pending_validation', 'rejected') then
    raise exception 'Demande inconnue : %', p_ref using errcode = 'P0002';
  end if;
  if r.status <> 'submitted' then return app.request_for_supplier(r); end if;
  update public.purchase_requests set status = case when p_ok then 'confirmed' else 'unavailable' end,
         answered_at = now(), answered_by = p_openid, updated_at = now()
   where id = r.id returning * into r;
  insert into public.events (actor, text, ref) values ('seller', 'Demande ' || r.id || (case when p_ok then ' confirmée' else ' indisponible' end), r.seller_id);
  return app.request_for_supplier(r);
end $$;

-- ------------------------------------------------------------ décision de l'administrateur
-- Valide (p_approve) ou refuse une demande en attente. Erreurs : P0002 demande inconnue, CP005 motif manquant,
-- CP409 déjà décidée. Renvoie la fiche opérateur et, à la validation, ce que voit le fournisseur (« supplier_view »),
-- pour le prévenir dans WeChat.
create or replace function public.decide_purchase_request(p_ref text, p_approve boolean, p_by text, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.purchase_requests; v_why text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select * into r from public.purchase_requests where id = upper(btrim(coalesce(p_ref, ''))) for update;
  if r.id is null then raise exception 'Demande inconnue : %', p_ref using errcode = 'P0002'; end if;
  if not p_approve and v_why is null then raise exception 'Motif du refus obligatoire' using errcode = 'CP005'; end if;
  if r.status <> 'pending_validation' then
    raise exception 'Demande % déjà traitée (%)', r.id, r.status using errcode = 'CP409';
  end if;
  update public.purchase_requests
     set status = case when p_approve then 'submitted' else 'rejected' end, decided_at = now(), decided_by = p_by,
         reject_reason = case when p_approve then null else left(v_why, 500) end, updated_at = now()
   where id = r.id returning * into r;
  insert into public.events (actor, text, ref) values ('ops',
    'Demande ' || r.id || case when p_approve then ' validée' else ' refusée' end || coalesce(' par ' || p_by, ''), r.seller_id);
  return public.request_for_operator(r.id)
    || jsonb_build_object('supplier_view', case when p_approve then app.request_for_supplier(r) end);
end $$;

-- Back office : liste (p_status : pending_validation par défaut, null : toutes), 100 dernières, et compteurs.
create or replace function public.admin_requests(p_status text default 'pending_validation')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_admin();
  return jsonb_build_object(
    'counts', (select coalesce(jsonb_object_agg(status, n), '{}') from (select status, count(*) as n
                from public.purchase_requests group by status) c),
    'rows', (select coalesce(jsonb_agg(public.request_for_operator(x.id) order by x.created_at desc), '[]')
               from (select id, created_at from public.purchase_requests
                      where p_status is null or status = p_status order by created_at desc limit 100) x));
end $$;

create or replace function public.admin_request_approve(p_ref text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin return public.decide_purchase_request(p_ref, true, app.require_admin()); end $$;

create or replace function public.admin_request_reject(p_ref text, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_by text := app.require_admin();
begin return public.decide_purchase_request(p_ref, false, v_by, p_reason); end $$;

-- ------------------------------------------------------------ droits
revoke execute on function public.request_for_operator(text), public.supplier_requests(text),
  public.supplier_answer(text, text, boolean), public.decide_purchase_request(text, boolean, text, text),
  public.admin_requests(text), public.admin_request_approve(text), public.admin_request_reject(text, text)
  from public, anon, authenticated;
grant execute on function public.request_for_operator(text), public.supplier_requests(text),
  public.supplier_answer(text, text, boolean), public.decide_purchase_request(text, boolean, text, text) to service_role;
grant execute on function public.admin_requests(text), public.admin_request_approve(text), public.admin_request_reject(text, text)
  to authenticated, service_role;
