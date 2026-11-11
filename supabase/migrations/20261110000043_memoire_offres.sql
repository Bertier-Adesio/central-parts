-- Mémoire des offres et validité dans le back office (décision de Bertier, 10 novembre 2026 : « il faut garder la
-- mémoire des offres qui ont expiré, afficher l'âge d'une offre, par exemple “import du 10/11/2026” »). ADR 0025,
-- complément du 10 novembre 2026. À appliquer à la main dans le SQL Editor, après 20261109000042. Rejouable.
--
--   - lot_history (ajout seul) : à chaque changement d'une offre, son état précédent est gardé. Changement de prix,
--     de quantité ou de devise (« changed »), retrait par un fichier complet (« withdrawn »), remise en ligne d'une
--     offre expirée (« renewed », avec sa date d'expiration et le canal), suppression (« deleted »). Une simple
--     reconfirmation d'une offre encore en ligne n'écrit rien (volume).
--   - stock_reconfirmations.reason : motif d'une remise en ligne par un administrateur (canal « admin », qui ne compte
--     pas dans la fréquence de mise à jour du vendeur, migration 20261109000041).
--   - back office : âge et état de chaque offre (import du…, confirmée le…, expire ou expirée le…), historique d'une
--     offre, validité par vendeur, remise en ligne avec motif, tableau de bord d'accueil, fiche vendeur complétée.

-- ------------------------------------------------------------ historique des offres
create table if not exists public.lot_history (
  id           bigint generated always as identity primary key,
  lot_id       text not null,                       -- pas de clé étrangère : l'historique survit à la suppression
  seller_id    text not null,
  event        text not null check (event in ('changed', 'withdrawn', 'renewed', 'deleted')),
  mpn          text not null,
  manufacturer text,
  qty          integer,
  unit_price   numeric(18,6),
  currency     char(3),
  date_code    text,
  import_id    text,
  imported_at  timestamptz,                         -- date de l'import qui avait fourni cet état
  confirmed_at timestamptz,                         -- dernière confirmation de cet état
  expired_at   timestamptz,                         -- échéance déjà passée au moment du changement, sinon null
  new_qty      integer,
  new_unit_price numeric(18,6),
  new_currency char(3),
  via          text,                                -- fichier, ou canal de la reconfirmation (depot, lien, wechat, admin)
  at           timestamptz not null default now()
);
create index if not exists lot_history_lot on public.lot_history (lot_id, at desc);
create index if not exists lot_history_seller on public.lot_history (seller_id, at desc);
drop trigger if exists lot_history_append_only on public.lot_history;
create trigger lot_history_append_only before update or delete on public.lot_history
  for each row execute function app.append_only();
alter table public.lot_history enable row level security;
revoke all on public.lot_history from anon, authenticated;
drop policy if exists ops on public.lot_history;
create policy ops on public.lot_history for select to authenticated using (app.is_ops());
grant select on public.lot_history to authenticated;

-- Canal de la modification en cours : posé par seller_reconfirm (set_config local à la transaction) ; sinon « file ».
create or replace function app.lot_history_capture() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_exp timestamptz; v_event text; v_imp timestamptz; r public.lots;
begin
  r := old;
  v_exp := r.confirmed_at + app.seller_ttl(r.seller_id);
  if tg_op = 'DELETE' then
    v_event := 'deleted';
  elsif r.qty > 0 and new.qty = 0 then
    v_event := 'withdrawn';
  elsif (new.qty, new.unit_price, new.currency) is distinct from (r.qty, r.unit_price, r.currency) then
    v_event := 'changed';
  elsif new.confirmed_at > r.confirmed_at and r.qty > 0 and v_exp < now() then
    v_event := 'renewed';
  else
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  select i.processed_at into v_imp from public.stock_imports i where i.id = r.import_id;
  insert into public.lot_history (lot_id, seller_id, event, mpn, manufacturer, qty, unit_price, currency, date_code, import_id,
    imported_at, confirmed_at, expired_at, new_qty, new_unit_price, new_currency, via)
  values (r.id, r.seller_id, v_event, r.mpn, nullif(r.manufacturer, ''), r.qty, r.unit_price, r.currency, nullif(r.date_code, ''), r.import_id,
    coalesce(v_imp, r.created_at), r.confirmed_at, case when v_exp < now() then v_exp end,
    case when tg_op = 'UPDATE' then new.qty end, case when tg_op = 'UPDATE' then new.unit_price end,
    case when tg_op = 'UPDATE' then new.currency end,
    coalesce(nullif(current_setting('app.reconfirm_channel', true), ''), 'file'));
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists lots_history on public.lots;
create trigger lots_history before update or delete on public.lots
  for each row execute function app.lot_history_capture();

-- ------------------------------------------------------------ reconfirmation : canal et motif
alter table public.stock_reconfirmations add column if not exists reason text;

-- Copie de 20261103000023 : canal posé pour l'historique, motif facultatif (obligatoire côté administrateur).
drop function if exists public.seller_reconfirm(text, text, text);
create or replace function public.seller_reconfirm(p_org text, p_by text, p_channel text, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if p_channel not in ('depot', 'lien', 'wechat', 'admin') then raise exception 'Canal inconnu : %', p_channel using errcode = '22023'; end if;
  perform set_config('app.reconfirm_channel', p_channel, true);
  update public.lots set confirmed_at = now() where seller_id = p_org and qty > 0;
  get diagnostics n = row_count;
  perform set_config('app.reconfirm_channel', '', true);
  if n = 0 then raise exception 'Aucune offre en stock à reconfirmer' using errcode = 'P0002'; end if;
  insert into public.stock_reconfirmations (org_id, by_who, channel, lots, reason) values (p_org, left(p_by, 120), p_channel, n, nullif(left(btrim(coalesce(p_reason, '')), 500), ''));
  insert into public.events (actor, text, ref) values (p_channel, format('Stock reconfirmé sans fichier : %s offre(s)', n)
    || coalesce(' — ' || nullif(btrim(coalesce(p_reason, '')), ''), ''), p_org);
  return jsonb_build_object('lots', n, 'expires_at', now() + app.seller_ttl(p_org), 'ttl_days', extract(day from app.seller_ttl(p_org))::int);
end $$;
revoke execute on function public.seller_reconfirm(text, text, text, text) from public, anon, authenticated;
grant execute on function public.seller_reconfirm(text, text, text, text) to service_role;

-- ------------------------------------------------------------ âge et état d'une offre
-- live : en ligne ; expired : en stock mais échéance passée (cachée aux acheteurs) ; withdrawn : retirée (quantité 0).
create or replace function app.lot_age(p_lot text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'imported_at', coalesce((select i.processed_at from public.stock_imports i where i.id = l.import_id), l.created_at),
    'import_file', (select i.file_name from public.stock_imports i where i.id = l.import_id),
    'confirmed_at', l.confirmed_at,
    'expires_at', l.confirmed_at + app.seller_ttl(l.seller_id),
    'state', case when l.qty = 0 then 'withdrawn' when l.confirmed_at + app.seller_ttl(l.seller_id) <= now() then 'expired' else 'live' end,
    'history', (select count(*) from public.lot_history h where h.lot_id = l.id))
    from public.lots l where l.id = p_lot
$$;

-- Copie de 20261102000016, avec l'âge et l'état de chaque offre et un filtre (p_state : live, expired, withdrawn ;
-- null : toutes).
drop function if exists public.admin_lots(text, text, int, int);
create or replace function public.admin_lots(p_org text default null, p_q text default '', p_limit int default 50, p_offset int default 0,
  p_state text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_q text := '%' || replace(replace(replace(btrim(coalesce(p_q, '')), '\', '\\'), '%', '\%'), '_', '\_') || '%';
begin
  perform app.require_admin();
  return (with m as (
      select l.*, o.name as seller_name from public.lots l join public.organizations o on o.id = l.seller_id
       where (p_org is null or l.seller_id = p_org)
         and (l.mpn ilike v_q or l.manufacturer ilike v_q or coalesce(l.pack, '') ilike v_q
              or coalesce(l.description, '') ilike v_q)
         and case coalesce(p_state, '')
               when 'live' then l.qty > 0 and l.confirmed_at + app.seller_ttl(l.seller_id) > now()
               when 'expired' then l.qty > 0 and l.confirmed_at + app.seller_ttl(l.seller_id) <= now()
               when 'withdrawn' then l.qty = 0
               else true end)
    select jsonb_build_object('total', (select count(*) from m),
      'rows', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'org_id', p.seller_id, 'seller', p.seller_name,
          'mpn', p.mpn, 'manufacturer', p.manufacturer, 'pack', p.pack, 'qty', p.qty, 'unit_price', p.unit_price,
          'currency', p.currency, 'lead_days', p.lead_days, 'date_code', p.date_code, 'source', p.source,
          'updated_at', p.updated_at, 'description', p.description,
          'product_url', p.product_url, 'datasheet_url', p.datasheet_url,
          'age', app.lot_age(p.id),
          'breaks', (select coalesce(jsonb_agg(jsonb_build_object('from', b.min_qty, 'to', b.next_qty - 1, 'price', b.unit_price)
                       order by b.min_qty), '[]'::jsonb)
                       from (select pb.min_qty, pb.unit_price, lead(pb.min_qty) over (order by pb.min_qty) as next_qty
                               from public.lot_price_breaks pb where pb.lot_id = p.id) b))
          order by p.seller_name, upper(p.mpn), p.id), '[]'::jsonb)
        from (select * from m order by seller_name, upper(mpn), id
               limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0)) p)));
end $$;
revoke execute on function public.admin_lots(text, text, int, int, text) from public, anon;
grant execute on function public.admin_lots(text, text, int, int, text) to authenticated, service_role;

-- Historique d'une offre, le plus récent d'abord.
create or replace function public.admin_lot_history(p_lot text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_admin();
  return coalesce((select jsonb_agg(to_jsonb(h) - 'id' order by h.at desc, h.id desc) from public.lot_history h
                    where h.lot_id = upper(btrim(coalesce(p_lot, '')))), '[]'::jsonb);
end $$;
revoke execute on function public.admin_lot_history(text) from public, anon;
grant execute on function public.admin_lot_history(text) to authenticated, service_role;

-- ------------------------------------------------------------ validité par vendeur
create or replace function app.seller_validity(p_org text) returns jsonb
language sql stable security definer set search_path = '' as $$
  with t as (select app.seller_ttl(p_org) as ttl),
  l as (select l.* from public.lots l where l.seller_id = p_org)
  select jsonb_build_object(
    'live', (select count(*) from l, t where l.qty > 0 and l.confirmed_at + t.ttl > now()),
    'expired', (select count(*) from l, t where l.qty > 0 and l.confirmed_at + t.ttl <= now()),
    'withdrawn', (select count(*) from l where l.qty = 0),
    'ttl_days', (select extract(day from t.ttl)::int from t),
    'next_expiry', (select min(l.confirmed_at) + t.ttl from l, t where l.qty > 0 and l.confirmed_at + t.ttl > now() group by t.ttl),
    'last_expired', (select max(l.confirmed_at) + t.ttl from l, t where l.qty > 0 and l.confirmed_at + t.ttl <= now() group by t.ttl),
    'last_import', (select jsonb_build_object('at', i.processed_at, 'file', i.file_name, 'status', i.status)
                      from public.stock_imports i where i.org_id = p_org order by i.received_at desc limit 1),
    'last_reconfirm', (select jsonb_build_object('at', r.at, 'channel', r.channel, 'by', r.by_who, 'reason', r.reason, 'lots', r.lots)
                         from public.stock_reconfirmations r where r.org_id = p_org order by r.at desc limit 1),
    'lapses_90', (select count(distinct date_trunc('day', h.expired_at)) from public.lot_history h
                   where h.seller_id = p_org and h.event = 'renewed' and h.at > now() - interval '90 days'),
    'last_lapse', (select jsonb_build_object('expired_at', h.expired_at, 'renewed_at', h.at, 'via', h.via, 'lots', count(*))
                     from public.lot_history h where h.seller_id = p_org and h.event = 'renewed'
                    group by h.expired_at, h.at, h.via order by h.at desc limit 1),
    'updates', public.seller_updates(p_org))
$$;

create or replace function public.admin_offer_validity()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_admin();
  return coalesce((select jsonb_agg(x order by (x->'validity'->>'expired')::int > 0 and (x->'validity'->>'live')::int = 0 desc,
                                    x->'validity'->>'next_expiry' nulls last, x->>'name')
    from (select jsonb_build_object('org_id', o.id, 'name', o.name, 'alias', o.alias, 'status', o.kyb, 'profile', o.profile,
            'category', app.source_category(o.profile), 'currency', o.currency, 'validity', app.seller_validity(o.id),
            'contacts', cardinality(app.seller_openids(o.id))) x
            from public.organizations o
           where o.type = 'seller' and (exists (select 1 from public.lots l where l.seller_id = o.id)
                                        or exists (select 1 from public.stock_imports i where i.org_id = o.id))) s), '[]'::jsonb);
end $$;

-- Remise en ligne par un administrateur : motif obligatoire, canal « admin » (hors note du vendeur), historique.
create or replace function public.admin_reconfirm(p_org text, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_by text := app.require_admin();
begin
  if coalesce(btrim(p_reason), '') = '' then raise exception 'Motif obligatoire' using errcode = 'CP005'; end if;
  return public.seller_reconfirm(upper(btrim(coalesce(p_org, ''))), v_by, 'admin', p_reason) || jsonb_build_object('org_id', upper(btrim(p_org)));
end $$;

-- Contacts WeChat d'un vendeur, pour la relance depuis le back office (envoi par la fonction Edge).
create or replace function public.admin_reminder_targets(p_org text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb;
begin
  perform app.require_admin();
  v := app.seller_validity(upper(btrim(coalesce(p_org, ''))));
  return jsonb_build_object('org_id', upper(btrim(p_org)), 'openids', to_jsonb(app.seller_openids(upper(btrim(p_org)))),
    'kind', case when (v->>'expired')::int > 0 then 'expired' else 'soon' end,
    'lots', case when (v->>'expired')::int > 0 then (v->>'expired')::int else (v->>'live')::int end,
    'expires_at', coalesce(v->>'last_expired', v->>'next_expiry'));
end $$;

-- ------------------------------------------------------------ tableau de bord d'accueil
create or replace function public.admin_dashboard()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_admin();
  return jsonb_build_object(
    'suppliers_pending', (select count(*) from public.organizations where type = 'seller' and kyb = 'pending'),
    'requests_pending', (select count(*) from public.purchase_requests where status = 'pending_validation'),
    'rfq_pending', (select count(*) from public.demands where status = 'pending_validation'),
    'sourcing_open', (select count(*) from public.sourcing_requests where status in ('paid', 'in_progress')
                        or (status = 'awaiting_payment' and payment_mode = 'proforma')),
    'sourcing_unpriced', (select count(*) from public.sourcing_offers f join public.sourcing_requests r on r.id = f.request_id
                            where f.unit_price_eur is null and f.withdrawn_at is null and r.closed_at is null),
    'volunteers', (select count(*) from public.sourcing_volunteers v where v.active and app.sourcing_eligible(v.org_id)),
    'offers_live', (select count(*) from public.lots l where l.qty > 0 and l.confirmed_at + app.seller_ttl(l.seller_id) > now()),
    'offers_expired', (select count(*) from public.lots l where l.qty > 0 and l.confirmed_at + app.seller_ttl(l.seller_id) <= now()),
    'sellers_expired', (select coalesce(jsonb_agg(jsonb_build_object('org_id', o.id, 'name', o.name, 'lots', x.n, 'expired_at', x.e)
                          order by x.e desc), '[]'::jsonb)
                          from (select l.seller_id, count(*) n, max(l.confirmed_at) + app.seller_ttl(l.seller_id) e from public.lots l
                                 where l.qty > 0 group by l.seller_id
                                having max(l.confirmed_at) + app.seller_ttl(l.seller_id) <= now()) x
                          join public.organizations o on o.id = x.seller_id),
    'sellers_expiring', (select coalesce(jsonb_agg(jsonb_build_object('org_id', o.id, 'name', o.name, 'lots', x.n, 'expires_at', x.e)
                          order by x.e), '[]'::jsonb)
                          from (select l.seller_id, count(*) n, min(l.confirmed_at) + app.seller_ttl(l.seller_id) e from public.lots l
                                 where l.qty > 0 and l.confirmed_at + app.seller_ttl(l.seller_id) > now() group by l.seller_id
                                having min(l.confirmed_at) + app.seller_ttl(l.seller_id) <= now() + interval '48 hours') x
                          join public.organizations o on o.id = x.seller_id),
    'notify_failed', (select count(*) from public.sourcing_sellers s join public.sourcing_requests r on r.id = s.request_id
                        where s.notify_status in ('failed', 'no_channel') and r.closed_at is null)
                     + (select count(*) from public.demand_sellers s join public.demands d on d.id = s.demand_id
                        where s.notify_status in ('failed', 'no_channel') and d.status = 'auction'),
    'rates_at', (select max(rate_at) from public.currencies));
end $$;

-- ------------------------------------------------------------ fiche fournisseur
-- Copie de 20261109000041, avec la validité des offres, la note, la marge et l'inscription aux recherches payantes.
create or replace function public.admin_supplier(p_org text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare o public.organizations;
begin
  perform app.require_admin();
  select * into o from public.organizations where id = p_org and type = 'seller';
  if o.id is null then raise exception 'Société inconnue : %', p_org using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'org_id', o.id, 'name', o.name, 'alias', o.alias, 'region', app.region_of(o), 'code', o.registration_number,
    'city', o.city, 'country', o.country, 'profile', o.profile, 'currency', o.currency, 'lang', o.lang,
    'status', o.kyb, 'rejected_reason', o.rejected_reason, 'requested_at', o.created_at, 'decided_at', o.kyb_decided_at,
    'has_license', o.license_path is not null, 'registered_by', o.registered_by,
    'contacts', (select coalesce(jsonb_agg(jsonb_build_object('label', w.label, 'role', w.role, 'openid', w.openid,
                   'bound_at', w.bound_at, 'last_login_at', w.last_login_at) order by w.role, w.bound_at), '[]'::jsonb)
                   from public.wechat_identities w where w.org_id = o.id and w.revoked_at is null),
    'stock', (select jsonb_build_object('lines', count(*) filter (where l.qty > 0), 'lines_total', count(*),
                'sources', coalesce(jsonb_agg(distinct l.source) filter (where l.source is not null), '[]'::jsonb))
                from public.lots l where l.seller_id = o.id),
    'last_import', (select jsonb_build_object('file_name', i.file_name, 'status', i.status, 'received_at', i.received_at,
                      'rows_total', i.rows_total, 'rejected', i.rejected,
                      'currency', i.currency, 'currency_used', i.currency_used)
                      from public.stock_imports i where i.org_id = o.id order by i.received_at desc limit 1),
    'decisions', (select coalesce(jsonb_agg(jsonb_build_object('action', d.action, 'from_status', d.from_status,
                    'reason', d.reason, 'at', d.at,
                    'by', case when d.decided_by like 'admin:%' then substring(d.decided_by from 7)
                               when op.openid is not null then 'WeChat · ' || coalesce(op.label, op.openid)
                               else d.decided_by end) order by d.at desc, d.id desc), '[]'::jsonb)
                    from public.supplier_decisions d left join public.operators op on op.openid = d.decided_by
                   where d.org_id = o.id),
    'updates', public.seller_updates(o.id),
    'validity', app.seller_validity(o.id),
    'score', public.supplier_score(o.id) - 'org' - 'updates',
    'margin', jsonb_build_object('own', (select m.margin_pct from app.seller_margins m where m.org_id = o.id),
                'category', app.source_category(o.profile), 'applied', app.margin_for(o.id)),
    'volunteer', (select jsonb_build_object('active', v.active, 'labs', v.labs, 'joined_at', v.joined_at)
                    from public.sourcing_volunteers v where v.org_id = o.id),
    'reconfirmations', (select coalesce(jsonb_agg(jsonb_build_object('at', r.at, 'channel', r.channel, 'by', r.by_who,
                          'reason', r.reason, 'lots', r.lots) order by r.at desc), '[]'::jsonb)
                          from (select * from public.stock_reconfirmations r where r.org_id = o.id order by r.at desc limit 10) r));
end $$;

-- ------------------------------------------------------------ droits
revoke execute on function app.lot_history_capture(), app.lot_age(text), app.seller_validity(text) from public, anon, authenticated;
revoke execute on function public.admin_offer_validity(), public.admin_reconfirm(text, text), public.admin_reminder_targets(text),
  public.admin_dashboard() from public, anon;
grant execute on function public.admin_offer_validity(), public.admin_reconfirm(text, text), public.admin_reminder_targets(text),
  public.admin_dashboard() to authenticated, service_role;
