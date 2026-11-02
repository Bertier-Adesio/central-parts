-- Back office /admin/ : approbation des fournisseurs et lecture des stocks par un administrateur Central.Parts
-- (ADR 0018). Proposée, à appliquer à la main dans le SQL Editor, après 20261102000012 et 20261102000013.
--
-- Administrateur = utilisateur Supabase Auth membre de l'organisation de type « ops » (Central.Parts), c'est-à-dire
-- app.is_ops() du schéma initial. Connexion par lien e-mail ; la page n'est qu'une façade : chaque fonction admin_*
-- vérifie elle-même le rôle et refuse tout autre utilisateur (42501), et anon n'a le droit d'en exécuter aucune.
--
-- Même logique métier que le robot WeChat (commandes approve / reject) : admin_approve et admin_reject appellent
-- approve_supplier et reject_supplier, rien n'est réécrit à côté. Ce que cette migration change pour les deux canaux :
--   - chaque décision est inscrite dans supplier_decisions (qui, quand, quoi, motif), table en ajout seul ;
--   - une société remise en attente puis approuvée de nouveau garde son pseudonyme V-n ;
--   - nouvelle décision « remettre en attente » (reset_supplier_pending), sans message au fournisseur.
-- Le refus reste impossible sur une société approuvée (comme dans le robot) : on la remet d'abord en attente.
-- Le motif du refus est obligatoire dans le back office (admin_reject) ; le robot garde « reject ORG-… » sans motif.
--
-- Rejouable. N'efface ni ne modifie aucune donnée existante.

-- Pays / région d'immatriculation : colonne créée par 20261102000013 (inscription hors Chine). Ajoutée ici à
-- l'identique (sans effet si elle existe), pour que le back office fonctionne même si 013 n'était pas appliquée.
alter table public.organizations add column if not exists registration_region text
  check (registration_region in ('CN', 'HK', 'OTHER'));

-- ------------------------------------------------------------ journal des décisions
create table if not exists public.supplier_decisions (
  id          bigint generated always as identity primary key,
  org_id      text not null references public.organizations on delete cascade,
  action      text not null check (action in ('approved', 'rejected', 'pending')),
  from_status text,                          -- statut kyb avant la décision
  reason      text,
  decided_by  text,                          -- openid de l'opérateur WeChat, ou « admin:<e-mail> » pour le back office
  at          timestamptz not null default now()
);
create index if not exists supplier_decisions_org_at on public.supplier_decisions (org_id, at desc);
drop trigger if exists supplier_decisions_append_only on public.supplier_decisions;
create trigger supplier_decisions_append_only before update or delete on public.supplier_decisions
  for each row execute function app.append_only();
alter table public.supplier_decisions enable row level security;
revoke all on public.supplier_decisions from anon, authenticated;
drop policy if exists ops on public.supplier_decisions;
create policy ops on public.supplier_decisions for select to authenticated using (app.is_ops());
grant select on public.supplier_decisions to authenticated;

-- ------------------------------------------------------------ décisions (partagées avec le robot WeChat)
-- Validation : reprend 20261031000007 ; garde le pseudonyme V-n d'une société déjà approuvée une fois,
-- et inscrit la décision au journal.
create or replace function public.approve_supplier(p_org text, p_by text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare o public.organizations; v_alias text;
begin
  select * into o from public.organizations where id = p_org and type = 'seller' for update;
  if o.id is null then raise exception 'Société inconnue : %', p_org using errcode = 'P0002'; end if;
  if o.kyb = 'validated' then return o.alias; end if;
  if o.alias ~ '^V-\d+$' then
    v_alias := o.alias;
  else
    -- Verrou de transaction : deux validations simultanées n'obtiennent pas le même pseudonyme.
    perform pg_advisory_xact_lock(hashtext('app.alias_v'));
    v_alias := 'V-' || (coalesce((select max(substring(alias from '^V-(\d+)$')::int) from public.organizations), 0) + 1);
  end if;
  update public.organizations set kyb = 'validated', kyb_decided_at = now(), alias = v_alias, rejected_reason = null
   where id = p_org;
  insert into public.subscriptions (org_id, plan, until)
  select p_org, 'Gratuit jusqu''à la première vente', current_date + 365
   where not exists (select 1 from public.subscriptions s where s.org_id = p_org and s.until >= current_date);
  insert into public.supplier_decisions (org_id, action, from_status, decided_by) values (p_org, 'approved', o.kyb, p_by);
  insert into public.events (actor, text, ref) values ('ops', 'Société validée (' || v_alias || ')' || coalesce(' par ' || p_by, ''), p_org);
  return v_alias;
end $$;

-- Refus : reprend 20261031000007 (toujours impossible sur une société validée) et inscrit la décision au journal.
create or replace function public.reject_supplier(p_org text, p_reason text, p_by text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare o public.organizations;
begin
  select * into o from public.organizations where id = p_org and type = 'seller' and kyb <> 'validated' for update;
  if o.id is null then raise exception 'Société inconnue ou déjà validée : %', p_org using errcode = 'P0002'; end if;
  update public.organizations set kyb = 'rejected', kyb_decided_at = now(), rejected_reason = nullif(btrim(p_reason), '')
   where id = p_org;
  insert into public.supplier_decisions (org_id, action, from_status, reason, decided_by)
  values (p_org, 'rejected', o.kyb, nullif(btrim(p_reason), ''), p_by);
  insert into public.events (actor, text, ref) values ('ops', 'Société refusée' || coalesce(' par ' || p_by, ''), p_org);
end $$;

-- Remise en attente d'une société approuvée ou refusée. Une société approuvée n'est plus publiée (app.is_verified)
-- tant qu'elle n'est pas approuvée de nouveau ; elle garde son pseudonyme et son abonnement. Aucun message envoyé.
create or replace function public.reset_supplier_pending(p_org text, p_reason text default null, p_by text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare o public.organizations;
begin
  select * into o from public.organizations where id = p_org and type = 'seller' for update;
  if o.id is null then raise exception 'Société inconnue : %', p_org using errcode = 'P0002'; end if;
  if o.kyb = 'pending' then raise exception 'Société déjà en attente : %', p_org using errcode = 'CP006'; end if;
  update public.organizations set kyb = 'pending', kyb_decided_at = now(), rejected_reason = null where id = p_org;
  insert into public.supplier_decisions (org_id, action, from_status, reason, decided_by)
  values (p_org, 'pending', o.kyb, nullif(btrim(p_reason), ''), p_by);
  insert into public.events (actor, text, ref) values ('ops', 'Société remise en attente' || coalesce(' par ' || p_by, ''), p_org);
end $$;

revoke execute on function public.approve_supplier(text, text), public.reject_supplier(text, text, text),
  public.reset_supplier_pending(text, text, text) from public, anon, authenticated;
grant execute on function public.approve_supplier(text, text), public.reject_supplier(text, text, text),
  public.reset_supplier_pending(text, text, text) to service_role;

-- ------------------------------------------------------------ accès administrateur
-- Refuse tout utilisateur qui n'est pas membre de l'organisation Central.Parts ; renvoie son identité pour le journal.
create or replace function app.require_admin() returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_email text;
begin
  if not coalesce(app.is_ops(), false) then raise exception 'Réservé aux administrateurs' using errcode = '42501'; end if;
  select email into v_email from auth.users where id = auth.uid();
  return 'admin:' || coalesce(v_email, auth.uid()::text);
end $$;

-- Pays / région d'immatriculation lu : 013 laisse null pour les sociétés inscrites avant elle (Chine continentale).
create or replace function app.region_of(o public.organizations) returns text
language sql immutable set search_path = '' as $$
  select coalesce(o.registration_region, case when o.country = 'HK' then 'HK'
                                              when o.country is null or o.country = 'CN' then 'CN' else 'OTHER' end)
$$;

create or replace function public.admin_me()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_by text := app.require_admin();
begin
  return jsonb_build_object('email', substring(v_by from 7),
    'display_name', (select display_name from public.members where user_id = auth.uid()));
end $$;

-- Liste des fournisseurs, demandes les plus récentes d'abord ; p_status : pending, validated, rejected ou null (tous).
create or replace function public.admin_suppliers(p_status text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_admin();
  return jsonb_build_object(
    'counts', (select jsonb_object_agg(k, n) from (select kyb as k, count(*) as n from public.organizations
                where type = 'seller' group by kyb) c),
    'rows', (select coalesce(jsonb_agg(jsonb_build_object(
        'org_id', o.id, 'name', o.name, 'alias', o.alias, 'region', app.region_of(o), 'code', o.registration_number,
        'city', o.city, 'profile', o.profile, 'currency', o.currency, 'status', o.kyb,
        'requested_at', o.created_at, 'decided_at', o.kyb_decided_at,
        'lines', (select count(*) from public.lots l where l.seller_id = o.id and l.qty > 0))
        order by o.created_at desc, o.id desc), '[]'::jsonb)
      from public.organizations o
     where o.type = 'seller' and (p_status is null or o.kyb = p_status)));
end $$;

-- Fiche d'une société : identité, contacts WeChat, stock, journal des décisions.
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
                      'rows_total', i.rows_total, 'rejected', i.rejected)
                      from public.stock_imports i where i.org_id = o.id order by i.received_at desc limit 1),
    'decisions', (select coalesce(jsonb_agg(jsonb_build_object('action', d.action, 'from_status', d.from_status,
                    'reason', d.reason, 'at', d.at,
                    'by', case when d.decided_by like 'admin:%' then substring(d.decided_by from 7)
                               when op.openid is not null then 'WeChat · ' || coalesce(op.label, op.openid)
                               else d.decided_by end) order by d.at desc, d.id desc), '[]'::jsonb)
                    from public.supplier_decisions d left join public.operators op on op.openid = d.decided_by
                   where d.org_id = o.id));
end $$;

create or replace function public.admin_approve(p_org text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_by text := app.require_admin(); v_alias text;
begin
  v_alias := public.approve_supplier(p_org, v_by);
  return jsonb_build_object('org_id', p_org, 'status', 'validated', 'alias', v_alias);
end $$;

-- Refus depuis le back office : motif obligatoire (CP005).
create or replace function public.admin_reject(p_org text, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_by text := app.require_admin();
begin
  if coalesce(btrim(p_reason), '') = '' then raise exception 'Motif du refus obligatoire' using errcode = 'CP005'; end if;
  perform public.reject_supplier(p_org, p_reason, v_by);
  return jsonb_build_object('org_id', p_org, 'status', 'rejected');
end $$;

create or replace function public.admin_reset_pending(p_org text, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_by text := app.require_admin();
begin
  perform public.reset_supplier_pending(p_org, p_reason, v_by);
  return jsonb_build_object('org_id', p_org, 'status', 'pending');
end $$;

-- ------------------------------------------------------------ stocks et offres (lecture seule)
-- Par fournisseur : références en stock, dernier import, sources, devise.
create or replace function public.admin_stock_summary()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_admin();
  return (select coalesce(jsonb_agg(r order by r->>'last_import_at' desc nulls last, r->>'name'), '[]'::jsonb) from (
    select jsonb_build_object('org_id', o.id, 'name', o.name, 'alias', o.alias, 'status', o.kyb, 'currency', o.currency,
      'lines', (select count(*) from public.lots l where l.seller_id = o.id and l.qty > 0),
      'sources', (select coalesce(jsonb_agg(distinct l.source), '[]'::jsonb) from public.lots l where l.seller_id = o.id),
      'last_import_at', (select max(i.received_at) from public.stock_imports i where i.org_id = o.id),
      'last_import_file', (select i.file_name from public.stock_imports i where i.org_id = o.id order by i.received_at desc limit 1)) r
      from public.organizations o
     where o.type = 'seller'
       and (exists (select 1 from public.lots l where l.seller_id = o.id)
            or exists (select 1 from public.stock_imports i where i.org_id = o.id))) s);
end $$;

-- Références, avec recherche (référence, marque, boîtier / emballage) et paliers de prix « de … à … ».
-- p_org null : tous les fournisseurs. 200 lignes au plus par page.
create or replace function public.admin_lots(p_org text default null, p_q text default '', p_limit int default 50, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_q text := '%' || replace(replace(replace(btrim(coalesce(p_q, '')), '\', '\\'), '%', '\%'), '_', '\_') || '%';
begin
  perform app.require_admin();
  return (with m as (
      select l.*, o.name as seller_name from public.lots l join public.organizations o on o.id = l.seller_id
       where (p_org is null or l.seller_id = p_org)
         and (l.mpn ilike v_q or l.manufacturer ilike v_q or coalesce(l.pack, '') ilike v_q))
    select jsonb_build_object('total', (select count(*) from m),
      'rows', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'org_id', p.seller_id, 'seller', p.seller_name,
          'mpn', p.mpn, 'manufacturer', p.manufacturer, 'pack', p.pack, 'qty', p.qty, 'unit_price', p.unit_price,
          'currency', p.currency, 'lead_days', p.lead_days, 'date_code', p.date_code, 'source', p.source,
          'updated_at', p.updated_at,
          'breaks', (select coalesce(jsonb_agg(jsonb_build_object('from', b.min_qty, 'to', b.next_qty - 1, 'price', b.unit_price)
                       order by b.min_qty), '[]'::jsonb)
                       from (select pb.min_qty, pb.unit_price, lead(pb.min_qty) over (order by pb.min_qty) as next_qty
                               from public.lot_price_breaks pb where pb.lot_id = p.id) b))
          order by p.seller_name, upper(p.mpn), p.id), '[]'::jsonb)
        from (select * from m order by seller_name, upper(mpn), id
               limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0)) p)));
end $$;

revoke execute on function app.require_admin(), public.admin_me(), public.admin_suppliers(text),
  public.admin_supplier(text), public.admin_approve(text), public.admin_reject(text, text),
  public.admin_reset_pending(text, text), public.admin_stock_summary(), public.admin_lots(text, text, int, int)
  from public, anon;
grant execute on function public.admin_me(), public.admin_suppliers(text),
  public.admin_supplier(text), public.admin_approve(text), public.admin_reject(text, text),
  public.admin_reset_pending(text, text), public.admin_stock_summary(), public.admin_lots(text, text, int, int)
  to authenticated, service_role;
