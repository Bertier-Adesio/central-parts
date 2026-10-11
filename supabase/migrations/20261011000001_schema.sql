-- Central.Parts : schéma initial (v0), tiré de la maquette vivante (site/app/js/core.js et api.js).
-- Voir docs/decisions/0007-hebergement-stockage.md.
--
-- Principes :
--   * Une seule base PostgreSQL. Les écritures passent par l'API métier (rôle service_role) ;
--     aucune politique d'écriture n'est donnée aux utilisateurs connectés. La RLS est la seconde ceinture.
--   * Anonymat : un acheteur ne voit jamais l'identité du vendeur, ni son prix net ; un vendeur ne voit
--     jamais l'identité de l'acheteur. Les lectures croisées passent par des vues qui ne gardent que les alias.
--   * Aucun secret en base : clés d'API stockées en empreinte (hash), secrets de connecteurs, de webhooks
--     et de robots WeCom référencés dans un coffre (colonne *_ref).
--   * Montants en numeric ; devise ISO 4217 parmi la liste validée.
--   * Journaux (mouvements du compte dédié, historique des transactions, événements) en ajout seul.

create extension if not exists pgcrypto;

-- Schéma interne, non exposé par l'API REST de Supabase.
create schema if not exists app;
revoke all on schema app from public, anon;
grant usage on schema app to authenticated, service_role;

-- ------------------------------------------------------------ références
-- Références lisibles (TX-0041, DEM-0427…), comme dans la maquette : elles figurent sur les virements.
create or replace function app.ref(prefix text, seq regclass, width int default 4)
returns text language sql volatile security definer set search_path = '' as $$
  select prefix || '-' || lpad(nextval(seq)::text, width, '0')
$$;

create sequence app.org_seq start 100;
create sequence app.sub_seq;
create sequence app.lot_seq start 200;
create sequence app.con_seq start 10;
create sequence app.ch_seq start 10;
create sequence app.whk_seq;
create sequence app.key_seq;
create sequence app.bom_seq start 100;
create sequence app.inv_seq start 100;
create sequence app.dem_seq start 1000;
create sequence app.bid_seq start 2000;
create sequence app.off_seq start 3000;
create sequence app.tx_seq start 100;
create sequence app.lab_seq start 100;
create sequence app.dsp_seq start 10;
create sequence app.ord_seq start 100;

-- ------------------------------------------------------------ paramètres
-- Devises acceptées : Central.Parts a un compte dans chacune (liste validée).
create table public.currencies (
  code          char(3) primary key check (code ~ '^[A-Z]{3}$'),
  name          text not null,
  eur_rate      numeric(18,8) not null check (eur_rate > 0), -- euros pour une unité, fourni par la banque
  rate_at       timestamptz not null default now(),
  account_label text not null                                -- libellé masqué du compte, jamais l'IBAN complet
);

create table public.lab_levels (
  id     smallint primary key,
  name   text not null,
  price  numeric(12,2) not null check (price >= 0),
  currency char(3) not null default 'EUR' references public.currencies,
  days   smallint not null check (days >= 0),
  tests  text[] not null default '{}'
);

-- ------------------------------------------------------------ organisations et utilisateurs
create table public.organizations (
  id          text primary key default app.ref('ORG', 'app.org_seq'),
  type        text not null check (type in ('buyer', 'seller', 'lab', 'bank', 'ops')),
  name        text not null,
  alias       text not null unique,          -- seule identité visible de l'autre partie
  city        text,
  country     text,
  currency    char(3) references public.currencies,
  lang        text not null default 'fr' check (lang in ('fr', 'en', 'zh')),
  profile     text,                          -- Surplus EMS, Broker, Surplus OEM…
  registration_number text,                  -- SIREN, numéro d'immatriculation local
  kyb         text not null default 'none' check (kyb in ('none', 'pending', 'validated', 'rejected')),
  kyb_provider_ref text,                     -- dossier chez le prestataire KYC, les pièces restent chez lui
  kyb_decided_at timestamptz,
  sandbox     boolean not null default false,
  created_at  timestamptz not null default now(),
  check (type not in ('buyer', 'seller') or currency is not null)
);

-- Coordonnées bancaires à part : lues par l'organisation elle-même et par les opérateurs seulement.
create table public.org_bank_accounts (
  org_id     text primary key references public.organizations on delete cascade,
  iban       text not null,
  bic        text,
  holder     text not null,
  verified_at timestamptz
);

-- Un utilisateur Supabase Auth appartient à une organisation.
create table public.members (
  user_id    uuid primary key references auth.users on delete cascade,
  org_id     text not null references public.organizations on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);
create index on public.members (org_id);

-- Abonnement vendeur. Statut « vérifié » = KYB validé et abonnement en cours.
create table public.subscriptions (
  id         text primary key default app.ref('SUB', 'app.sub_seq'),
  org_id     text not null references public.organizations on delete cascade,
  plan       text not null,
  starts_on  date not null default current_date,
  until      date not null,
  created_at timestamptz not null default now(),
  check (until >= starts_on)
);
create index on public.subscriptions (org_id, until desc);

-- ------------------------------------------------------------ fonctions d'accès (RLS)
create or replace function app.my_org() returns text
language sql stable security definer set search_path = '' as $$
  select org_id from public.members where user_id = auth.uid()
$$;

create or replace function app.my_type() returns text
language sql stable security definer set search_path = '' as $$
  select o.type from public.members m join public.organizations o on o.id = m.org_id where m.user_id = auth.uid()
$$;

create or replace function app.is_ops() returns boolean
language sql stable set search_path = '' as $$
  select coalesce(app.my_type() = 'ops', false)
$$;

create or replace function app.is_verified(p_org text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.organizations o
    where o.id = p_org and o.kyb = 'validated'
      and (o.sandbox or exists (select 1 from public.subscriptions s where s.org_id = o.id and current_date between s.starts_on and s.until))
  )
$$;

-- ------------------------------------------------------------ offre Inventory (agrégée)
create table public.inventory_offers (
  id          bigint generated always as identity primary key,
  mpn         text not null,
  manufacturer text not null,
  source      text not null,                 -- « Distributeur agréé », « Fabricant, Chine »…
  supplier_id text references public.organizations,
  stock       integer not null check (stock >= 0),
  lead_days   smallint not null check (lead_days >= 0),
  unit_price  numeric(18,6) not null check (unit_price >= 0),
  currency    char(3) not null references public.currencies,
  updated_at  timestamptz not null default now()
);
create index on public.inventory_offers (upper(mpn));

-- ------------------------------------------------------------ connecteurs, canaux, clés
-- Connecteur vers l'API produit d'un broker (ADR 0006). Le secret d'accès vit dans le coffre.
create table public.connectors (
  id          text primary key default app.ref('CON', 'app.con_seq'),
  org_id      text not null references public.organizations on delete cascade,
  name        text not null,
  base_url    text not null check (base_url ~ '^https://'),
  search_path text not null check (search_path like '%{mpn}%'),
  auth_type   text not null check (auth_type in ('none', 'api_key', 'bearer', 'basic', 'oauth2')),
  secret_ref  text,
  field_map   jsonb not null default '{}',   -- correspondance des champs du broker vers le format pivot
  status      text not null default 'pending' check (status in ('pending', 'ok', 'down', 'disabled')),
  latency_ms  integer,
  last_call_at timestamptz,
  created_at  timestamptz not null default now()
);
create index on public.connectors (org_id);

create table public.connector_calls (
  id          bigint generated always as identity primary key,
  connector_id text not null references public.connectors on delete cascade,
  demand_id   text,
  mpn         text not null,
  at          timestamptz not null default now(),
  http_status smallint,
  latency_ms  integer,
  results     integer not null default 0,
  error       text
);
create index on public.connector_calls (connector_id, at desc);

-- Canaux de notification (ADR 0005). L'URL d'un robot WeCom contient une clé : elle va au coffre.
create table public.channels (
  id         text primary key default app.ref('CH', 'app.ch_seq'),
  org_id     text not null references public.organizations on delete cascade,
  type       text not null check (type in ('email', 'wecom', 'wechat_oa')),
  target     text,                           -- adresse e-mail ou openid WeChat
  secret_ref text,                           -- URL du robot WeCom
  lang       text not null default 'fr' check (lang in ('fr', 'en', 'zh')),
  events     text[] not null default '{demand.created}',
  status     text not null default 'pending' check (status in ('pending', 'active', 'disabled')),
  label      text,
  created_at timestamptz not null default now()
);
create index on public.channels (org_id);

create table public.webhooks (
  id         text primary key default app.ref('WHK', 'app.whk_seq'),
  org_id     text not null references public.organizations on delete cascade,
  url        text not null check (url ~ '^https://'),
  events     text[] not null,
  signing_secret_ref text not null,
  created_at timestamptz not null default now(),
  disabled_at timestamptz
);

-- Clés d'API fournisseur : seule l'empreinte est gardée, le secret est affiché une fois.
create table public.api_keys (
  id          text primary key default app.ref('KEY', 'app.key_seq'),
  org_id      text not null references public.organizations on delete cascade,
  environment text not null check (environment in ('sandbox', 'live')),
  prefix      text not null,
  key_hash    text not null unique,
  label       text,
  created_at  timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at  timestamptz
);

-- ------------------------------------------------------------ lots (Opportunity)
create table public.lots (
  id           text primary key default app.ref('LOT', 'app.lot_seq'),
  seller_id    text not null references public.organizations,
  source       text not null default 'manual' check (source in ('manual', 'api', 'file', 'sftp', 'pull')),
  connector_id text references public.connectors on delete set null,
  sku          text,
  product_url  text,
  mpn          text not null,
  manufacturer text not null default '',
  qty          integer not null check (qty >= 0),
  date_code    text not null default '',     -- facultatif, peut être donné à la consultation
  pack         text,
  unit_price   numeric(18,6) check (unit_price >= 0),
  currency     char(3) not null references public.currencies,
  country_of_origin text,
  lead_days    smallint,
  questionnaire jsonb not null default '{}', -- 13 réponses fermées, voir CP.QUESTIONS
  docs         jsonb not null default '{}',  -- pièces déposées (photos, CoC, preuve d'achat…)
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (seller_id, sku)
);
create index on public.lots (upper(mpn));

create table public.lot_price_breaks (
  lot_id     text not null references public.lots on delete cascade,
  min_qty    integer not null check (min_qty > 0),
  unit_price numeric(18,6) not null check (unit_price >= 0),
  primary key (lot_id, min_qty)
);

-- ------------------------------------------------------------ nomenclatures et commandes Inventory
create table public.boms (
  id         text primary key default app.ref('BOM', 'app.bom_seq'),
  buyer_id   text not null references public.organizations,
  name       text not null,
  created_at timestamptz not null default now()
);

create table public.inventory_orders (
  id         text primary key default app.ref('INV', 'app.inv_seq'),
  buyer_id   text not null references public.organizations,
  bom_id     text references public.boms,
  currency   char(3) not null references public.currencies,
  status     text not null default 'pending',
  created_at timestamptz not null default now()
);

create table public.inventory_order_lines (
  order_id   text not null references public.inventory_orders on delete cascade,
  line_no    smallint not null,
  mpn        text not null,
  qty        integer not null check (qty > 0),
  unit_price numeric(18,6) not null,
  source     text not null,
  primary key (order_id, line_no)
);

-- ------------------------------------------------------------ demandes, enchères, offres
create table public.demands (
  id          text primary key default app.ref('DEM', 'app.dem_seq'),
  buyer_id    text not null references public.organizations,
  bom_id      text references public.boms,
  mpn         text not null,
  manufacturer text,
  qty         integer not null check (qty > 0),
  dc_min      text,
  pack        text,
  zone        text,                          -- zone de livraison, seule visible du vendeur
  delivery    text,                          -- adresse détaillée, jamais montrée au vendeur
  lead_days   smallint,
  target_price numeric(18,6),
  currency    char(3) not null references public.currencies,
  status      text not null default 'auction' check (status in ('auction', 'offers', 'no_offer', 'ordered', 'cancelled')),
  closes_at   timestamptz not null,
  closed_at   timestamptz,
  created_at  timestamptz not null default now()
);
create index on public.demands (buyer_id);

create table public.bom_lines (
  bom_id    text not null references public.boms on delete cascade,
  line_no   smallint not null,
  mpn       text not null,
  qty       integer not null check (qty > 0),
  offer     text not null check (offer in ('inventory', 'opportunity')),
  demand_id text references public.demands,
  primary key (bom_id, line_no)
);

-- Vendeurs consultés pour une demande, et par quel moyen.
create table public.demand_sellers (
  demand_id text not null references public.demands on delete cascade,
  seller_id text not null references public.organizations,
  via       text not null default 'catalog' check (via in ('catalog', 'connector')),
  notified_at timestamptz not null default now(),
  primary key (demand_id, seller_id)
);
create index on public.demand_sellers (seller_id);

create table public.bids (
  id         text primary key default app.ref('BID', 'app.bid_seq'),
  demand_id  text not null references public.demands on delete cascade,
  seller_id  text not null references public.organizations,
  lot_id     text not null references public.lots,
  net        numeric(18,6) not null check (net > 0),  -- prix net vendeur, dans sa devise
  currency   char(3) not null references public.currencies,
  net_eur    numeric(18,6) not null,                  -- pour le classement
  date_code  text,
  lead_days  smallint not null,
  created_at timestamptz not null default now(),
  unique (demand_id, seller_id)
);

create table public.offers (
  id          text primary key default app.ref('OFF', 'app.off_seq'),
  demand_id   text not null references public.demands on delete cascade,
  bid_id      text not null references public.bids,
  seller_id   text not null references public.organizations,
  lot_id      text not null references public.lots,
  net         numeric(18,6) not null,
  currency    char(3) not null references public.currencies,
  net_eur     numeric(18,6) not null,
  date_code   text,
  buyer_currency char(3) not null references public.currencies,
  unit_price  numeric(18,6) not null,                 -- prix acheteur, dans sa devise
  lead_days   smallint not null,
  rank        smallint not null,
  status      text not null default 'open' check (status in ('open', 'accepted', 'declined', 'expired')),
  valid_until timestamptz not null
);
create index on public.offers (demand_id);

-- ------------------------------------------------------------ transactions
create table public.transactions (
  id          text primary key default app.ref('TX', 'app.tx_seq'),
  demand_id   text references public.demands,
  offer_id    text references public.offers,
  buyer_id    text not null references public.organizations,
  seller_id   text not null references public.organizations,
  lot_id      text not null references public.lots,
  lot_snapshot jsonb not null,               -- lot figé à l'acceptation : preuve
  mpn         text not null,
  manufacturer text,
  qty         integer not null check (qty > 0),
  net         numeric(18,6) not null,
  net_currency char(3) not null references public.currencies,
  net_eur     numeric(18,6) not null,
  currency    char(3) not null references public.currencies, -- devise de l'acheteur
  unit_price  numeric(18,6) not null,
  lab_level   smallint not null default 0 references public.lab_levels,
  lab_id      text references public.organizations,
  lab_fee     numeric(12,2) not null default 0,
  total       numeric(18,2) not null,
  delivery    text,
  incoterm    text,
  inspection_days smallint not null default 10,
  counter_days    smallint not null default 10,
  status      text not null default 'to_sign_buyer' check (status in (
                'to_sign_buyer', 'to_sign_seller', 'awaiting_funds', 'to_ship', 'to_lab', 'at_lab',
                'lab_passed', 'lab_failed', 'to_buyer', 'inspection', 'return_due', 'counter_inspection',
                'dispute', 'settling', 'released', 'refunded', 'closed_partial', 'cancelled')),
  signed_buyer_at  timestamptz,
  signed_seller_at timestamptz,
  due_kind    text,
  due_at      timestamptz,
  rejected_qty integer,
  tracking    text,
  created_at  timestamptz not null default now(),
  check (buyer_id <> seller_id)
);
create index on public.transactions (buyer_id);
create index on public.transactions (seller_id);
create index on public.transactions (status, due_at);

-- Partie à une transaction (acheteur ou vendeur). Security definer : la table transactions
-- n'est lisible directement que par les opérateurs.
create or replace function app.is_party(p_tx text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.transactions t where t.id = p_tx and app.my_org() in (t.buyer_id, t.seller_id))
$$;

create table public.transaction_history (
  id     bigint generated always as identity primary key,
  tx_id  text not null references public.transactions on delete cascade,
  at     timestamptz not null default now(),
  text   text not null
);
create index on public.transaction_history (tx_id, at);

create table public.lab_cases (
  id          text primary key default app.ref('LAB', 'app.lab_seq'),
  tx_id       text not null references public.transactions on delete cascade,
  lab_id      text not null references public.organizations,
  level       smallint not null references public.lab_levels,
  status      text not null default 'awaiting' check (status in ('awaiting', 'in_transit', 'received', 'certified', 'reshipped')),
  received_qty integer,
  reception_note text,
  results     jsonb not null default '{}',
  verdict     text check (verdict in ('pass', 'fail')),
  certificate text,
  created_at  timestamptz not null default now()
);

create table public.disputes (
  id          text primary key default app.ref('DSP', 'app.dsp_seq'),
  tx_id       text not null references public.transactions on delete cascade,
  opened_by   text not null check (opened_by in ('buyer', 'seller', 'ops')),
  reason      text not null default '',
  from_status text not null,
  status      text not null default 'open' check (status in ('open', 'closed')),
  winner      text check (winner in ('buyer', 'seller', 'split')),
  basis       text,
  created_at  timestamptz not null default now(),
  closed_at   timestamptz
);

-- ------------------------------------------------------------ compte dédié et ordres de paiement
-- Les fonds sont à la banque ; ces tables sont le registre de Central.Parts, rapproché des relevés.
create table public.payment_orders (
  id          text primary key default app.ref('ORD', 'app.ord_seq'),
  type        text not null check (type in ('release', 'refund')),
  tx_id       text not null references public.transactions,
  currency    char(3) not null references public.currencies,
  amount      numeric(18,2) not null,
  status      text not null default 'pending' check (status in ('pending', 'approved', 'transmitted', 'executed', 'rejected')),
  created_at  timestamptz not null default now(),
  transmitted_at timestamptz,
  executed_at timestamptz
);

create table public.payment_order_lines (
  order_id    text not null references public.payment_orders on delete cascade,
  line_no     smallint not null,
  beneficiary_id text not null references public.organizations,
  label       text not null,
  amount      numeric(18,2) not null,         -- dans la devise de l'ordre
  paid_currency char(3) references public.currencies, -- devise de versement, si différente
  paid_amount numeric(18,2),
  primary key (order_id, line_no)
);

-- Double validation : deux opérateurs distincts.
create table public.payment_approvals (
  order_id    text not null references public.payment_orders on delete cascade,
  user_id     uuid not null references auth.users,
  approved_at timestamptz not null default now(),
  primary key (order_id, user_id)
);

create table public.escrow_movements (
  id        bigint generated always as identity primary key,
  at        timestamptz not null default now(),
  label     text not null,
  amount    numeric(18,2) not null,           -- positif : entrée ; négatif : sortie
  currency  char(3) not null references public.currencies,
  tx_id     text references public.transactions,
  order_id  text references public.payment_orders,
  fx        boolean not null default false,   -- conversion entre comptes Central.Parts
  bank_ref  text
);
create index on public.escrow_movements (currency, at);

create view public.escrow_balances with (security_invoker = true) as
  select currency, sum(amount)::numeric(18,2) as balance, count(*) as movements
  from public.escrow_movements group by currency;

-- ------------------------------------------------------------ notifications et journal
create table public.notifications (
  id         bigint generated always as identity primary key,
  org_id     text not null references public.organizations on delete cascade,
  text       text not null,
  link       text,
  created_at timestamptz not null default now(),
  read_at    timestamptz
);
create index on public.notifications (org_id, created_at desc);

create table public.events (
  id     bigint generated always as identity primary key,
  at     timestamptz not null default now(),
  actor  text,
  text   text not null,
  ref    text
);

-- ------------------------------------------------------------ règles d'intégrité
-- Journaux en ajout seul, même pour l'API : une correction est un nouveau mouvement.
create or replace function app.append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'Table % en ajout seul', tg_table_name;
end $$;

create trigger escrow_movements_append_only before update or delete on public.escrow_movements
  for each row execute function app.append_only();
create trigger transaction_history_append_only before update or delete on public.transaction_history
  for each row execute function app.append_only();
create trigger events_append_only before update or delete on public.events
  for each row execute function app.append_only();

-- Un ordre ne passe « approved » qu'avec deux validations distinctes, données par des opérateurs.
create or replace function app.check_order_approval() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status = 'approved' and old.status = 'pending'
     and (select count(*) from public.payment_approvals a
          join public.members m on m.user_id = a.user_id
          join public.organizations o on o.id = m.org_id and o.type = 'ops'
          where a.order_id = new.id) < 2 then
    raise exception 'Ordre % : deux validations d''opérateurs distincts requises', new.id;
  end if;
  return new;
end $$;

create trigger payment_orders_double_approval before update of status on public.payment_orders
  for each row execute function app.check_order_approval();

create or replace function app.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;

create trigger lots_touch before update on public.lots
  for each row execute function app.touch_updated_at();

-- ------------------------------------------------------------ sécurité au niveau des lignes
-- Lecture seule pour les utilisateurs connectés ; rien pour anon. Les écritures passent par l'API métier.
do $$
declare t text;
begin
  foreach t in array array[
    'currencies', 'lab_levels', 'organizations', 'org_bank_accounts', 'members', 'subscriptions',
    'inventory_offers', 'connectors', 'connector_calls', 'channels', 'webhooks', 'api_keys',
    'lots', 'lot_price_breaks', 'boms', 'bom_lines', 'inventory_orders', 'inventory_order_lines',
    'demands', 'demand_sellers', 'bids', 'offers', 'transactions', 'transaction_history',
    'lab_cases', 'disputes', 'payment_orders', 'payment_order_lines', 'payment_approvals',
    'escrow_movements', 'notifications', 'events']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete, truncate on public.%I from authenticated', t);
  end loop;
end $$;

revoke all on public.escrow_balances from anon;
alter default privileges in schema public revoke all on tables from anon;

-- Référentiels lisibles par tout utilisateur connecté.
create policy read_all on public.currencies for select to authenticated using (true);
create policy read_all on public.lab_levels for select to authenticated using (true);
create policy read_all on public.inventory_offers for select to authenticated using (true);

-- Sa propre organisation (les opérateurs voient tout).
create policy own_or_ops on public.organizations for select to authenticated using (id = app.my_org() or app.is_ops());
create policy own_or_ops on public.org_bank_accounts for select to authenticated using (org_id = app.my_org() or app.is_ops());
create policy own on public.members for select to authenticated using (user_id = auth.uid() or app.is_ops());
create policy own_or_ops on public.subscriptions for select to authenticated using (org_id = app.my_org() or app.is_ops());
create policy own_or_ops on public.connectors for select to authenticated using (org_id = app.my_org() or app.is_ops());
create policy own_or_ops on public.connector_calls for select to authenticated
  using (app.is_ops() or exists (select 1 from public.connectors c where c.id = connector_id and c.org_id = app.my_org()));
create policy own_or_ops on public.channels for select to authenticated using (org_id = app.my_org() or app.is_ops());
create policy own_or_ops on public.webhooks for select to authenticated using (org_id = app.my_org() or app.is_ops());
create policy own_or_ops on public.api_keys for select to authenticated using (org_id = app.my_org() or app.is_ops());
create policy own on public.notifications for select to authenticated using (org_id = app.my_org());

-- Vendeur : ses lots, ses enchères, ses consultations, ses offres.
create policy seller_or_ops on public.lots for select to authenticated using (seller_id = app.my_org() or app.is_ops());
create policy seller_or_ops on public.lot_price_breaks for select to authenticated
  using (app.is_ops() or exists (select 1 from public.lots l where l.id = lot_id and l.seller_id = app.my_org()));
create policy seller_or_ops on public.bids for select to authenticated using (seller_id = app.my_org() or app.is_ops());
create policy seller_or_ops on public.demand_sellers for select to authenticated using (seller_id = app.my_org() or app.is_ops());
create policy seller_or_ops on public.offers for select to authenticated using (seller_id = app.my_org() or app.is_ops());

-- Acheteur : ses nomenclatures, ses commandes Inventory, ses demandes.
create policy buyer_or_ops on public.boms for select to authenticated using (buyer_id = app.my_org() or app.is_ops());
create policy buyer_or_ops on public.bom_lines for select to authenticated
  using (app.is_ops() or exists (select 1 from public.boms b where b.id = bom_id and b.buyer_id = app.my_org()));
create policy buyer_or_ops on public.inventory_orders for select to authenticated using (buyer_id = app.my_org() or app.is_ops());
create policy buyer_or_ops on public.inventory_order_lines for select to authenticated
  using (app.is_ops() or exists (select 1 from public.inventory_orders o where o.id = order_id and o.buyer_id = app.my_org()));
create policy buyer_or_ops on public.demands for select to authenticated using (buyer_id = app.my_org() or app.is_ops());

-- Transactions : tables brutes réservées aux opérateurs ; les parties lisent v_my_transactions (colonnes masquées).
create policy ops on public.transactions for select to authenticated using (app.is_ops());
create policy parties_or_ops on public.transaction_history for select to authenticated
  using (app.is_ops() or app.is_party(tx_id));
create policy parties_lab_or_ops on public.lab_cases for select to authenticated
  using (app.is_ops() or lab_id = app.my_org()
         or app.is_party(tx_id));
create policy parties_or_ops on public.disputes for select to authenticated
  using (app.is_ops() or app.is_party(tx_id));

-- Argent : opérateurs et banque.
create policy ops_bank on public.payment_orders for select to authenticated using (app.is_ops() or app.my_type() = 'bank');
create policy ops_bank on public.payment_order_lines for select to authenticated using (app.is_ops() or app.my_type() = 'bank');
create policy ops_bank on public.payment_approvals for select to authenticated using (app.is_ops() or app.my_type() = 'bank');
create policy ops_bank on public.escrow_movements for select to authenticated using (app.is_ops() or app.my_type() = 'bank');
create policy ops on public.events for select to authenticated using (app.is_ops());

-- ------------------------------------------------------------ vues anonymisées (lectures croisées)
-- Ces vues s'exécutent avec les droits de leur propriétaire (security_invoker = false) pour franchir
-- la RLS, et filtrent elles-mêmes sur l'organisation de l'utilisateur. Elles ne gardent que les alias.

-- Demandes reçues par un vendeur : ni acheteur, ni adresse, ni prix cible.
create view public.v_seller_demands with (security_invoker = false) as
  select d.id, d.mpn, d.manufacturer, d.qty, d.dc_min, d.pack, d.zone, d.lead_days, d.status,
         d.closes_at, d.created_at, ds.via,
         b.id as my_bid_id, b.net as my_net, b.currency as my_currency
  from public.demands d
  join public.demand_sellers ds on ds.demand_id = d.id and ds.seller_id = app.my_org()
  left join public.bids b on b.demand_id = d.id and b.seller_id = ds.seller_id;

-- Offres vues par l'acheteur : alias du vendeur, prix acheteur, lot sans identité ni prix net.
create view public.v_buyer_offers with (security_invoker = false) as
  select o.id, o.demand_id, s.alias as seller_alias, o.rank, o.unit_price, o.buyer_currency as currency,
         o.lead_days, o.date_code, o.status, o.valid_until,
         l.mpn, l.manufacturer, l.qty as lot_qty, l.pack, l.questionnaire, l.docs, l.country_of_origin
  from public.offers o
  join public.demands d on d.id = o.demand_id and d.buyer_id = app.my_org()
  join public.organizations s on s.id = o.seller_id
  join public.lots l on l.id = o.lot_id;

-- Transactions vues par chaque partie : l'autre partie n'apparaît que par son alias,
-- l'acheteur ne voit pas le prix net vendeur, le vendeur ne voit pas l'adresse de livraison détaillée.
create view public.v_my_transactions with (security_invoker = false) as
  select t.id, t.status, t.mpn, t.manufacturer, t.qty, t.lab_level, t.incoterm, t.due_kind, t.due_at,
         t.tracking, t.created_at, t.signed_buyer_at, t.signed_seller_at, t.rejected_qty,
         case when me.type = 'buyer' then 'buyer' when me.type = 'seller' then 'seller' else 'lab' end as my_role,
         case when me.type = 'buyer' then sa.alias end as seller_alias,
         case when me.type = 'seller' then ba.alias end as buyer_alias,
         case when me.type = 'buyer' then t.unit_price end as unit_price,
         case when me.type = 'buyer' then t.currency end as currency,
         case when me.type = 'buyer' then t.lab_fee end as lab_fee,
         case when me.type = 'buyer' then t.total end as total,
         case when me.type = 'buyer' then t.delivery
              else substring(t.delivery from '\(([^)]+)\)') end as delivery,
         case when me.type = 'seller' then t.net end as net,
         case when me.type = 'seller' then t.net_currency end as net_currency,
         t.lot_snapshot - 'seller_id' - 'unit_price' - 'currency' as lot
  from public.transactions t
  join public.organizations me on me.id = app.my_org()
  join public.organizations sa on sa.id = t.seller_id
  join public.organizations ba on ba.id = t.buyer_id
  where app.my_org() in (t.buyer_id, t.seller_id, t.lab_id);

-- Statut public d'un vendeur : alias et badge « vérifié », rien d'autre.
create view public.v_seller_status with (security_invoker = false) as
  select o.alias, o.country, o.profile, app.is_verified(o.id) as verified
  from public.organizations o where o.type = 'seller' and not o.sandbox;

revoke all on public.v_seller_demands, public.v_buyer_offers, public.v_my_transactions, public.v_seller_status from anon;
grant select on public.v_seller_demands, public.v_buyer_offers, public.v_my_transactions, public.v_seller_status to authenticated;
grant select on public.escrow_balances to authenticated;

revoke execute on all functions in schema app from public, anon;
grant execute on function app.my_org(), app.my_type(), app.is_ops(), app.is_verified(text), app.is_party(text) to authenticated;
grant execute on all functions in schema app to service_role;
