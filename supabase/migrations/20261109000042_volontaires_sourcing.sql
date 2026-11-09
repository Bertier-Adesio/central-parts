-- Brokers volontaires pour la recherche payante (ADR 0033, complément du 9 novembre 2026). À appliquer à la main dans
-- le SQL Editor, après 20261109000041. Rejouable ; n'efface aucune donnée existante.
--
-- Décisions de Bertier (9 novembre 2026) :
--   - les brokers (et surplus) approuvés s'inscrivent eux-mêmes comme volontaires sur /depot/ ; ils s'engagent à
--     répondre à chaque recherche sous 48 h (报价 : une offre ; 无货 : pas trouvé) ; ils indiquent leurs laboratoires
--     partenaires, visibles de l'administrateur seulement (l'acheteur voit « test en laboratoire possible ») ;
--   - diffusion automatique au paiement (webhook GoCardless, ou proforma marquée payée dans le back office) ;
--   - la recherche reste ouverte 7 jours ; l'acheteur peut la prolonger une fois de 7 jours ;
--   - toutes les offres sont présentées à l'acheteur dès leur arrivée, au prix tout compris : les conditions (marge)
--     sont négociées à l'avance avec le vendeur ; le vendeur reste anonyme ;
--   - l'acheteur arrête la recherche par un bouton, ou en commandant une offre (il peut garder la recherche ouverte) ;
--   - les réponses comptent dans la note du vendeur (supplier_scores), comme les RFQ des plateformes (ADR 0023).
-- Les heures sont passées en paramètre (p_now) pour que les contrôles simulent l'horloge.

-- ------------------------------------------------------------ constantes
create or replace function app.sourcing_open_days() returns int language sql immutable as $$ select 7 $$;
create or replace function app.sourcing_extend_days() returns int language sql immutable as $$ select 7 $$;
create or replace function app.sourcing_max_offers() returns int language sql immutable as $$ select 5 $$;  -- par vendeur et par recherche

-- ------------------------------------------------------------ volontaires
create table if not exists public.sourcing_volunteers (
  org_id     text primary key references public.organizations on delete cascade,
  active     boolean not null default true,
  labs       text,                                  -- laboratoires partenaires : administrateur seulement
  joined_at  timestamptz not null default now(),
  joined_by  text not null,                         -- openid du contact, ou « admin:<e-mail> »
  left_at    timestamptz,
  updated_at timestamptz not null default now(),
  updated_by text
);
alter table public.sourcing_volunteers enable row level security;
revoke all on public.sourcing_volunteers from anon, authenticated;
drop policy if exists ops on public.sourcing_volunteers;
create policy ops on public.sourcing_volunteers for select to authenticated using (app.is_ops());
grant select on public.sourcing_volunteers to authenticated;

-- Peut se porter volontaire : vendeur approuvé, broker ou surplus (rails Opportunity).
create or replace function app.sourcing_eligible(p_org text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select o.type = 'seller' and o.kyb = 'validated' and app.source_category(o.profile) in ('broker', 'surplus')
                     from public.organizations o where o.id = p_org), false)
$$;

-- ------------------------------------------------------------ recherches : fenêtre d'ouverture, arrêt, commande
alter table public.sourcing_requests drop constraint if exists sourcing_requests_status_check;
alter table public.sourcing_requests add constraint sourcing_requests_status_check check (status in
  ('awaiting_payment', 'paid', 'in_progress', 'offers_sent', 'not_found', 'ordered', 'cancelled'));
alter table public.sourcing_requests
  add column if not exists open_until     timestamptz,                -- fin de la recherche auprès des volontaires
  add column if not exists extended_at    timestamptz,                -- prolongation (une seule)
  add column if not exists closed_at      timestamptz,
  add column if not exists close_reason   text check (close_reason in ('expired', 'buyer_stop', 'ordered', 'admin')),
  add column if not exists ordered_offers text[] not null default '{}';
create index if not exists sourcing_requests_open_idx on public.sourcing_requests (open_until) where status = 'in_progress' and closed_at is null;

-- Volontaires consultés : notified_at = envoi réussi ; deadline_at = notified_at + 48 h (engagement de réponse).
-- response_status « closed » : la recherche s'est arrêtée avant l'échéance ; ne compte pas dans la note.
create table if not exists public.sourcing_sellers (
  request_id       text not null references public.sourcing_requests on delete cascade,
  seller_id        text not null references public.organizations on delete cascade,
  notify_status    text not null default 'pending' check (notify_status in ('pending', 'sent', 'failed', 'no_channel')),
  notify_error     text,
  notify_attempts  smallint not null default 0,
  notified_at      timestamptz,
  deadline_at      timestamptz,
  reminder_sent_at timestamptz,
  response_status  text not null default 'pending' check (response_status in ('pending', 'quoted', 'declined', 'expired', 'closed')),
  responded_at     timestamptz,
  responded_by     text,
  primary key (request_id, seller_id)
);
create index if not exists sourcing_sellers_deadline on public.sourcing_sellers (deadline_at) where response_status = 'pending';
create index if not exists sourcing_sellers_seller on public.sourcing_sellers (seller_id, notified_at desc);

-- Offres des volontaires. Prix net du vendeur (jamais montré à l'acheteur) et prix tout compris en euros (marge du
-- vendeur ou de sa catégorie) ; sans marge applicable, l'offre n'est pas montrée et les opérateurs sont prévenus.
create sequence if not exists app.sourcing_offer_seq start 1;
create table if not exists public.sourcing_offers (
  id             text primary key default app.ref('SOF', 'app.sourcing_offer_seq'),
  request_id     text not null references public.sourcing_requests on delete cascade,
  seller_id      text not null references public.organizations on delete cascade,
  net            numeric not null check (net > 0),
  currency       text not null references public.currencies,
  net_eur        numeric not null,
  unit_price_eur numeric,                           -- tout compris ; null sans marge applicable
  qty            bigint check (qty > 0),            -- null : toute la quantité demandée
  lead_days      int not null check (lead_days between 0 and 3650),
  date_code      text,
  created_at     timestamptz not null default now(),
  created_by     text,                              -- openid du contact
  withdrawn_at   timestamptz,                       -- retirée par un administrateur
  withdrawn_by   text,
  withdrawn_reason text
);
create index if not exists sourcing_offers_request on public.sourcing_offers (request_id, created_at);

alter table public.sourcing_sellers enable row level security;
alter table public.sourcing_offers enable row level security;
revoke all on public.sourcing_sellers, public.sourcing_offers from anon, authenticated;
drop policy if exists ops on public.sourcing_sellers;
drop policy if exists ops on public.sourcing_offers;
create policy ops on public.sourcing_sellers for select to authenticated using (app.is_ops());
create policy ops on public.sourcing_offers for select to authenticated using (app.is_ops());
grant select on public.sourcing_sellers, public.sourcing_offers to authenticated;
grant usage on sequence app.sourcing_offer_seq to service_role;

-- ------------------------------------------------------------ fiche vue par le vendeur
-- Jamais : la société, le contact, l'e-mail, le prix cible ni les précisions de l'acheteur.
create or replace function app.sourcing_card(p_id text, p_seller text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_strip_nulls(jsonb_build_object('ref', r.id, 'mpn', r.mpn, 'manufacturer', r.manufacturer, 'qty', r.qty,
    'needed_by', r.needed_by, 'condition', r.condition, 'ship_to', r.country, 'open_until', r.open_until,
    'open', r.status = 'in_progress' and r.closed_at is null,
    'deadline_at', s.deadline_at, 'response', s.response_status,
    'my_offers', (select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'net', f.net, 'currency', f.currency, 'qty', f.qty,
                     'lead_days', f.lead_days, 'date_code', f.date_code, 'withdrawn', f.withdrawn_at is not null) order by f.created_at), '[]')
                    from public.sourcing_offers f where f.request_id = r.id and f.seller_id = p_seller)))
    from public.sourcing_requests r
    left join public.sourcing_sellers s on s.request_id = r.id and s.seller_id = p_seller
   where r.id = upper(p_id)
$$;

-- ------------------------------------------------------------ notation (RFQ des plateformes + recherches payantes)
-- Copie de 20261102000020, avec les recherches payantes : une seule source de vérité par canal.
create or replace function app.refresh_supplier_score(p_seller text, p_at timestamptz)
returns void language plpgsql security definer set search_path = '' as $$
declare v_period text := to_char(p_at at time zone 'UTC', 'YYYY-MM');
begin
  insert into public.supplier_scores (seller_id, period, received, quoted, declined, expired, median_response_minutes, updated_at)
  select p_seller, v_period, count(*), count(*) filter (where response_status = 'quoted'),
         count(*) filter (where response_status = 'declined'), count(*) filter (where response_status = 'expired'),
         (percentile_cont(0.5) within group (order by extract(epoch from responded_at - notified_at) / 60)
            filter (where response_status in ('quoted', 'declined')))::int, now()
    from (select response_status, responded_at, notified_at from public.demand_sellers
           where seller_id = p_seller and notify_status = 'sent' and to_char(notified_at at time zone 'UTC', 'YYYY-MM') = v_period
          union all
          select response_status, responded_at, notified_at from public.sourcing_sellers
           where seller_id = p_seller and notify_status = 'sent' and response_status <> 'closed'
             and to_char(notified_at at time zone 'UTC', 'YYYY-MM') = v_period) x
  on conflict (seller_id, period) do update set received = excluded.received, quoted = excluded.quoted,
    declined = excluded.declined, expired = excluded.expired, median_response_minutes = excluded.median_response_minutes,
    updated_at = excluded.updated_at;
end $$;

-- Copie de 20261109000041, médiane et échéances manquées des deux canaux.
create or replace function public.supplier_score(p_org text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('org', p_org, 'received', coalesce(sum(received), 0), 'quoted', coalesce(sum(quoted), 0),
    'declined', coalesce(sum(declined), 0), 'expired', coalesce(sum(expired), 0),
    'treatment_rate', round((sum(quoted) + sum(declined))::numeric / nullif(sum(received), 0), 3),
    'median_response_minutes', (select percentile_cont(0.5) within group (order by extract(epoch from responded_at - notified_at) / 60)::int
                                  from (select responded_at, notified_at from public.demand_sellers
                                         where seller_id = p_org and response_status in ('quoted', 'declined')
                                        union all
                                        select responded_at, notified_at from public.sourcing_sellers
                                         where seller_id = p_org and response_status in ('quoted', 'declined')) m),
    'counts_for_ranking', coalesce(sum(received), 0) >= app.score_threshold(),
    'expired_demands', (select coalesce(jsonb_agg(ref order by deadline_at desc), '[]') from (
        select ref, deadline_at from (
          select demand_id as ref, deadline_at from public.demand_sellers where seller_id = p_org and response_status = 'expired'
          union all
          select request_id, deadline_at from public.sourcing_sellers where seller_id = p_org and response_status = 'expired') a
         order by deadline_at desc limit 20) e),
    'sourcing', (select jsonb_build_object('received', count(*), 'quoted', count(*) filter (where response_status = 'quoted'),
                   'declined', count(*) filter (where response_status = 'declined'), 'expired', count(*) filter (where response_status = 'expired'))
                   from public.sourcing_sellers where seller_id = p_org and notify_status = 'sent' and response_status <> 'closed'),
    'updates', public.seller_updates(p_org))
    from public.supplier_scores where seller_id = p_org
$$;

-- ------------------------------------------------------------ ouverture au paiement
-- Recherche payée → ouverte 7 jours, volontaires actifs inscrits « à prévenir ». Une seule fois (statut « paid »).
-- Renvoie les contacts à prévenir ; null si la recherche n'est pas à ouvrir.
create or replace function public.sourcing_open(p_id text, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.sourcing_requests; v_n int;
begin
  update public.sourcing_requests set status = 'in_progress', open_until = p_now + make_interval(days => app.sourcing_open_days()),
         updated_at = p_now
   where id = upper(p_id) and status = 'paid' and closed_at is null
  returning * into r;
  if r.id is null then return null; end if;
  insert into public.sourcing_sellers (request_id, seller_id)
  select r.id, v.org_id from public.sourcing_volunteers v
   where v.active and app.sourcing_eligible(v.org_id)
  on conflict do nothing;
  get diagnostics v_n = row_count;
  insert into public.events (at, actor, text, ref) values (p_now, 'system',
    'Recherche de sourcing ouverte aux volontaires : ' || v_n || ' vendeur(s), jusqu''au ' || to_char(r.open_until at time zone 'Europe/Paris', 'DD/MM HH24:MI'), r.id);
  return jsonb_build_object('id', r.id, 'open_until', r.open_until, 'volunteers', v_n, 'contacts', public.sourcing_contacts(r.id));
end $$;

-- Volontaires encore à prévenir (envoi en attente ou échoué), avec leurs contacts WeChat et la fiche.
create or replace function public.sourcing_contacts(p_id text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('seller_id', s.seller_id, 'openids', to_jsonb(app.seller_openids(s.seller_id)),
           'card', app.sourcing_card(s.request_id, s.seller_id)) order by s.seller_id), '[]')
    from public.sourcing_sellers s join public.sourcing_requests r on r.id = s.request_id
   where s.request_id = upper(p_id) and s.notify_status in ('pending', 'failed') and s.response_status = 'pending'
     and r.status = 'in_progress' and r.closed_at is null
$$;

-- Résultat de l'envoi : l'échéance de 48 h démarre à l'envoi réussi ; un échec ne compte jamais contre le vendeur.
create or replace function public.sourcing_notify_result(p_id text, p_seller text, p_ok boolean, p_error text default null,
  p_now timestamptz default now())
returns void language plpgsql security definer set search_path = '' as $$
declare s public.sourcing_sellers;
begin
  update public.sourcing_sellers
     set notify_attempts = notify_attempts + 1,
         notify_status = case when p_ok then 'sent' when p_error = 'no_channel' then 'no_channel' else 'failed' end,
         notify_error = case when p_ok then null else left(p_error, 300) end,
         notified_at = case when p_ok then p_now else notified_at end,
         deadline_at = case when p_ok then p_now + make_interval(hours => app.rfq_response_hours()) else deadline_at end
   where request_id = upper(p_id) and seller_id = p_seller and notify_status <> 'sent' and response_status = 'pending'
  returning * into s;
  if s.request_id is null then raise exception 'Vendeur non concerné ou déjà prévenu' using errcode = 'P0002'; end if;
  if p_ok then perform app.refresh_supplier_score(s.seller_id, s.notified_at); end if;
end $$;

-- ------------------------------------------------------------ réponse du volontaire (WeChat ou /depot/)
-- p_kind : 'quote' (prix net unitaire, devise, délai en jours, date code, quantité facultative) ou 'decline' (无货).
-- Une offre est acceptée tant que la recherche est ouverte, même après 48 h ; pour la note, seule compte la première
-- réponse dans les 48 h (au-delà, le vendeur reste « expiré »). Un vendeur qui a répondu 无货 peut encore proposer
-- une offre s'il trouve la pièce. Erreurs : P0002 recherche inconnue pour ce contact, CP409 recherche close (detail
-- « closed ») ou trop d'offres (« max_offers ») ou déjà répondu (« answered »), 22023 donnée invalide (detail : champ).
create or replace function public.sourcing_answer(p_openid text, p_ref text, p_kind text, p_net numeric default null,
  p_currency text default null, p_lead int default null, p_date_code text default null, p_qty bigint default null,
  p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_org text; s public.sourcing_sellers; r public.sourcing_requests; v_cur text; v_rate numeric; v_margin numeric;
  v_offer public.sourcing_offers; v_first boolean;
begin
  select org_id into v_org from public.wechat_identities where openid = p_openid and revoked_at is null;
  select * into s from public.sourcing_sellers where request_id = upper(p_ref) and seller_id = v_org and notify_status = 'sent' for update;
  if s.request_id is null then raise exception 'Recherche inconnue pour ce contact : %', p_ref using errcode = 'P0002'; end if;
  select * into r from public.sourcing_requests where id = s.request_id;
  if r.status <> 'in_progress' or r.closed_at is not null or p_now > r.open_until then
    raise exception 'Recherche close' using errcode = 'CP409', detail = 'closed';
  end if;
  v_first := s.response_status = 'pending' and p_now <= s.deadline_at;

  if p_kind = 'decline' then
    if s.response_status <> 'pending' then raise exception 'Déjà répondu' using errcode = 'CP409', detail = 'answered'; end if;
    update public.sourcing_sellers set response_status = case when v_first then 'declined' else 'expired' end,
           responded_at = p_now, responded_by = p_openid
     where request_id = s.request_id and seller_id = s.seller_id;
    perform app.refresh_supplier_score(s.seller_id, s.notified_at);
    return jsonb_build_object('ref', r.id, 'mpn', r.mpn, 'kind', 'decline', 'on_time', v_first);
  end if;

  if p_kind <> 'quote' then raise exception 'Réponse inconnue' using errcode = '22023', detail = 'kind'; end if;
  v_cur := app.norm_currency(p_currency);
  if v_cur is null then raise exception 'Devise non acceptée' using errcode = '22023', detail = 'currency'; end if;
  if p_net is null or p_net <= 0 or p_net > 1000000 then raise exception 'Prix invalide' using errcode = '22023', detail = 'price'; end if;
  if p_lead is null or p_lead < 0 or p_lead > 3650 then raise exception 'Délai invalide' using errcode = '22023', detail = 'lead'; end if;
  if p_qty is not null and (p_qty < 1 or p_qty > r.qty * 10) then raise exception 'Quantité invalide' using errcode = '22023', detail = 'qty'; end if;
  if (select count(*) from public.sourcing_offers where request_id = r.id and seller_id = s.seller_id) >= app.sourcing_max_offers() then
    raise exception 'Trop d''offres' using errcode = 'CP409', detail = 'max_offers';
  end if;
  select eur_rate into v_rate from public.currencies where code = v_cur;
  v_margin := app.margin_for(s.seller_id);
  insert into public.sourcing_offers (request_id, seller_id, net, currency, net_eur, unit_price_eur, qty, lead_days, date_code, created_at, created_by)
  values (r.id, s.seller_id, p_net, v_cur, round(p_net * v_rate, 6),
          case when v_margin is not null then round(p_net * v_rate * (1 + v_margin / 100), 4) end,
          case when p_qty is not null and p_qty <> r.qty then p_qty end, p_lead,
          nullif(left(regexp_replace(btrim(coalesce(p_date_code, '')), '^(DC|D/C|批号)', '', 'i'), 20), ''), p_now, p_openid)
  returning * into v_offer;
  -- Première réponse : dans les 48 h, « quoted » ; après, « expired » (l'offre est quand même présentée).
  update public.sourcing_sellers set response_status = case when v_first or response_status = 'declined' then 'quoted'
                                                            when response_status = 'pending' then 'expired' else response_status end,
         responded_at = coalesce(responded_at, p_now), responded_by = coalesce(responded_by, p_openid)
   where request_id = s.request_id and seller_id = s.seller_id;
  perform app.refresh_supplier_score(s.seller_id, s.notified_at);
  insert into public.events (at, actor, text, ref) values (p_now, 'seller', 'Offre ' || v_offer.id || ' sur la recherche ' || r.id, s.seller_id);
  return jsonb_build_object('ref', r.id, 'mpn', r.mpn, 'kind', 'quote', 'offer_id', v_offer.id, 'on_time', v_first,
    'priced', v_offer.unit_price_eur is not null, 'seller_id', s.seller_id);
end $$;

-- Recherches reçues par un vendeur (/depot/), inscription comme volontaire et sa note.
create or replace function public.supplier_sourcing(p_openid text)
returns jsonb language sql stable security definer set search_path = '' as $$
  with o as (select org_id from public.wechat_identities where openid = p_openid and revoked_at is null)
  select jsonb_build_object(
    'eligible', app.sourcing_eligible(o.org_id),
    'volunteer', (select jsonb_build_object('active', v.active, 'labs', v.labs, 'joined_at', v.joined_at, 'left_at', v.left_at)
                    from public.sourcing_volunteers v where v.org_id = o.org_id),
    'score', public.supplier_score(o.org_id) -> 'sourcing',
    'requests', coalesce((select jsonb_agg(app.sourcing_card(s.request_id, s.seller_id) order by s.notified_at desc)
        from public.sourcing_sellers s where s.seller_id = o.org_id and s.notify_status = 'sent' and s.notified_at > now() - interval '90 days'), '[]'))
    from o
$$;

-- Inscription (p_on vrai, laboratoires) ou retrait (p_on faux) ; erreur 42501 si la société n'est pas éligible.
create or replace function public.supplier_sourcing_join(p_openid text, p_on boolean, p_labs text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_org text;
begin
  select org_id into v_org from public.wechat_identities where openid = p_openid and revoked_at is null;
  if v_org is null or (p_on and not app.sourcing_eligible(v_org)) then
    raise exception 'Réservé aux brokers et surplus approuvés' using errcode = '42501';
  end if;
  insert into public.sourcing_volunteers as v (org_id, active, labs, joined_by, left_at, updated_by)
  values (v_org, p_on, nullif(left(btrim(coalesce(p_labs, '')), 1000), ''), p_openid, case when p_on then null else now() end, p_openid)
  on conflict (org_id) do update set active = p_on,
    labs = case when p_labs is null then v.labs else nullif(left(btrim(p_labs), 1000), '') end,
    joined_at = case when p_on and not v.active then now() else v.joined_at end,
    left_at = case when p_on then null when v.active then now() else v.left_at end,
    updated_at = now(), updated_by = p_openid;
  insert into public.events (actor, text, ref) values ('seller',
    case when p_on then 'Volontaire pour les recherches payantes' else 'Retrait des recherches payantes' end, v_org);
  return public.supplier_sourcing(p_openid);
end $$;

-- ------------------------------------------------------------ clôture
-- Arrêt de la recherche : volontaires sans réponse « closed » (ne compte pas dans la note) ; renvoie ceux à prévenir.
create or replace function app.sourcing_close(p_id text, p_reason text, p_now timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.sourcing_requests; v_tell jsonb; v_offers int;
begin
  select coalesce(jsonb_agg(jsonb_build_object('seller_id', s.seller_id, 'openids', to_jsonb(app.seller_openids(s.seller_id)))), '[]')
    into v_tell from public.sourcing_sellers s
   where s.request_id = upper(p_id) and s.notify_status = 'sent' and s.response_status = 'pending';
  update public.sourcing_sellers set response_status = 'closed'
   where request_id = upper(p_id) and response_status = 'pending' and (deadline_at is null or deadline_at > p_now);
  -- Échéance passée avant l'arrêt : comptée « expirée ».
  update public.sourcing_sellers set response_status = 'expired'
   where request_id = upper(p_id) and response_status = 'pending';
  select count(*) into v_offers from public.sourcing_offers f
   where f.request_id = upper(p_id) and f.withdrawn_at is null and f.unit_price_eur is not null;
  update public.sourcing_requests set
    status = case when p_reason = 'ordered' or cardinality(ordered_offers) > 0 then 'ordered'
                  when v_offers > 0 then 'offers_sent' else 'not_found' end,
    closed_at = p_now, close_reason = p_reason, updated_at = p_now
   where id = upper(p_id) returning * into r;
  perform app.refresh_supplier_score(s.seller_id, s.notified_at) from public.sourcing_sellers s
   where s.request_id = r.id and s.notified_at is not null;
  insert into public.events (at, actor, text, ref) values (p_now, 'system', 'Recherche de sourcing close (' || p_reason || ') : '
    || v_offers || ' offre(s)', r.id);
  return jsonb_build_object('id', r.id, 'mpn', r.mpn, 'status', r.status, 'reason', p_reason, 'offers', v_offers, 'tell', v_tell);
end $$;

-- ------------------------------------------------------------ page de suivi de l'acheteur
-- Copie de 20261106000040, avec la fenêtre d'ouverture et les offres (vendeur anonyme, prix tout compris en euros).
create or replace function public.sourcing_status(p_token text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', r.id, 'status', r.status, 'mpn', r.mpn, 'manufacturer', r.manufacturer, 'qty', r.qty,
    'target_price', r.target_price, 'target_currency', r.target_currency, 'needed_by', r.needed_by, 'condition', r.condition,
    'company', r.company, 'amount_ht', r.amount_ht, 'amount_ttc', r.amount_ttc, 'vat_rate', r.vat_rate, 'paid_at', r.paid_at,
    'payment_mode', r.payment_mode,
    'buyer_note', r.buyer_note, 'credit_used', r.credit_used_by is not null, 'created_at', r.created_at, 'updated_at', r.updated_at,
    'open_until', r.open_until, 'open', r.status = 'in_progress' and r.closed_at is null,
    'can_extend', r.status = 'in_progress' and r.closed_at is null and r.extended_at is null,
    'extended', r.extended_at is not null, 'closed_at', r.closed_at, 'close_reason', r.close_reason,
    'sellers', (select count(*) from public.sourcing_sellers s where s.request_id = r.id and s.notify_status = 'sent'),
    'offers', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', f.id,
                 'unit_price', f.unit_price_eur, 'qty', coalesce(f.qty, r.qty), 'partial', f.qty is not null and f.qty < r.qty,
                 'total', round(f.unit_price_eur * coalesce(f.qty, r.qty), 2), 'currency', 'EUR',
                 'lead_days', f.lead_days, 'date_code', f.date_code,
                 'source', app.source_category(o.profile), 'ship_from', o.country,
                 'lab_test', exists (select 1 from public.sourcing_volunteers v where v.org_id = f.seller_id and v.labs is not null),
                 'ordered', f.id = any (r.ordered_offers), 'at', f.created_at)) order by f.unit_price_eur, f.lead_days, f.created_at)
               from public.sourcing_offers f join public.organizations o on o.id = f.seller_id
              where f.request_id = r.id and f.withdrawn_at is null and f.unit_price_eur is not null), '[]'))
    from public.sourcing_requests r where r.token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
$$;

-- Action de l'acheteur sur son lien de suivi :
--   'extend' : +7 jours, une seule fois, tant que la recherche est ouverte ;
--   'stop'   : arrête la recherche ;
--   'order'  : commande une offre (p_offer) ; la recherche s'arrête, sauf p_keep_open.
-- Erreurs : P0002 lien inconnu ou offre inconnue, CP409 action impossible (detail : closed, extended, ordered).
-- Renvoie { status (page de suivi), closed (clôture : volontaires à prévenir), order (avis aux opérateurs) }.
create or replace function public.sourcing_buyer_action(p_token text, p_action text, p_offer text default null,
  p_keep_open boolean default false, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.sourcing_requests; f public.sourcing_offers; v_closed jsonb; v_order jsonb;
begin
  select * into r from public.sourcing_requests
   where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex') for update;
  if r.id is null then raise exception 'Lien inconnu' using errcode = 'P0002'; end if;
  if p_action = 'order' then
    select * into f from public.sourcing_offers
     where id = upper(coalesce(p_offer, '')) and request_id = r.id and withdrawn_at is null and unit_price_eur is not null;
    if f.id is null then raise exception 'Offre inconnue' using errcode = 'P0002'; end if;
    if f.id = any (r.ordered_offers) then raise exception 'Déjà commandée' using errcode = 'CP409', detail = 'ordered'; end if;
    if r.status not in ('in_progress', 'offers_sent', 'not_found', 'ordered') then
      raise exception 'Commande impossible' using errcode = 'CP409', detail = 'closed';
    end if;
    update public.sourcing_requests set ordered_offers = ordered_offers || f.id,
           status = case when closed_at is not null then 'ordered' else status end, updated_at = p_now
     where id = r.id returning * into r;
    insert into public.events (at, actor, text, ref) values (p_now, 'buyer', 'Offre ' || f.id || ' commandée', r.id);
    v_order := jsonb_build_object('id', r.id, 'mpn', r.mpn, 'company', r.company, 'country', r.country, 'email', r.email,
      'offer', f.id, 'seller_id', f.seller_id, 'qty', coalesce(f.qty, r.qty), 'unit_price', f.unit_price_eur,
      'net', f.net, 'currency', f.currency, 'lead_days', f.lead_days, 'date_code', f.date_code, 'keep_open', p_keep_open);
    if r.closed_at is null and not p_keep_open then v_closed := app.sourcing_close(r.id, 'ordered', p_now); end if;
  elsif r.status <> 'in_progress' or r.closed_at is not null then
    raise exception 'Recherche close' using errcode = 'CP409', detail = 'closed';
  elsif p_action = 'extend' then
    if r.extended_at is not null then raise exception 'Déjà prolongée' using errcode = 'CP409', detail = 'extended'; end if;
    update public.sourcing_requests set open_until = open_until + make_interval(days => app.sourcing_extend_days()),
           extended_at = p_now, updated_at = p_now where id = r.id;
    insert into public.events (at, actor, text, ref) values (p_now, 'buyer', 'Recherche de sourcing prolongée', r.id);
  elsif p_action = 'stop' then
    v_closed := app.sourcing_close(r.id, 'buyer_stop', p_now);
  else
    raise exception 'Action inconnue' using errcode = '22023';
  end if;
  return jsonb_build_object('status', public.sourcing_status(p_token), 'closed', v_closed, 'order', v_order);
end $$;

-- ------------------------------------------------------------ tâche planifiée (avec celle des RFQ, toutes les 5 minutes)
-- Rappel à 36 h (une fois), échéances de 48 h passées → « expired », recherches arrivées au terme → closes.
create or replace function public.sourcing_tick(p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_rem jsonb; v_exp int := 0; v_closed jsonb := '[]'; x record;
begin
  with c as (
    update public.sourcing_sellers s set reminder_sent_at = p_now
      from public.sourcing_requests r
     where r.id = s.request_id and r.status = 'in_progress' and r.closed_at is null and s.notify_status = 'sent'
       and s.response_status = 'pending' and s.reminder_sent_at is null and s.deadline_at > p_now
       and p_now >= s.notified_at + make_interval(hours => app.rfq_reminder_hours())
    returning s.request_id, s.seller_id)
  select coalesce(jsonb_agg(jsonb_build_object('seller_id', c.seller_id, 'openids', to_jsonb(app.seller_openids(c.seller_id)),
           'card', app.sourcing_card(c.request_id, c.seller_id))), '[]') into v_rem from c;
  for x in update public.sourcing_sellers set response_status = 'expired'
            where notify_status = 'sent' and response_status = 'pending' and deadline_at < p_now
              and exists (select 1 from public.sourcing_requests r where r.id = request_id and r.status = 'in_progress' and r.closed_at is null)
           returning seller_id, notified_at loop
    perform app.refresh_supplier_score(x.seller_id, x.notified_at);
    v_exp := v_exp + 1;
  end loop;
  for x in select id from public.sourcing_requests where status = 'in_progress' and closed_at is null and open_until < p_now loop
    v_closed := v_closed || jsonb_build_array(app.sourcing_close(x.id, 'expired', p_now));
  end loop;
  return jsonb_build_object('reminders', v_rem, 'expired', v_exp, 'closed', v_closed);
end $$;

-- ------------------------------------------------------------ back office
-- Copie de 20261106000040, avec les vendeurs consultés et les offres (l'administrateur voit le vendeur et son prix net).
create or replace function public.admin_sourcing_list(p_status text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_admin();
  return jsonb_build_object(
    'counts', (select coalesce(jsonb_object_agg(status, n), '{}') from (select status, count(*) n from public.sourcing_requests group by 1) c),
    'volunteers', (select count(*) from public.sourcing_volunteers v where v.active and app.sourcing_eligible(v.org_id)),
    'rows', coalesce((select jsonb_agg(to_jsonb(r) - 'token_hash' || jsonb_build_object(
        'sellers', (select coalesce(jsonb_agg(jsonb_build_object('org_id', s.seller_id, 'name', o.name, 'alias', o.alias,
                      'notify', s.notify_status, 'response', s.response_status, 'deadline_at', s.deadline_at) order by s.seller_id), '[]')
                      from public.sourcing_sellers s join public.organizations o on o.id = s.seller_id where s.request_id = r.id),
        'offers', (select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'org_id', f.seller_id, 'name', o.name, 'net', f.net,
                     'currency', f.currency, 'unit_price_eur', f.unit_price_eur, 'qty', f.qty, 'lead_days', f.lead_days,
                     'date_code', f.date_code, 'at', f.created_at, 'withdrawn_at', f.withdrawn_at, 'ordered', f.id = any (r.ordered_offers))
                     order by f.created_at), '[]')
                     from public.sourcing_offers f join public.organizations o on o.id = f.seller_id where f.request_id = r.id))
      order by r.created_at desc)
      from (select * from public.sourcing_requests r
             where case coalesce(p_status, '')
                     when '' then r.status <> 'awaiting_payment' or r.payment_mode = 'proforma'
                     when 'open' then r.status in ('paid', 'in_progress') or (r.status = 'awaiting_payment' and r.payment_mode = 'proforma')
                     else r.status = p_status end
            order by r.created_at desc limit 100) r), '[]'));
end $$;

-- Retire une offre (motif obligatoire) : elle disparaît de la page de l'acheteur.
create or replace function public.admin_sourcing_offer_withdraw(p_offer text, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_by text := app.require_admin(); f public.sourcing_offers;
begin
  if coalesce(btrim(p_reason), '') = '' then raise exception 'Motif obligatoire' using errcode = 'CP005'; end if;
  update public.sourcing_offers set withdrawn_at = now(), withdrawn_by = v_by, withdrawn_reason = left(btrim(p_reason), 500)
   where id = upper(btrim(coalesce(p_offer, ''))) and withdrawn_at is null returning * into f;
  if f.id is null then raise exception 'Offre inconnue ou déjà retirée' using errcode = 'P0002'; end if;
  insert into public.events (actor, text, ref) values ('ops', 'Offre ' || f.id || ' retirée par ' || v_by || ' : ' || f.withdrawn_reason, f.request_id);
  return jsonb_build_object('id', f.id, 'request_id', f.request_id, 'withdrawn_at', f.withdrawn_at);
end $$;

-- Volontaires : liste (laboratoires compris) et modification par l'administrateur.
create or replace function public.admin_sourcing_volunteers()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_admin();
  return coalesce((select jsonb_agg(jsonb_build_object('org_id', v.org_id, 'name', o.name, 'alias', o.alias, 'profile', o.profile,
      'active', v.active, 'eligible', app.sourcing_eligible(v.org_id), 'labs', v.labs, 'joined_at', v.joined_at, 'left_at', v.left_at,
      'contacts', cardinality(app.seller_openids(v.org_id)),
      'score', (select public.supplier_score(v.org_id) -> 'sourcing')) order by v.active desc, o.name)
    from public.sourcing_volunteers v join public.organizations o on o.id = v.org_id), '[]');
end $$;

create or replace function public.admin_sourcing_volunteer_set(p_org text, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_by text := app.require_admin(); v_org text := upper(btrim(coalesce(p_org, '')));
begin
  if coalesce((p->>'active')::boolean, true) and not app.sourcing_eligible(v_org) then
    raise exception 'Réservé aux brokers et surplus approuvés' using errcode = '22023';
  end if;
  insert into public.sourcing_volunteers as v (org_id, active, labs, joined_by, updated_by)
  values (v_org, coalesce((p->>'active')::boolean, true), nullif(left(btrim(coalesce(p->>'labs', '')), 1000), ''), v_by, v_by)
  on conflict (org_id) do update set
    active = coalesce((p->>'active')::boolean, v.active),
    labs = case when p ? 'labs' then nullif(left(btrim(coalesce(p->>'labs', '')), 1000), '') else v.labs end,
    left_at = case when (p->>'active')::boolean is false and v.active then now() when (p->>'active')::boolean then null else v.left_at end,
    updated_at = now(), updated_by = v_by;
  insert into public.events (actor, text, ref) values ('ops', 'Volontaire des recherches payantes modifié par ' || v_by, v_org);
  return public.admin_sourcing_volunteers();
end $$;

-- ------------------------------------------------------------ droits
revoke execute on function app.sourcing_open_days(), app.sourcing_extend_days(), app.sourcing_max_offers(),
  app.sourcing_eligible(text), app.sourcing_card(text, text), app.sourcing_close(text, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.sourcing_open(text, timestamptz), public.sourcing_contacts(text),
  public.sourcing_notify_result(text, text, boolean, text, timestamptz),
  public.sourcing_answer(text, text, text, numeric, text, int, text, bigint, timestamptz),
  public.supplier_sourcing(text), public.supplier_sourcing_join(text, boolean, text),
  public.sourcing_buyer_action(text, text, text, boolean, timestamptz), public.sourcing_tick(timestamptz) from public, anon, authenticated;
grant execute on function public.sourcing_open(text, timestamptz), public.sourcing_contacts(text),
  public.sourcing_notify_result(text, text, boolean, text, timestamptz),
  public.sourcing_answer(text, text, text, numeric, text, int, text, bigint, timestamptz),
  public.supplier_sourcing(text), public.supplier_sourcing_join(text, boolean, text),
  public.sourcing_buyer_action(text, text, text, boolean, timestamptz), public.sourcing_tick(timestamptz) to service_role;
revoke execute on function public.admin_sourcing_offer_withdraw(text, text), public.admin_sourcing_volunteers(),
  public.admin_sourcing_volunteer_set(text, jsonb) from public, anon;
grant execute on function public.admin_sourcing_offer_withdraw(text, text), public.admin_sourcing_volunteers(),
  public.admin_sourcing_volunteer_set(text, jsonb) to authenticated, service_role;
