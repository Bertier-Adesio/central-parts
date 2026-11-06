-- Recherche payante de composants rares ou introuvables (décision de Bertier, 6 novembre 2026 : « une page de recherches
-- de composants rares ou introuvables sur central.parts, avec un tarif par recherche, une recherche payante pour filtrer
-- les gogos » ; 49 € HT par référence, déduits de la commande ; paiement par GoCardless, pas Stripe ; mise en ligne avant
-- les CGV). ADR 0033.
--
-- Parcours : l'acheteur professionnel décrit sa référence (/sourcing/) et paie les frais :
--   payment_mode « bank »     : virement en ligne depuis sa banque (GoCardless Pay By Bank, pays couverts) ; le webhook
--                               signé de GoCardless (billing_requests fulfilled) fait passer la demande « payée » ;
--   payment_mode « proforma » : autres pays, proforma par e-mail ; l'administrateur marque la demande payée à réception.
-- Les opérateurs sont prévenus dans WeChat ; la demande se traite dans le back office (sources Opportunity : surplus,
-- brokers, réseau) ; l'acheteur la suit par un lien personnel (/sourcing/suivi/). Les frais sont déduits de la commande
-- qui suit ; ils ne sont pas remboursés sinon.
--
-- TVA (à faire valider par le comptable) : acheteur en France, 20 % ; autre pays de l'Union avec numéro de TVA,
-- autoliquidation (0 %) ; hors Union, 0 %. Montants en centimes d'euro. Rejouable.

create sequence if not exists app.sourcing_seq start 1;
create table if not exists public.sourcing_requests (
  id              text primary key default app.ref('SRC', 'app.sourcing_seq'),
  token_hash      text not null unique,                 -- lien de suivi : empreinte SHA-256, jamais le jeton
  status          text not null default 'awaiting_payment'
                  check (status in ('awaiting_payment', 'paid', 'in_progress', 'offers_sent', 'not_found', 'cancelled')),
  mpn             text not null check (btrim(mpn) <> ''),
  manufacturer    text,
  qty             bigint not null check (qty > 0),
  target_price    numeric check (target_price > 0),
  target_currency text not null default 'EUR',
  needed_by       date,
  condition       text not null default 'new' check (condition in ('new', 'any')),
  notes           text,
  company         text not null check (btrim(company) <> ''),
  contact         text not null check (btrim(contact) <> ''),
  email           text not null check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  country         char(2) not null check (country ~ '^[A-Z]{2}$'),
  vat_number      text,
  vat_checked     boolean not null default false,       -- numéro vérifié dans VIES
  lang            text not null default 'fr' check (lang in ('fr', 'en', 'zh')),
  amount_ht       int not null,                         -- centimes
  vat_rate        numeric not null,                     -- 0,20 ou 0
  amount_ttc      int not null,                         -- centimes, payé par carte
  payment_mode    text not null default 'bank' check (payment_mode in ('bank', 'proforma')),
  payment_ref     text unique,                          -- demande de paiement GoCardless (BRQ…)
  paid_at         timestamptz,
  credit_used_by  text,                                 -- demande d'achat (PR-…) sur laquelle les frais ont été déduits
  admin_note      text,                                 -- interne
  buyer_note      text,                                 -- visible par l'acheteur sur sa page de suivi
  updated_by      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
-- Version précédente de cette migration (paiement Stripe) déjà appliquée : colonnes renommées et ajoutées.
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'sourcing_requests' and column_name = 'stripe_session') then
    alter table public.sourcing_requests rename column stripe_session to payment_ref;
  end if;
end $$;
alter table public.sourcing_requests add column if not exists payment_mode text not null default 'bank' check (payment_mode in ('bank', 'proforma'));
drop function if exists public.sourcing_set_session(text, text);
create index if not exists sourcing_requests_status_idx on public.sourcing_requests (status, created_at desc);
alter table public.sourcing_requests enable row level security;
revoke all on public.sourcing_requests from anon, authenticated;
grant usage on sequence app.sourcing_seq to service_role;

-- Tarif : app.settings « sourcing_fee_ht » (centimes), 4 900 par défaut.
create or replace function app.sourcing_fee_ht() returns int
language sql stable security definer set search_path = '' as $$
  select coalesce((select value::int from app.settings where name = 'sourcing_fee_ht'), 4900)
$$;

-- Pays de l'Union européenne (autoliquidation de la TVA entre professionnels, hors France).
create or replace function app.is_eu(p_country text) returns boolean
language sql immutable set search_path = '' as $$
  select upper(coalesce(p_country, '')) = any (array['AT','BE','BG','CY','CZ','DE','DK','EE','ES','FI','FR','GR','HR','HU','IE',
    'IT','LT','LU','LV','MT','NL','PL','PT','RO','SE','SI','SK'])
$$;

-- Crée la demande (en attente de paiement) et renvoie son identifiant, le jeton du lien de suivi (une seule fois) et
-- les montants. Erreur 22023 si un champ manque ; numéro de TVA obligatoire dans l'Union.
create or replace function public.create_sourcing_request(p_ip text, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_token text := encode(extensions.gen_random_bytes(24), 'hex'); v_country text := upper(btrim(coalesce(p->>'country', '')));
  v_vat text := nullif(upper(regexp_replace(coalesce(p->>'vat', ''), '[\s.-]', '', 'g')), ''); v_rate numeric; v_ht int := app.sourcing_fee_ht();
  r public.sourcing_requests;
begin
  perform app.count_search(p_ip);
  if app.is_eu(v_country) and v_vat is null then raise exception 'Numéro de TVA obligatoire dans l''Union européenne' using errcode = '22023'; end if;
  v_rate := case when v_country = 'FR' then 0.20 else 0 end;
  begin
    insert into public.sourcing_requests (token_hash, mpn, manufacturer, qty, target_price, target_currency, needed_by, condition, notes,
      company, contact, email, country, vat_number, vat_checked, lang, payment_mode, amount_ht, vat_rate, amount_ttc)
    values (encode(extensions.digest(v_token, 'sha256'), 'hex'), upper(btrim(coalesce(p->>'mpn', ''))), nullif(btrim(p->>'manufacturer'), ''),
      (p->>'qty')::bigint, nullif(p->>'target_price', '')::numeric, coalesce(nullif(upper(p->>'target_currency'), ''), 'EUR'),
      nullif(p->>'needed_by', '')::date, coalesce(nullif(p->>'condition', ''), 'new'), nullif(left(btrim(coalesce(p->>'notes', '')), 2000), ''),
      left(btrim(coalesce(p->>'company', '')), 200), left(btrim(coalesce(p->>'contact', '')), 200), lower(btrim(coalesce(p->>'email', ''))),
      v_country, v_vat, coalesce((p->>'vat_checked')::boolean, false), coalesce(nullif(p->>'lang', ''), 'fr'),
      coalesce(nullif(p->>'payment_mode', ''), 'bank'), v_ht, v_rate, round(v_ht * (1 + v_rate))::int)
    returning * into r;
  exception when check_violation or invalid_text_representation or not_null_violation or invalid_datetime_format or datetime_field_overflow then
    raise exception 'Demande incomplète ou invalide : %', sqlerrm using errcode = '22023';
  end;
  if r.payment_mode = 'proforma' then
    insert into public.events (actor, text, ref) values ('buyer', 'Recherche de sourcing demandée, proforma à envoyer : ' || r.mpn || ' × ' || r.qty, r.id);
  end if;
  return jsonb_build_object('id', r.id, 'token', v_token, 'mpn', r.mpn, 'amount_ht', r.amount_ht, 'vat_rate', r.vat_rate, 'amount_ttc', r.amount_ttc,
    'payment_mode', r.payment_mode, 'company', r.company, 'country', r.country, 'qty', r.qty, 'manufacturer', r.manufacturer);
end $$;

create or replace function public.sourcing_set_payment_ref(p_id text, p_ref text) returns void
language sql security definer set search_path = '' as $$
  update public.sourcing_requests set payment_ref = p_ref, updated_at = now() where id = p_id and status = 'awaiting_payment'
$$;

-- Paiement confirmé par GoCardless (webhook signé, vérifié par la fonction Edge) : une seule fois ; montant contrôlé
-- quand l'événement le donne. Renvoie la demande pour l'avis aux opérateurs, ou null si déjà payée ou inconnue.
drop function if exists public.sourcing_mark_paid(text, int);
create or replace function public.sourcing_mark_paid(p_ref text, p_amount int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.sourcing_requests;
begin
  update public.sourcing_requests set status = 'paid', paid_at = now(), updated_at = now()
   where payment_ref = p_ref and status = 'awaiting_payment' and (p_amount is null or amount_ttc = p_amount)
  returning * into r;
  if r.id is null then return null; end if;
  insert into public.events (actor, text, ref) values ('buyer', 'Recherche de sourcing payée : ' || r.mpn || ' × ' || r.qty, r.id);
  return jsonb_build_object('id', r.id, 'mpn', r.mpn, 'manufacturer', r.manufacturer, 'qty', r.qty, 'company', r.company,
    'country', r.country, 'needed_by', r.needed_by, 'target_price', r.target_price, 'target_currency', r.target_currency);
end $$;

-- Page de suivi de l'acheteur (jeton du lien) : état, sa demande, la note qui lui est destinée ; jamais la note interne.
create or replace function public.sourcing_status(p_token text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', r.id, 'status', r.status, 'mpn', r.mpn, 'manufacturer', r.manufacturer, 'qty', r.qty,
    'target_price', r.target_price, 'target_currency', r.target_currency, 'needed_by', r.needed_by, 'condition', r.condition,
    'company', r.company, 'amount_ht', r.amount_ht, 'amount_ttc', r.amount_ttc, 'vat_rate', r.vat_rate, 'paid_at', r.paid_at,
    'payment_mode', r.payment_mode,
    'buyer_note', r.buyer_note, 'credit_used', r.credit_used_by is not null, 'created_at', r.created_at, 'updated_at', r.updated_at)
    from public.sourcing_requests r where r.token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
$$;

-- ------------------------------------------------------------ back office
create or replace function public.admin_sourcing_list(p_status text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_admin();
  return jsonb_build_object(
    'counts', (select coalesce(jsonb_object_agg(status, n), '{}') from (select status, count(*) n from public.sourcing_requests group by 1) c),
    -- « open » : à traiter (payées, et proformas en attente de virement) ; vide : toutes sauf paiements en ligne abandonnés.
    'rows', coalesce((select jsonb_agg(to_jsonb(r) - 'token_hash' order by r.created_at desc)
      from (select * from public.sourcing_requests r
             where case coalesce(p_status, '')
                     when '' then r.status <> 'awaiting_payment' or r.payment_mode = 'proforma'
                     when 'open' then r.status = 'paid' or (r.status = 'awaiting_payment' and r.payment_mode = 'proforma')
                     else r.status = p_status end
            order by r.created_at desc limit 100) r), '[]'));
end $$;

-- Avance une demande payée : en cours, offres envoyées, introuvable ou annulée ; notes interne et acheteur ; demande
-- d'achat sur laquelle les frais ont été déduits.
create or replace function public.admin_sourcing_update(p_id text, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_by text := app.require_admin(); r public.sourcing_requests;
begin
  select * into r from public.sourcing_requests where id = upper(btrim(coalesce(p_id, '')));
  if r.id is null then raise exception 'Demande inconnue : %', p_id using errcode = 'P0002'; end if;
  -- Non payée : seulement « payée » (virement reçu sur proforma) ou « annulée ».
  if r.status = 'awaiting_payment' and coalesce(p->>'status', '') not in ('paid', 'cancelled') then
    raise exception 'Demande non payée' using errcode = '22023';
  end if;
  if p ? 'status' and coalesce(p->>'status', '') not in ('paid', 'in_progress', 'offers_sent', 'not_found', 'cancelled') then
    raise exception 'État inconnu' using errcode = '22023';
  end if;
  update public.sourcing_requests set
    status = coalesce(nullif(p->>'status', ''), status),
    paid_at = case when status = 'awaiting_payment' and p->>'status' = 'paid' then now() else paid_at end,
    admin_note = case when p ? 'admin_note' then nullif(left(btrim(coalesce(p->>'admin_note', '')), 4000), '') else admin_note end,
    buyer_note = case when p ? 'buyer_note' then nullif(left(btrim(coalesce(p->>'buyer_note', '')), 2000), '') else buyer_note end,
    credit_used_by = case when p ? 'credit_used_by' then nullif(upper(btrim(coalesce(p->>'credit_used_by', ''))), '') else credit_used_by end,
    updated_by = v_by, updated_at = now()
   where id = r.id returning * into r;
  insert into public.events (actor, text, ref) values ('ops', 'Recherche de sourcing : ' || r.status || ', par ' || v_by, r.id);
  return to_jsonb(r) - 'token_hash';
end $$;

-- ------------------------------------------------------------ droits
revoke execute on function app.sourcing_fee_ht(), app.is_eu(text) from public, anon, authenticated;
revoke execute on function public.create_sourcing_request(text, jsonb), public.sourcing_set_payment_ref(text, text),
  public.sourcing_mark_paid(text, int), public.sourcing_status(text) from public, anon, authenticated;
grant execute on function public.create_sourcing_request(text, jsonb), public.sourcing_set_payment_ref(text, text),
  public.sourcing_mark_paid(text, int), public.sourcing_status(text) to service_role;
revoke execute on function public.admin_sourcing_list(text), public.admin_sourcing_update(text, jsonb) from public, anon;
grant execute on function public.admin_sourcing_list(text), public.admin_sourcing_update(text, jsonb) to authenticated, service_role;
