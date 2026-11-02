-- Route RFQ des plateformes clientes (Adesio d'abord), validée par un administrateur, diffusée dans WeChat (ADR 0023).
-- À appliquer à la main dans le SQL Editor, après 20261102000019. Rejouable ; n'efface aucune donnée existante.
--
-- Cycle :
--   1. La plateforme envoie une RFQ (POST /v1/demands, fonction Edge « rfq ») : create_rfq crée une demande DEM-… par
--      ligne, statut pending_validation. Rien ne part chez un fournisseur.
--   2. Un administrateur valide (robot WeChat « approve DEM-… », back office) : approve_rfq passe la demande en enchère
--      (auction), apparie les fournisseurs (app.rfq_candidates) et les inscrit dans demand_sellers (notify_status
--      pending). Ou il refuse avec un motif : reject_rfq.
--   3. La fonction Edge envoie le message à chaque fournisseur et inscrit le résultat : record_notify_result. Le délai
--      de réponse de 48 h (RFQ_RESPONSE_HOURS) démarre à l'envoi RÉUSSI ; un envoi échoué ne compte jamais contre le
--      fournisseur.
--   4. Le fournisseur répond dans WeChat (报价 / 无货 DEM-…) ou sur /depot/ : supplier_rfq_answer. Après l'échéance,
--      la réponse est refusée (CP410) et aucun bid n'est enregistré.
--   5. Quand tous ont répondu ou expiré : close_rfq consolide les offres tout compris (net + marge du vendeur,
--      converti dans la devise demandée) ; webhook demand.offers_ready ou demand.no_offer.
--
-- Anonymat : le fournisseur ne voit jamais client_org_id, customer_reference, ni le prix cible (rfq_for_supplier) ;
-- la plateforme ne voit jamais le fournisseur, son pseudonyme, son SKU, son lot, ni son prix net (rfq_offers_for_client).
-- Les heures sont passées en paramètre (p_now) pour que les contrôles simulent l'horloge.

-- ------------------------------------------------------------ demandes
alter table public.demands drop constraint if exists demands_status_check;
alter table public.demands add constraint demands_status_check check (status in
  ('pending_validation', 'rejected', 'auction', 'offers', 'no_offer', 'ordered', 'cancelled'));

alter table public.demands
  add column if not exists client_org_id      text references public.organizations,   -- la plateforme, vue par l'ops seulement
  add column if not exists customer_reference text,                                   -- jamais transmise au fournisseur
  add column if not exists line_id            text,                                   -- identifiant de la ligne chez la plateforme
  add column if not exists batch_ref          text,                                   -- rfq_id : lot de lignes d'un même appel
  add column if not exists idempotency_key    text,
  add column if not exists request_hash       text,                                   -- empreinte du corps de l'appel
  add column if not exists sandbox            boolean not null default false,         -- clé cp_test_ : aucun envoi réel
  add column if not exists validated_by       text,
  add column if not exists validated_at       timestamptz,
  add column if not exists rejected_reason    text,
  add column if not exists ops_reminded_at    timestamptz;                            -- rappel 24 h à l'administrateur
create index if not exists demands_client_status on public.demands (client_org_id, status);
create unique index if not exists demands_client_idem_line on public.demands (client_org_id, idempotency_key, line_id)
  where idempotency_key is not null;

create sequence if not exists app.rfq_seq start 1;

-- Portée d'une clé d'API : « demands:write » autorise la création de RFQ. Les clés existantes n'en ont aucune.
alter table public.api_keys add column if not exists scopes text[] not null default '{}';

-- ------------------------------------------------------------ fournisseurs consultés
-- notified_at = envoi réussi (null tant que rien n'est parti) ; deadline_at = notified_at + 48 h.
alter table public.demand_sellers alter column notified_at drop not null;
alter table public.demand_sellers
  add column if not exists lot_id           text references public.lots on delete set null,  -- lot apparié
  add column if not exists notify_status    text not null default 'sent'
    check (notify_status in ('pending', 'sent', 'failed', 'no_channel')),
  add column if not exists notify_error     text,
  add column if not exists notify_attempts  smallint not null default 0,
  add column if not exists deadline_at      timestamptz,
  add column if not exists response_status  text not null default 'pending'
    check (response_status in ('pending', 'quoted', 'declined', 'expired')),
  add column if not exists responded_at     timestamptz,
  add column if not exists responded_by     text,                                            -- openid du contact
  add column if not exists reminder_sent_at timestamptz;
create index if not exists demand_sellers_deadline on public.demand_sellers (deadline_at) where response_status = 'pending';

-- ------------------------------------------------------------ journal des décisions (modèle : supplier_decisions)
create table if not exists public.demand_decisions (
  id         bigint generated always as identity primary key,
  demand_id  text not null references public.demands on delete cascade,
  decision   text not null check (decision in ('approved', 'rejected', 'cancelled', 'resent')),
  reason     text,
  by         text,                           -- openid de l'opérateur, « admin:<e-mail> », ou « client:<ORG-…> »
  at         timestamptz not null default now()
);
create index if not exists demand_decisions_demand on public.demand_decisions (demand_id, at desc);
drop trigger if exists demand_decisions_append_only on public.demand_decisions;
create trigger demand_decisions_append_only before update or delete on public.demand_decisions
  for each row execute function app.append_only();

-- ------------------------------------------------------------ notation des fournisseurs (comptage seulement)
create table if not exists public.supplier_scores (
  seller_id               text not null references public.organizations on delete cascade,
  period                  text not null check (period ~ '^\d{4}-\d{2}$'),   -- mois de la notification
  received                integer not null default 0,
  quoted                  integer not null default 0,
  declined                integer not null default 0,
  expired                 integer not null default 0,
  median_response_minutes integer,
  updated_at              timestamptz not null default now(),
  primary key (seller_id, period)
);

-- ------------------------------------------------------------ webhooks des plateformes
-- Le secret de signature n'est pas en base : la fonction Edge le dérive de RFQ_WEBHOOK_KEY et de l'identifiant
-- de l'abonnement (signing_secret_ref = 'derived:v1'), et ne l'affiche qu'une fois, à la création.
create table if not exists public.webhook_deliveries (
  id              bigint generated always as identity primary key,
  webhook_id      text not null references public.webhooks on delete cascade,
  event           text not null,
  payload         jsonb not null,
  created_at      timestamptz not null default now(),
  attempts        smallint not null default 0,
  next_attempt_at timestamptz not null default now(),
  delivered_at    timestamptz,
  failed_at       timestamptz,                 -- abandon après 24 h de tentatives
  last_status     smallint
);
create index if not exists webhook_deliveries_due on public.webhook_deliveries (next_attempt_at)
  where delivered_at is null and failed_at is null;

-- Limite d'appels par clé et par minute (60), comme app.search_hits.
create table if not exists app.api_hits (
  key_id  text not null,
  minute  timestamptz not null,
  hits    integer not null default 1,
  primary key (key_id, minute)
);
revoke all on app.api_hits from public, anon, authenticated;

-- ------------------------------------------------------------ RLS
alter table public.demand_decisions enable row level security;
alter table public.supplier_scores enable row level security;
alter table public.webhook_deliveries enable row level security;
revoke all on public.demand_decisions, public.supplier_scores, public.webhook_deliveries from anon, authenticated;
drop policy if exists ops on public.demand_decisions;
drop policy if exists ops on public.supplier_scores;
drop policy if exists ops on public.webhook_deliveries;
create policy ops on public.demand_decisions for select to authenticated using (app.is_ops());
create policy ops on public.supplier_scores for select to authenticated using (app.is_ops());
create policy ops on public.webhook_deliveries for select to authenticated using (app.is_ops());
grant select on public.demand_decisions, public.supplier_scores, public.webhook_deliveries to authenticated;

-- ------------------------------------------------------------ constantes (faciles à changer)
-- Délai de réponse du fournisseur (heures réelles), distinct de la fenêtre WeChat de 48 h (texte libre), gérée
-- par sendText côté Edge.
create or replace function app.rfq_response_hours() returns int language sql immutable as $$ select 48 $$;
create or replace function app.rfq_reminder_hours() returns int language sql immutable as $$ select 36 $$;
create or replace function app.rfq_ops_reminder_hours() returns int language sql immutable as $$ select 24 $$;
create or replace function app.rfq_max_lines() returns int language sql immutable as $$ select 50 $$;
create or replace function app.rfq_max_pending() returns int language sql immutable as $$ select 50 $$;
create or replace function app.rfq_offer_valid_days() returns int language sql immutable as $$ select 7 $$;
-- Seuil de données avant que la note serve à ordonner (10 demandes reçues).
create or replace function app.score_threshold() returns int language sql immutable as $$ select 10 $$;
create or replace function app.api_calls_per_minute() returns int language sql immutable as $$ select 60 $$;

-- Devise acceptée : CNY et RMB enregistrés en CNH (api/fournisseurs.md). Null si refusée.
create or replace function app.norm_currency(p text) returns text
language sql stable security definer set search_path = '' as $$
  select c.code from public.currencies c
   where c.code = case when upper(btrim(coalesce(p, ''))) in ('CNY', 'RMB') then 'CNH' else upper(btrim(coalesce(p, ''))) end
$$;

-- Statut vu par la plateforme.
create or replace function app.rfq_api_status(p text) returns text language sql immutable as $$
  select case p when 'auction' then 'open' when 'offers' then 'offers_ready' else p end
$$;

-- Catégorie de source de l'API d'offres : une offre de broker n'est jamais présentée comme agréée.
create or replace function app.api_source_category(p_profile text) returns text
language sql immutable set search_path = '' as $$
  select case app.source_category(p_profile)
    when 'manufacturer' then 'manufacturer' when 'distributor' then 'authorized_distributor' else 'broker_surplus' end
$$;

-- ------------------------------------------------------------ authentification des plateformes
-- Clé présentée (empreinte sha256 calculée par la fonction Edge) → organisation, environnement, portées, compteur.
-- Erreurs : CP401 clé absente ou révoquée, CP403 organisation non cliente, CP429 limite (detail = secondes restantes).
create or replace function public.rfq_auth(p_key_hash text, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare k public.api_keys; o public.organizations; v_hits int; v_min timestamptz := date_trunc('minute', p_now);
begin
  select * into k from public.api_keys where key_hash = p_key_hash and revoked_at is null;
  if k.id is null then raise exception 'Clé absente ou révoquée' using errcode = 'CP401'; end if;
  select * into o from public.organizations where id = k.org_id;
  if o.type <> 'buyer' then raise exception 'Clé non autorisée' using errcode = 'CP403'; end if;
  insert into app.api_hits (key_id, minute) values (k.id, v_min)
  on conflict (key_id, minute) do update set hits = app.api_hits.hits + 1 returning hits into v_hits;
  delete from app.api_hits where minute < p_now - interval '1 hour';
  update public.api_keys set last_used_at = p_now where id = k.id;
  if v_hits > app.api_calls_per_minute() then
    raise exception 'Limite d''appels atteinte' using errcode = 'CP429',
      detail = (60 - extract(second from p_now)::int)::text;
  end if;
  return jsonb_build_object('key_id', k.id, 'org_id', o.id, 'org_name', o.name,
    'sandbox', k.environment = 'sandbox' or o.sandbox, 'environment', k.environment, 'scopes', to_jsonb(k.scopes),
    'limit', app.api_calls_per_minute(), 'remaining', greatest(app.api_calls_per_minute() - v_hits, 0),
    'reset', extract(epoch from v_min + interval '1 minute')::bigint);
end $$;

-- ------------------------------------------------------------ événements vers les plateformes
create or replace function app.enqueue_client_event(p_demand text, p_event text, p_now timestamptz default now())
returns void language plpgsql security definer set search_path = '' as $$
declare d public.demands;
begin
  select * into d from public.demands where id = p_demand;
  if d.client_org_id is null then return; end if;
  insert into public.webhook_deliveries (webhook_id, event, payload, created_at, next_attempt_at)
  select w.id, p_event, jsonb_strip_nulls(jsonb_build_object(
           'event', p_event, 'occurred_at', p_now, 'sandbox', d.sandbox, 'rfq_id', d.batch_ref, 'demand_id', d.id,
           'line_id', d.line_id, 'customer_reference', d.customer_reference, 'status', app.rfq_api_status(d.status),
           'rejected_reason', d.rejected_reason,
           'offers_count', case when p_event = 'demand.offers_ready' then
             (select count(*) from public.offers f where f.demand_id = d.id and f.status = 'open') end)),
         p_now, p_now
    from public.webhooks w
   where w.org_id = d.client_org_id and w.disabled_at is null and p_event = any (w.events);
end $$;

-- ------------------------------------------------------------ création (API plateforme)
-- p : { customer_reference, currency, ship_to_country, lines: [{line_id, mpn, manufacturer?, quantity,
-- date_code_min?, packaging?, lead_days_max?, target_price?}] }. Une demande par ligne, statut pending_validation.
-- Idempotence 24 h : même clé et même corps → même réponse ; même clé, autre corps → CP409.
-- Erreurs : 22023 ligne invalide (detail = line_id et champ), CP409, CP429 (plus de 50 demandes en attente).
create or replace function public.create_rfq(p_org text, p_idempotency_key text, p_request_hash text, p jsonb,
  p_sandbox boolean default false, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_cur text; v_zone text; v_batch text; l jsonb; v_i int := 0; v_ids jsonb := '[]'; v_id text; v_line text;
  v_qty int; v_lead int; v_target numeric; v_prev record;
begin
  if coalesce(btrim(p_idempotency_key), '') = '' or length(p_idempotency_key) > 200 then
    raise exception 'En-tête Idempotency-Key obligatoire' using errcode = '22023', detail = 'Idempotency-Key';
  end if;
  -- Rejeu : on renvoie la réponse d'origine, sans rien créer.
  select batch_ref, request_hash into v_prev from public.demands
   where client_org_id = p_org and idempotency_key = p_idempotency_key and created_at > p_now - interval '24 hours' limit 1;
  if v_prev.batch_ref is not null then
    if v_prev.request_hash is distinct from p_request_hash then
      raise exception 'Idempotency-Key déjà utilisée avec un autre corps' using errcode = 'CP409';
    end if;
    return public.rfq_batch_for_client(p_org, v_prev.batch_ref);
  end if;

  v_cur := app.norm_currency(p->>'currency');
  if v_cur is null then raise exception 'Devise non acceptée' using errcode = '22023', detail = 'currency'; end if;
  v_zone := upper(coalesce(p->>'ship_to_country', ''));
  if v_zone !~ '^[A-Z]{2}$' then raise exception 'Pays de livraison invalide' using errcode = '22023', detail = 'ship_to_country'; end if;
  if jsonb_typeof(p->'lines') <> 'array' or jsonb_array_length(p->'lines') not between 1 and app.rfq_max_lines() then
    raise exception 'De 1 à % lignes', app.rfq_max_lines() using errcode = '22023', detail = 'lines';
  end if;
  if (select count(*) from public.demands where client_org_id = p_org and status = 'pending_validation')
     + jsonb_array_length(p->'lines') > app.rfq_max_pending() then
    raise exception 'Plus de % demandes en attente de validation', app.rfq_max_pending() using errcode = 'CP429', detail = '600';
  end if;

  v_batch := app.ref('RFQ', 'app.rfq_seq');
  for l in select * from jsonb_array_elements(p->'lines') loop
    v_i := v_i + 1;
    v_line := left(coalesce(nullif(btrim(l->>'line_id'), ''), v_i::text), 80);
    v_qty := case when coalesce(l->>'quantity', '') ~ '^\d{1,9}$' then (l->>'quantity')::int end;
    v_lead := case when coalesce(l->>'lead_days_max', '') ~ '^\d{1,4}$' then (l->>'lead_days_max')::int end;
    v_target := case when coalesce(l->>'target_price', '') ~ '^\d+(\.\d+)?$' then (l->>'target_price')::numeric end;
    if coalesce(btrim(l->>'mpn'), '') = '' then
      raise exception 'Référence (mpn) vide' using errcode = '22023', detail = 'lines[' || v_line || '].mpn';
    end if;
    if v_qty is null or v_qty < 1 then
      raise exception 'Quantité invalide' using errcode = '22023', detail = 'lines[' || v_line || '].quantity';
    end if;
    if l ? 'target_price' and l->>'target_price' is not null and (v_target is null or v_target <= 0) then
      raise exception 'Prix cible invalide' using errcode = '22023', detail = 'lines[' || v_line || '].target_price';
    end if;
    insert into public.demands (buyer_id, client_org_id, mpn, manufacturer, qty, dc_min, pack, zone, lead_days,
        target_price, currency, status, closes_at, customer_reference, line_id, batch_ref, idempotency_key,
        request_hash, sandbox, created_at)
    values (p_org, p_org, upper(regexp_replace(btrim(l->>'mpn'), '\s+', '', 'g')), nullif(btrim(l->>'manufacturer'), ''),
        v_qty, nullif(btrim(l->>'date_code_min'), ''), nullif(btrim(l->>'packaging'), ''), v_zone, v_lead, v_target,
        v_cur, 'pending_validation', p_now + interval '7 days', left(nullif(btrim(p->>'customer_reference'), ''), 200),
        v_line, v_batch, p_idempotency_key, p_request_hash, p_sandbox, p_now)
    returning id into v_id;
  end loop;
  insert into public.events (at, actor, text, ref)
  values (p_now, 'platform', 'RFQ ' || v_batch || ' reçue : ' || v_i || ' ligne(s), en attente de validation', p_org);
  return public.rfq_batch_for_client(p_org, v_batch);
end $$;

-- ------------------------------------------------------------ lectures de la plateforme
-- Ce que voit la plateforme d'une demande : jamais un fournisseur, ni le nombre de fournisseurs consultés.
create or replace function app.rfq_demand_json(d public.demands) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_strip_nulls(jsonb_build_object('id', d.id, 'rfq_id', d.batch_ref, 'line_id', d.line_id,
    'customer_reference', d.customer_reference, 'status', app.rfq_api_status(d.status), 'mpn', d.mpn,
    'manufacturer', d.manufacturer, 'quantity', d.qty, 'currency', d.currency, 'ship_to_country', d.zone,
    'date_code_min', d.dc_min, 'packaging', d.pack, 'lead_days_max', d.lead_days, 'target_price', d.target_price,
    'rejected_reason', d.rejected_reason, 'created_at', d.created_at, 'validated_at', d.validated_at,
    'closed_at', d.closed_at, 'sandbox', case when d.sandbox then true end,
    'offers_count', case when d.status in ('offers', 'ordered') then
      (select count(*) from public.offers f where f.demand_id = d.id and f.status in ('open', 'accepted')) end))
$$;

create or replace function public.rfq_batch_for_client(p_org text, p_batch text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('rfq_id', p_batch, 'demands', coalesce(jsonb_agg(jsonb_build_object(
           'line_id', d.line_id, 'id', d.id, 'status', app.rfq_api_status(d.status)) order by d.id), '[]'))
    from public.demands d where d.client_org_id = p_org and d.batch_ref = p_batch
$$;

create or replace function public.rfq_demand_for_client(p_org text, p_id text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select app.rfq_demand_json(d) from public.demands d where d.id = upper(p_id) and d.client_org_id = p_org
$$;

-- Filtres : status (statut de l'API), customer_reference, created_since ; 100 au plus, les plus récentes d'abord.
create or replace function public.rfq_demands_for_client(p_org text, p_status text default null,
  p_customer_reference text default null, p_created_since timestamptz default null)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(j order by created_at desc), '[]') from (
    select app.rfq_demand_json(d) as j, d.created_at from public.demands d
     where d.client_org_id = p_org
       and (p_status is null or app.rfq_api_status(d.status) = p_status)
       and (p_customer_reference is null or d.customer_reference = p_customer_reference)
       and (p_created_since is null or d.created_at >= p_created_since)
     order by d.created_at desc limit 100) s
$$;

-- Offres consolidées, prix tout compris dans la devise demandée. Jamais : fournisseur, pseudonyme, SKU, lot, prix net.
create or replace function public.rfq_offers_for_client(p_org text, p_id text, p_now timestamptz default now())
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare d public.demands;
begin
  select * into d from public.demands where id = upper(p_id) and client_org_id = p_org;
  if d.id is null then raise exception 'Demande inconnue' using errcode = 'P0002'; end if;
  return jsonb_build_object('demand_id', d.id, 'status', app.rfq_api_status(d.status), 'currency', d.currency,
    'offers', coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
               'offer_id', f.id, 'rank', f.rank, 'mpn', l.mpn, 'manufacturer', nullif(l.manufacturer, ''),
               'source_category', app.api_source_category(s.profile), 'price_status', 'priced',
               'quantity', d.qty, 'stock', l.qty, 'currency', f.buyer_currency, 'unit_price', f.unit_price,
               'extended_price', round(f.unit_price * d.qty, 2), 'lead_time_days', f.lead_days,
               'date_code', nullif(f.date_code, ''), 'packaging', l.pack, 'ship_from', s.country,
               'price_valid_until', f.valid_until)) order by f.rank)
        from public.offers f
        join public.lots l on l.id = f.lot_id
        join public.organizations s on s.id = f.seller_id
       where f.demand_id = d.id and f.status in ('open', 'accepted') and f.valid_until > p_now), '[]'));
end $$;

-- Annulation par la plateforme, tant qu'aucune offre n'est acceptée. Renvoie les fournisseurs déjà prévenus.
create or replace function public.cancel_rfq(p_org text, p_id text, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare d public.demands;
begin
  select * into d from public.demands where id = upper(p_id) and client_org_id = p_org for update;
  if d.id is null then raise exception 'Demande inconnue' using errcode = 'P0002'; end if;
  if d.status in ('ordered', 'cancelled', 'rejected') then
    raise exception 'Annulation impossible au statut %', app.rfq_api_status(d.status) using errcode = 'CP409';
  end if;
  update public.demands set status = 'cancelled', closed_at = p_now where id = d.id returning * into d;
  update public.offers set status = 'expired' where demand_id = d.id and status = 'open';
  insert into public.demand_decisions (demand_id, decision, by, at) values (d.id, 'cancelled', 'client:' || p_org, p_now);
  insert into public.events (at, actor, text, ref) values (p_now, 'platform', 'Demande ' || d.id || ' annulée par la plateforme', p_org);
  return jsonb_build_object('demand', app.rfq_demand_json(d), 'notify', public.rfq_contacts(d.id, true));
end $$;

-- ------------------------------------------------------------ appariement
-- Date code du lot au moins égal au minimum demandé (comparaison des 4 premiers chiffres AASS) ; inconnu : accepté.
create or replace function app.dc_ok(p_lot_dc text, p_min text) returns boolean language sql immutable as $$
  select p_min is null or btrim(p_min) = '' or coalesce(p_lot_dc, '') !~ '^\d{4}'
      or btrim(p_min) !~ '^\d{4}' or left(p_lot_dc, 4) >= left(btrim(p_min), 4)
$$;

-- Comptes WeChat à prévenir pour une société : contacts rattachés et canaux 服务号 actifs abonnés à demand.created.
create or replace function app.seller_openids(p_org text) returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct x), '{}') from (
    select w.openid as x from public.wechat_identities w where w.org_id = p_org and w.revoked_at is null
    union
    select c.target from public.channels c
     where c.org_id = p_org and c.type = 'wechat_oa' and c.status = 'active' and 'demand.created' = any (c.events)
       and c.target is not null) s
$$;

-- Note d'ordonnancement : taux de traitement, seulement au-delà du seuil de données ; null en dessous.
create or replace function app.score_weight(p_org text) returns numeric
language sql stable security definer set search_path = '' as $$
  select case when sum(received) >= app.score_threshold()
              then (sum(quoted) + sum(declined))::numeric / nullif(sum(received), 0) end
    from public.supplier_scores where seller_id = p_org
$$;

-- Fournisseurs qui correspondent : approuvés et à jour, lot de la référence (même fabricant si fourni, date code
-- suffisant si connu), au moins un compte WeChat à prévenir ; bac à sable avec bac à sable seulement.
-- Un lot par fournisseur : celui qui couvre la quantité, sinon le plus gros. Ordre : mieux notés d'abord ; sous le
-- seuil, la moyenne des notés (ni avantage ni désavantage).
create or replace function app.rfq_candidates(p_demand text)
returns table (seller_id text, lot_id text, weight numeric)
language sql stable security definer set search_path = '' as $$
  with d as (select * from public.demands where id = p_demand),
  lots as (
    select distinct on (l.seller_id) l.seller_id, l.id
      from public.lots l join public.organizations o on o.id = l.seller_id, d
     where upper(regexp_replace(l.mpn, '\s+', '', 'g')) = d.mpn and l.qty > 0
       and (d.manufacturer is null or l.manufacturer = '' or lower(btrim(l.manufacturer)) = lower(btrim(d.manufacturer)))
       and app.dc_ok(l.date_code, d.dc_min)
       and o.type = 'seller' and app.is_verified(o.id) and o.sandbox = d.sandbox
       and cardinality(app.seller_openids(o.id)) > 0
     order by l.seller_id, (l.qty >= d.qty) desc, l.qty desc, l.id),
  w as (select lots.*, app.score_weight(lots.seller_id) as sw from lots)
  select w.seller_id, w.id, coalesce(w.sw, (select avg(sw) from w), 1) from w
   order by 3 desc, w.seller_id
$$;

-- ------------------------------------------------------------ fiche administrateur
create or replace function public.rfq_for_operator(p_id text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_strip_nulls(jsonb_build_object('id', d.id, 'status', d.status, 'rfq_id', d.batch_ref,
    'client', c.id || ' ' || c.name, 'customer_reference', d.customer_reference, 'mpn', d.mpn,
    'manufacturer', d.manufacturer, 'qty', d.qty, 'dc_min', d.dc_min, 'packaging', d.pack, 'ship_to', d.zone,
    'currency', d.currency, 'target_price', d.target_price, 'lead_days_max', d.lead_days, 'sandbox', d.sandbox,
    'created_at', d.created_at, 'rejected_reason', d.rejected_reason, 'validated_by', d.validated_by,
    'candidates', case when d.status = 'pending_validation' then
      (select coalesce(jsonb_agg(x.seller_id), '[]') from app.rfq_candidates(d.id) x) end,
    'sellers', (select jsonb_agg(jsonb_build_object('org', s.seller_id, 'notify', s.notify_status,
                  'response', s.response_status, 'deadline_at', s.deadline_at, 'error', s.notify_error) order by s.seller_id)
                  from public.demand_sellers s where s.demand_id = d.id),
    'bids', (select count(*) from public.bids b where b.demand_id = d.id)))
    from public.demands d left join public.organizations c on c.id = d.client_org_id
   where d.id = upper(p_id)
$$;

create or replace function public.list_pending_rfq()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(public.rfq_for_operator(d.id) order by d.created_at), '[]')
    from (select id, created_at from public.demands where status = 'pending_validation' order by created_at limit 50) d
$$;

-- ------------------------------------------------------------ décisions de l'administrateur
-- Validation : enchère ouverte, fournisseurs appariés inscrits (notify_status pending). p_only : restreindre la
-- diffusion à ces sociétés (elles doivent correspondre). Aucun apparié : no_offer immédiat.
-- Erreurs : P0002 demande inconnue, CP409 déjà traitée, 22023 société de p_only hors appariement.
create or replace function public.approve_rfq(p_id text, p_by text, p_only text[] default null,
  p_closes_at timestamptz default null, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare d public.demands; v_bad text[]; v_n int;
begin
  select * into d from public.demands where id = upper(p_id) for update;
  if d.id is null then raise exception 'Demande inconnue : %', p_id using errcode = 'P0002'; end if;
  if d.status <> 'pending_validation' then
    raise exception 'Demande % déjà traitée (%)', d.id, d.status using errcode = 'CP409';
  end if;
  if p_only is not null then
    select array_agg(x) into v_bad from unnest(p_only) x
     where upper(x) not in (select c.seller_id from app.rfq_candidates(d.id) c);
    if v_bad is not null then
      raise exception 'Hors appariement : %', array_to_string(v_bad, ', ') using errcode = '22023';
    end if;
  end if;
  update public.demands set status = 'auction', validated_by = p_by, validated_at = p_now,
         closes_at = coalesce(p_closes_at, p_now + make_interval(hours => app.rfq_response_hours()))
   where id = d.id;
  insert into public.demand_sellers (demand_id, seller_id, via, lot_id, notified_at, notify_status, response_status)
  select d.id, c.seller_id, 'catalog', c.lot_id, null, 'pending', 'pending'
    from app.rfq_candidates(d.id) c
   where p_only is null or c.seller_id = any (select upper(x) from unnest(p_only) x);
  get diagnostics v_n = row_count;
  insert into public.demand_decisions (demand_id, decision, reason, by, at)
  values (d.id, 'approved', case when p_only is not null then 'Diffusion limitée : ' || array_to_string(p_only, ', ') end, p_by, p_now);
  insert into public.events (at, actor, text, ref) values (p_now, 'ops', 'Demande ' || d.id || ' validée (' || v_n || ' fournisseur(s))' || coalesce(' par ' || p_by, ''), d.client_org_id);
  perform app.enqueue_client_event(d.id, 'demand.validated', p_now);
  if v_n = 0 then
    update public.demands set status = 'no_offer', closed_at = p_now where id = d.id;
    perform app.enqueue_client_event(d.id, 'demand.no_offer', p_now);
  end if;
  return public.rfq_for_operator(d.id);
end $$;

-- Refus, motif obligatoire (CP005). Rien n'a été envoyé aux fournisseurs.
create or replace function public.reject_rfq(p_id text, p_reason text, p_by text, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare d public.demands;
begin
  if coalesce(btrim(p_reason), '') = '' then raise exception 'Motif obligatoire' using errcode = 'CP005'; end if;
  select * into d from public.demands where id = upper(p_id) for update;
  if d.id is null then raise exception 'Demande inconnue : %', p_id using errcode = 'P0002'; end if;
  if d.status <> 'pending_validation' then
    raise exception 'Demande % déjà traitée (%)', d.id, d.status using errcode = 'CP409';
  end if;
  update public.demands set status = 'rejected', rejected_reason = left(btrim(p_reason), 500), validated_by = p_by,
         validated_at = p_now, closed_at = p_now where id = d.id;
  insert into public.demand_decisions (demand_id, decision, reason, by, at) values (d.id, 'rejected', btrim(p_reason), p_by, p_now);
  insert into public.events (at, actor, text, ref) values (p_now, 'ops', 'Demande ' || d.id || ' refusée' || coalesce(' par ' || p_by, ''), d.client_org_id);
  perform app.enqueue_client_event(d.id, 'demand.rejected', p_now);
  return public.rfq_for_operator(d.id);
end $$;

-- Rappel à l'administrateur : demandes en attente depuis 24 h, une seule fois. Jamais de diffusion automatique.
create or replace function public.claim_ops_rfq_reminders(p_now timestamptz default now())
returns jsonb language sql security definer set search_path = '' as $$
  with r as (
    update public.demands set ops_reminded_at = p_now
     where status = 'pending_validation' and ops_reminded_at is null
       and created_at <= p_now - make_interval(hours => app.rfq_ops_reminder_hours())
    returning id)
  select coalesce(jsonb_agg(id order by id), '[]') from r
$$;

-- ------------------------------------------------------------ diffusion
-- Message au fournisseur : jamais la plateforme, l'acheteur, customer_reference ni le prix cible.
create or replace function public.rfq_for_supplier(p_id text, p_seller text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_strip_nulls(jsonb_build_object('ref', d.id, 'mpn', d.mpn, 'manufacturer', d.manufacturer, 'qty', d.qty,
    'dc_min', d.dc_min, 'packaging', d.pack, 'lead_days_max', d.lead_days, 'ship_to', d.zone, 'status', d.status,
    'deadline_at', s.deadline_at, 'notify_status', s.notify_status, 'response', s.response_status,
    'responded_at', s.responded_at, 'lot', s.lot_id, 'lang', o.lang, 'sandbox', case when d.sandbox then true end))
    from public.demands d
    join public.demand_sellers s on s.demand_id = d.id and s.seller_id = p_seller
    join public.organizations o on o.id = s.seller_id
   where d.id = upper(p_id)
$$;

-- Destinataires d'une demande : p_all = tous les fournisseurs déjà prévenus (annulation) ; sinon ceux à prévenir
-- (pending ou failed, enchère ouverte).
create or replace function public.rfq_contacts(p_id text, p_all boolean default false)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('seller_id', s.seller_id, 'openids', to_jsonb(app.seller_openids(s.seller_id)),
           'card', public.rfq_for_supplier(s.demand_id, s.seller_id)) order by s.seller_id), '[]')
    from public.demand_sellers s join public.demands d on d.id = s.demand_id
   where s.demand_id = upper(p_id)
     and case when p_all then s.notify_status = 'sent'
              else d.status = 'auction' and s.notify_status in ('pending', 'failed') and s.response_status = 'pending' end
$$;

-- Résultat de l'envoi : réussi → l'échéance démarre (notified_at + 48 h), l'enchère reste ouverte au moins jusque-là ;
-- échec ou aucun canal → rien ne démarre, rien n'est compté contre le fournisseur.
create or replace function public.record_notify_result(p_id text, p_seller text, p_ok boolean, p_error text default null,
  p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.demand_sellers;
begin
  update public.demand_sellers
     set notify_attempts = notify_attempts + 1,
         notify_status = case when p_ok then 'sent' when p_error = 'no_channel' then 'no_channel' else 'failed' end,
         notify_error = case when p_ok then null else left(p_error, 300) end,
         notified_at = case when p_ok then p_now else notified_at end,
         deadline_at = case when p_ok then p_now + make_interval(hours => app.rfq_response_hours()) else deadline_at end
   where demand_id = upper(p_id) and seller_id = p_seller and notify_status <> 'sent' and response_status = 'pending'
  returning * into s;
  if s.demand_id is null then raise exception 'Fournisseur non concerné ou déjà prévenu' using errcode = 'P0002'; end if;
  if p_ok then
    update public.demands set closes_at = greatest(closes_at, s.deadline_at) where id = s.demand_id;
    perform app.refresh_supplier_score(s.seller_id, s.notified_at);
  end if;
  return public.rfq_for_supplier(s.demand_id, s.seller_id);
end $$;

-- Renvoi par l'administrateur (commande resend) : remet le fournisseur « à prévenir » s'il n'a pas été joint.
create or replace function public.resend_rfq(p_id text, p_seller text, p_by text, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.demand_sellers;
begin
  select * into s from public.demand_sellers where demand_id = upper(p_id) and seller_id = upper(p_seller) for update;
  if s.demand_id is null then raise exception 'Fournisseur non consulté pour %', p_id using errcode = 'P0002'; end if;
  if s.notify_status = 'sent' then raise exception 'Déjà prévenu' using errcode = 'CP409'; end if;
  if (select status from public.demands where id = s.demand_id) <> 'auction' then
    raise exception 'Enchère fermée' using errcode = 'CP409';
  end if;
  update public.demand_sellers set notify_status = 'pending', notify_error = null
   where demand_id = s.demand_id and seller_id = s.seller_id;
  insert into public.demand_decisions (demand_id, decision, reason, by, at) values (s.demand_id, 'resent', s.seller_id, p_by, p_now);
  return jsonb_build_object('seller_id', s.seller_id, 'openids', to_jsonb(app.seller_openids(s.seller_id)),
    'card', public.rfq_for_supplier(s.demand_id, s.seller_id));
end $$;

-- Rappel à 36 h aux fournisseurs prévenus qui n'ont pas répondu, une seule fois.
create or replace function public.claim_rfq_reminders(p_now timestamptz default now())
returns jsonb language sql security definer set search_path = '' as $$
  with r as (
    update public.demand_sellers s set reminder_sent_at = p_now
      from public.demands d
     where d.id = s.demand_id and d.status = 'auction' and s.notify_status = 'sent' and s.response_status = 'pending'
       and s.reminder_sent_at is null and s.deadline_at > p_now
       and p_now >= s.notified_at + make_interval(hours => app.rfq_reminder_hours())
    returning s.demand_id, s.seller_id)
  select coalesce(jsonb_agg(jsonb_build_object('seller_id', r.seller_id, 'openids', to_jsonb(app.seller_openids(r.seller_id)),
           'card', public.rfq_for_supplier(r.demand_id, r.seller_id)) order by r.demand_id, r.seller_id), '[]') from r
$$;

-- ------------------------------------------------------------ notation
-- Recalcule la ligne du mois de la notification à partir de demand_sellers (une seule source de vérité).
create or replace function app.refresh_supplier_score(p_seller text, p_at timestamptz)
returns void language plpgsql security definer set search_path = '' as $$
declare v_period text := to_char(p_at at time zone 'UTC', 'YYYY-MM');
begin
  insert into public.supplier_scores (seller_id, period, received, quoted, declined, expired, median_response_minutes, updated_at)
  select p_seller, v_period, count(*), count(*) filter (where response_status = 'quoted'),
         count(*) filter (where response_status = 'declined'), count(*) filter (where response_status = 'expired'),
         (percentile_cont(0.5) within group (order by extract(epoch from responded_at - notified_at) / 60)
            filter (where response_status in ('quoted', 'declined')))::int, now()
    from public.demand_sellers
   where seller_id = p_seller and notify_status = 'sent' and to_char(notified_at at time zone 'UTC', 'YYYY-MM') = v_period
  on conflict (seller_id, period) do update set received = excluded.received, quoted = excluded.quoted,
    declined = excluded.declined, expired = excluded.expired, median_response_minutes = excluded.median_response_minutes,
    updated_at = excluded.updated_at;
end $$;

create or replace function app.record_supplier_response(p_id text, p_seller text)
returns void language sql security definer set search_path = '' as $$
  select app.refresh_supplier_score(s.seller_id, s.notified_at) from public.demand_sellers s
   where s.demand_id = p_id and s.seller_id = p_seller and s.notified_at is not null
$$;

-- Échéances passées sans réponse : « expired », compteur « non traité ». Renvoie les demandes devenues complètes.
create or replace function public.expire_overdue_sellers(p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r record; v_dem text[] := '{}';
begin
  for r in update public.demand_sellers set response_status = 'expired'
            where notify_status = 'sent' and response_status = 'pending' and deadline_at < p_now
           returning demand_id, seller_id, notified_at loop
    perform app.refresh_supplier_score(r.seller_id, r.notified_at);
    v_dem := array_append(v_dem, r.demand_id);
  end loop;
  return coalesce((select jsonb_agg(distinct x) from unnest(v_dem) x), '[]');
end $$;

-- Taux de traitement d'un fournisseur (administrateur : « rfq stats ORG-… » ; fournisseur : le sien sur /depot/).
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
         order by deadline_at desc limit 20) e))
    from public.supplier_scores where seller_id = p_org
$$;

-- ------------------------------------------------------------ réponse du fournisseur
-- p_kind : 'quote' (prix net unitaire, devise, délai en jours, date code ; lot facultatif) ou 'decline' (pas de stock).
-- Erreurs : P0002 demande inconnue pour ce contact, CP409 enchère fermée ou déjà répondu, CP410 délai dépassé,
-- 22023 donnée invalide (detail : currency, price, lead, date_code, lot).
create or replace function public.supplier_rfq_answer(p_openid text, p_ref text, p_kind text, p_net numeric default null,
  p_currency text default null, p_lead int default null, p_date_code text default null, p_lot text default null,
  p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_org text; s public.demand_sellers; d public.demands; l public.lots; v_cur text; v_dc text; v_done boolean;
begin
  select org_id into v_org from public.wechat_identities where openid = p_openid and revoked_at is null;
  select * into s from public.demand_sellers where demand_id = upper(p_ref) and seller_id = v_org for update;
  if v_org is null or s.demand_id is null or s.notify_status <> 'sent' then
    raise exception 'Demande inconnue : %', p_ref using errcode = 'P0002';
  end if;
  select * into d from public.demands where id = s.demand_id;
  if s.response_status <> 'pending' then
    raise exception 'Déjà répondu (%)', s.response_status using errcode = 'CP409', detail = s.response_status;
  end if;
  if p_now > s.deadline_at then raise exception 'Délai dépassé' using errcode = 'CP410'; end if;
  if d.status <> 'auction' then raise exception 'Enchère fermée' using errcode = 'CP409', detail = d.status; end if;

  if p_kind = 'decline' then
    update public.demand_sellers set response_status = 'declined', responded_at = p_now, responded_by = p_openid
     where demand_id = s.demand_id and seller_id = s.seller_id;
  elsif p_kind = 'quote' then
    v_cur := app.norm_currency(p_currency);
    if v_cur is null then raise exception 'Devise non acceptée' using errcode = '22023', detail = 'currency'; end if;
    if p_net is null or p_net <= 0 or p_net > 10000000 then raise exception 'Prix invalide' using errcode = '22023', detail = 'price'; end if;
    if p_lead is null or p_lead < 0 or p_lead > 3650 then raise exception 'Délai invalide' using errcode = '22023', detail = 'lead'; end if;
    select * into l from public.lots where id = upper(coalesce(nullif(btrim(p_lot), ''), s.lot_id)) and seller_id = v_org;
    if l.id is null or upper(regexp_replace(l.mpn, '\s+', '', 'g')) <> d.mpn then
      raise exception 'Lot inconnu' using errcode = '22023', detail = 'lot';
    end if;
    v_dc := coalesce(nullif(btrim(p_date_code), ''), nullif(l.date_code, ''));
    if v_dc is null then raise exception 'Date code requis' using errcode = '22023', detail = 'date_code'; end if;
    -- Date code donné à la consultation : reporté sur le lot s'il lui manquait (api/fournisseurs.md).
    if coalesce(l.date_code, '') = '' then update public.lots set date_code = v_dc where id = l.id; end if;
    insert into public.bids (demand_id, seller_id, lot_id, net, currency, net_eur, date_code, lead_days, created_at)
    select s.demand_id, v_org, l.id, p_net, v_cur, round(p_net * c.eur_rate, 6), v_dc, p_lead, p_now
      from public.currencies c where c.code = v_cur;
    update public.demand_sellers set response_status = 'quoted', responded_at = p_now, responded_by = p_openid, lot_id = l.id
     where demand_id = s.demand_id and seller_id = s.seller_id;
  else
    raise exception 'Réponse inconnue' using errcode = '22023', detail = 'kind';
  end if;
  perform app.record_supplier_response(s.demand_id, s.seller_id);
  insert into public.events (at, actor, text, ref)
  values (p_now, 'seller', 'Demande ' || s.demand_id || (case when p_kind = 'quote' then ' : offre reçue' else ' : pas de stock' end), v_org);
  v_done := public.rfq_ready_to_close(s.demand_id, p_now);
  return public.rfq_for_supplier(s.demand_id, v_org) || jsonb_build_object('all_done', v_done);
end $$;

-- Demandes reçues par la société d'un contact (page /depot/, 90 jours) et son propre taux de traitement.
create or replace function public.supplier_rfqs(p_openid text)
returns jsonb language sql stable security definer set search_path = '' as $$
  with o as (select org_id from public.wechat_identities where openid = p_openid and revoked_at is null)
  select jsonb_build_object(
    'demands', coalesce((select jsonb_agg(public.rfq_for_supplier(s.demand_id, s.seller_id) || jsonb_build_object(
                 'my_net', b.net, 'my_currency', b.currency, 'my_lead_days', b.lead_days, 'my_date_code', b.date_code)
                 order by s.notified_at desc)
        from public.demand_sellers s join o on o.org_id = s.seller_id
        left join public.bids b on b.demand_id = s.demand_id and b.seller_id = s.seller_id
       where s.notify_status = 'sent' and s.notified_at > now() - interval '90 days'), '[]'),
    'score', (select public.supplier_score(org_id) - 'org' from o))
$$;

-- ------------------------------------------------------------ clôture et consolidation
-- Prête à clore : chaque fournisseur prévenu a répondu ou expiré, et il ne reste personne à prévenir (sinon, on
-- attend closes_at : un envoi échoué non renvoyé à temps ne bloque pas la demande).
create or replace function public.rfq_ready_to_close(p_id text, p_now timestamptz default now())
returns boolean language sql stable security definer set search_path = '' as $$
  -- Seulement les RFQ des plateformes (client_org_id) : les autres demandes Opportunity gardent leur propre cycle.
  select d.status = 'auction' and d.client_org_id is not null and (
           -- échéance générale passée (elle couvre toutes les échéances des fournisseurs prévenus) ;
           p_now > d.closes_at
           -- ou : au moins un fournisseur prévenu, tous ont répondu ou expiré, personne d'autre à prévenir.
           or (exists (select 1 from public.demand_sellers s where s.demand_id = d.id and s.notify_status = 'sent')
               and not exists (select 1 from public.demand_sellers s where s.demand_id = d.id and s.response_status = 'pending'
                                 and (s.notify_status <> 'sent' or s.deadline_at >= p_now))))
    from public.demands d where d.id = upper(p_id)
$$;

-- Offres tout compris : net du fournisseur converti dans la devise demandée + marge du vendeur (ou de sa catégorie).
-- Un bid sans marge applicable n'est pas consolidé (signalé : no_margin). Classement sur le prix en euros, puis la
-- note (au-delà du seuil seulement), puis le délai. Erreur CP409 si la demande n'est pas prête.
create or replace function public.close_rfq(p_id text, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare d public.demands; v_n int; v_skipped int;
begin
  select * into d from public.demands where id = upper(p_id) for update;
  if d.id is null then raise exception 'Demande inconnue : %', p_id using errcode = 'P0002'; end if;
  if not coalesce(public.rfq_ready_to_close(d.id, p_now), false) then
    raise exception 'Demande % pas prête à clore', d.id using errcode = 'CP409';
  end if;
  -- Les fournisseurs prévenus dont l'échéance est passée sont d'abord comptés « expirés ».
  perform public.expire_overdue_sellers(p_now);
  with q as (
    select b.*, round(b.net * c.eur_rate / t.eur_rate * (1 + app.margin_for(b.seller_id) / 100), 4) as price,
           b.net_eur * (1 + app.margin_for(b.seller_id) / 100) as price_eur, app.score_weight(b.seller_id) as sw
      from public.bids b
      join public.demand_sellers s on s.demand_id = b.demand_id and s.seller_id = b.seller_id
      join public.currencies c on c.code = b.currency
      join public.currencies t on t.code = d.currency
     where b.demand_id = d.id and s.response_status = 'quoted' and b.created_at <= s.deadline_at),
  ins as (
    insert into public.offers (demand_id, bid_id, seller_id, lot_id, net, currency, net_eur, date_code, buyer_currency,
                               unit_price, lead_days, rank, status, valid_until)
    select d.id, q.id, q.seller_id, q.lot_id, q.net, q.currency, q.net_eur, q.date_code, d.currency, q.price, q.lead_days,
           row_number() over (order by q.price_eur, coalesce(q.sw, (select avg(sw) from q), 1) desc, q.lead_days, q.id),
           'open', p_now + make_interval(days => app.rfq_offer_valid_days())
      from q where q.price is not null
    returning 1)
  select (select count(*) from ins), (select count(*) from q where q.price is null) into v_n, v_skipped;
  update public.demands set status = case when v_n > 0 then 'offers' else 'no_offer' end, closed_at = p_now
   where id = d.id returning * into d;
  insert into public.events (at, actor, text, ref) values (p_now, 'system', 'Demande ' || d.id || ' close : ' || v_n || ' offre(s)'
    || case when v_skipped > 0 then ', ' || v_skipped || ' sans marge applicable' else '' end, d.client_org_id);
  perform app.enqueue_client_event(d.id, case when v_n > 0 then 'demand.offers_ready' else 'demand.no_offer' end, p_now);
  return jsonb_build_object('id', d.id, 'status', d.status, 'offers', v_n, 'no_margin', v_skipped);
end $$;

-- Demandes à clore maintenant (tâche planifiée) : complètes, ou échéance générale passée.
create or replace function public.rfq_due_for_close(p_now timestamptz default now())
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(d.id order by d.id), '[]') from public.demands d
   where d.status = 'auction' and d.client_org_id is not null and public.rfq_ready_to_close(d.id, p_now)
$$;

-- ------------------------------------------------------------ webhooks des plateformes
create or replace function public.rfq_webhook_create(p_org text, p_url text, p_events text[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id text; v_bad text[];
begin
  if coalesce(p_url, '') !~ '^https://[^\s/]+' or length(p_url) > 500 then
    raise exception 'URL invalide (https obligatoire)' using errcode = '22023', detail = 'url';
  end if;
  select array_agg(e) into v_bad from unnest(coalesce(p_events, '{}')) e
   where e not in ('demand.validated', 'demand.rejected', 'demand.offers_ready', 'demand.no_offer', 'offer.expired');
  if v_bad is not null or cardinality(coalesce(p_events, '{}')) = 0 then
    raise exception 'Événements invalides : %', coalesce(array_to_string(v_bad, ', '), '(aucun)') using errcode = '22023', detail = 'events';
  end if;
  if (select count(*) from public.webhooks where org_id = p_org and disabled_at is null) >= 10 then
    raise exception 'Dix abonnements au plus' using errcode = '22023', detail = 'url';
  end if;
  insert into public.webhooks (org_id, url, events, signing_secret_ref) values (p_org, p_url, p_events, 'derived:v1')
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'url', p_url, 'events', to_jsonb(p_events));
end $$;

create or replace function public.rfq_webhooks(p_org text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', w.id, 'url', w.url, 'events', to_jsonb(w.events), 'created_at', w.created_at,
    'last_deliveries', (select coalesce(jsonb_agg(jsonb_build_object('event', x.event, 'at', x.created_at,
        'delivered_at', x.delivered_at, 'attempts', x.attempts, 'status', x.last_status, 'failed', x.failed_at is not null)
        order by x.id desc), '[]') from (select * from public.webhook_deliveries dl where dl.webhook_id = w.id
        order by dl.id desc limit 5) x)) order by w.created_at), '[]')
    from public.webhooks w where w.org_id = p_org and w.disabled_at is null
$$;

create or replace function public.rfq_webhook_delete(p_org text, p_id text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.webhooks set disabled_at = now() where id = upper(p_id) and org_id = p_org and disabled_at is null;
  if not found then raise exception 'Abonnement inconnu' using errcode = 'P0002'; end if;
end $$;

-- Livraisons dues (tâche planifiée), au plus p_limit, abandon après 24 h.
create or replace function public.claim_webhook_deliveries(p_now timestamptz default now(), p_limit int default 50)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  update public.webhook_deliveries set failed_at = p_now
   where delivered_at is null and failed_at is null and created_at < p_now - interval '24 hours';
  return coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'webhook_id', x.webhook_id, 'url', w.url,
           'event', x.event, 'payload', x.payload, 'attempts', x.attempts) order by x.id)
    from (select * from public.webhook_deliveries where delivered_at is null and failed_at is null and next_attempt_at <= p_now
           order by id limit p_limit) x join public.webhooks w on w.id = x.webhook_id), '[]');
end $$;

-- Résultat d'une livraison : 2xx → livrée ; sinon nouvelle tentative avec délai croissant (1, 2, 4… min, 2 h au plus).
create or replace function public.record_webhook_delivery(p_id bigint, p_ok boolean, p_status int default null,
  p_now timestamptz default now())
returns void language sql security definer set search_path = '' as $$
  update public.webhook_deliveries set attempts = attempts + 1, last_status = p_status,
         delivered_at = case when p_ok then p_now end,
         next_attempt_at = case when p_ok then next_attempt_at
                                else p_now + least(interval '2 hours', interval '1 minute' * power(2, attempts)) end
   where id = p_id
$$;

-- ------------------------------------------------------------ back office /admin/ (ADR 0018)
-- Mêmes fonctions que le robot ; chaque fonction admin_* vérifie elle-même le rôle (42501).
create or replace function public.admin_rfq_list(p_status text default 'pending_validation')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_admin();
  return coalesce((select jsonb_agg(public.rfq_for_operator(d.id) order by d.created_at desc)
    from (select id, created_at from public.demands where client_org_id is not null
            and (p_status is null or status = p_status) order by created_at desc limit 100) d), '[]');
end $$;

create or replace function public.admin_rfq_approve(p_id text, p_only text[] default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin return public.approve_rfq(p_id, app.require_admin(), p_only); end $$;

create or replace function public.admin_rfq_reject(p_id text, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin return public.reject_rfq(p_id, p_reason, app.require_admin()); end $$;

create or replace function public.admin_supplier_score(p_org text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin perform app.require_admin(); return public.supplier_score(upper(p_org)); end $$;

-- ------------------------------------------------------------ droits
-- Toutes les fonctions : exécution réservée à service_role (fonctions Edge), sauf admin_* (administrateur connecté,
-- contrôle app.require_admin). Rien pour anon.
do $$
declare f text;
begin
  foreach f in array array[
    'public.rfq_auth(text, timestamptz)',
    'public.create_rfq(text, text, text, jsonb, boolean, timestamptz)',
    'public.rfq_batch_for_client(text, text)', 'public.rfq_demand_for_client(text, text)',
    'public.rfq_demands_for_client(text, text, text, timestamptz)', 'public.rfq_offers_for_client(text, text, timestamptz)',
    'public.cancel_rfq(text, text, timestamptz)', 'public.rfq_for_operator(text)', 'public.list_pending_rfq()',
    'public.approve_rfq(text, text, text[], timestamptz, timestamptz)', 'public.reject_rfq(text, text, text, timestamptz)',
    'public.claim_ops_rfq_reminders(timestamptz)', 'public.rfq_for_supplier(text, text)', 'public.rfq_contacts(text, boolean)',
    'public.record_notify_result(text, text, boolean, text, timestamptz)', 'public.resend_rfq(text, text, text, timestamptz)',
    'public.claim_rfq_reminders(timestamptz)', 'public.expire_overdue_sellers(timestamptz)', 'public.supplier_score(text)',
    'public.supplier_rfq_answer(text, text, text, numeric, text, int, text, text, timestamptz)', 'public.supplier_rfqs(text)',
    'public.rfq_ready_to_close(text, timestamptz)', 'public.close_rfq(text, timestamptz)',
    'public.rfq_due_for_close(timestamptz)', 'public.rfq_webhook_create(text, text, text[])', 'public.rfq_webhooks(text)',
    'public.rfq_webhook_delete(text, text)', 'public.claim_webhook_deliveries(timestamptz, int)',
    'public.record_webhook_delivery(bigint, boolean, int, timestamptz)']
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  foreach f in array array['public.admin_rfq_list(text)', 'public.admin_rfq_approve(text, text[])',
    'public.admin_rfq_reject(text, text)', 'public.admin_supplier_score(text)']
  loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;
revoke execute on all functions in schema app from public, anon;
grant execute on all functions in schema app to service_role;
grant usage on sequence app.rfq_seq to service_role;
