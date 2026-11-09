-- Fréquence de mise à jour des offres dans la note du fournisseur (ADR 0023, complément du 9 novembre 2026).
-- Une mise à jour = un fichier de stock importé avec succès, ou une reconfirmation sans fichier avec des offres en
-- stock (ADR 0025) ; une par jour au plus, jour de Pékin (celui du fournisseur). Les actions d'un opérateur de
-- Central.Parts pour le compte du fournisseur (accès au dépôt depuis le back office) ne comptent pas.
-- Comptage seulement, calculé à la lecture : aucune colonne à tenir à jour, aucune pénalité, aucun effet sur l'ordre
-- de diffusion des RFQ. Visible du fournisseur (/depot/, /depot/lien/) et de l'administrateur, jamais d'une plateforme.

-- ------------------------------------------------------------ dépôts faits par un opérateur
-- Rempli par la fonction Edge « listes » quand le lien est un accès opérateur (depot_links.created_by) : le fichier
-- est importé comme les autres, mais ne compte pas dans la note du fournisseur.
create table if not exists public.operator_uploads (
  storage_path text primary key,                    -- même chemin que stock_imports.storage_path
  org_id       text not null references public.organizations on delete cascade,
  by_who       text not null,
  at           timestamptz not null default now()
);
alter table public.operator_uploads enable row level security;
revoke all on public.operator_uploads from anon, authenticated;
drop policy if exists ops on public.operator_uploads;
create policy ops on public.operator_uploads for select to authenticated using (app.is_ops());
grant select on public.operator_uploads to authenticated;

-- ------------------------------------------------------------ jours de mise à jour
-- Jours (heure de Pékin) où le vendeur a lui-même mis son stock à jour, de p_since (inclus) à p_until (exclu).
create or replace function app.seller_update_days(p_org text, p_since timestamptz default '-infinity', p_until timestamptz default 'infinity')
returns table (day date) language sql stable security definer set search_path = '' as $$
  select (i.processed_at at time zone 'Asia/Shanghai')::date
    from public.stock_imports i
   where i.org_id = p_org and i.status = 'done' and i.processed_at >= p_since and i.processed_at < p_until
     and not exists (select 1 from public.operator_uploads u where u.storage_path = i.storage_path)
  union
  select (r.at at time zone 'Asia/Shanghai')::date
    from public.stock_reconfirmations r
   where r.org_id = p_org and r.lots > 0 and r.channel <> 'admin' and r.at >= p_since and r.at < p_until
$$;

-- Jours mis à jour ce mois-ci (mois de Pékin), sur les 30 derniers jours, et dernière mise à jour.
create or replace function public.seller_updates(p_org text, p_now timestamptz default now())
returns jsonb language sql stable security definer set search_path = '' as $$
  with m as (select (date_trunc('month', p_now at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai') as since)
  select jsonb_build_object(
    'month_days', (select count(*) from app.seller_update_days(p_org, (select since from m), p_now)),
    'days_30', (select count(*) from app.seller_update_days(p_org, p_now - interval '30 days', p_now)),
    'last_update_at', greatest(
      (select max(i.processed_at) from public.stock_imports i
        where i.org_id = p_org and i.status = 'done' and i.processed_at < p_now
          and not exists (select 1 from public.operator_uploads u where u.storage_path = i.storage_path)),
      (select max(r.at) from public.stock_reconfirmations r where r.org_id = p_org and r.lots > 0 and r.channel <> 'admin' and r.at < p_now)))
$$;
revoke execute on function app.seller_update_days(text, timestamptz, timestamptz) from public, anon, authenticated;
revoke execute on function public.seller_updates(text, timestamptz) from public, anon, authenticated;
grant execute on function public.seller_updates(text, timestamptz) to service_role;

-- ------------------------------------------------------------ état des offres d'un vendeur (/depot/, /depot/lien/)
-- Copie de 20261103000023, avec « updates ».
create or replace function public.seller_offer_status(p_org text)
returns jsonb language sql stable security definer set search_path = '' as $$
  with t as (select app.seller_ttl(p_org) as ttl)
  select jsonb_build_object(
    'live', count(*) filter (where l.confirmed_at > now() - t.ttl),
    'to_reconfirm', count(*) filter (where l.confirmed_at <= now() - t.ttl),
    'last_confirmed', max(l.confirmed_at),
    'expires_at', max(l.confirmed_at) + t.ttl,
    'ttl_days', extract(day from t.ttl)::int,
    'last_reconfirmed', (select max(r.at) from public.stock_reconfirmations r where r.org_id = p_org),
    'updates', public.seller_updates(p_org))
  from t left join public.lots l on l.seller_id = p_org and l.qty > 0
  group by t.ttl
$$;

-- ------------------------------------------------------------ note du fournisseur (RFQ et mises à jour)
-- Copie de 20261102000020, avec « updates ».
create or replace function public.supplier_score(p_org text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('org', p_org, 'received', coalesce(sum(received), 0), 'quoted', coalesce(sum(quoted), 0),
    'declined', coalesce(sum(declined), 0), 'expired', coalesce(sum(expired), 0),
    'treatment_rate', round((sum(quoted) + sum(declined))::numeric / nullif(sum(received), 0), 3),
    'median_response_minutes', (select percentile_cont(0.5) within group (order by extract(epoch from responded_at - notified_at) / 60)::int
                                  from public.demand_sellers where seller_id = p_org and response_status in ('quoted', 'declined')),
    'counts_for_ranking', coalesce(sum(received), 0) >= app.score_threshold(),
    'expired_demands', (select coalesce(jsonb_agg(demand_id order by deadline_at desc), '[]') from (
        select demand_id, deadline_at from public.demand_sellers where seller_id = p_org and response_status = 'expired'
         order by deadline_at desc limit 20) e),
    'updates', public.seller_updates(p_org))
    from public.supplier_scores where seller_id = p_org
$$;

-- ------------------------------------------------------------ fiche fournisseur du back office
-- Copie de 20261102000017, avec « updates ».
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
    'updates', public.seller_updates(o.id));
end $$;
