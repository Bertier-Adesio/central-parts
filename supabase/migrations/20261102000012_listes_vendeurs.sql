-- Listes des vendeurs approuvés : dépôt par lien personnel, contrôle ligne par ligne, date de confirmation
-- et expiration des offres, API acheteur anonyme (ADR 0021).
--
-- Rejouable : peut être appliquée de nouveau sans effet de bord, par exemple après 20261101000010, qui
-- redéfinit public_search sans tenir compte de l'expiration.

-- ------------------------------------------------------------ paramètres
-- Seuil d'expiration des offres, modifiable sans code : update app.settings set value = '10' where name = 'offer_ttl_days';
create table if not exists app.settings (
  name       text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);
revoke all on app.settings from public, anon, authenticated;
insert into app.settings (name, value) values ('offer_ttl_days', '7') on conflict (name) do nothing;

create or replace function app.offer_ttl() returns interval
language sql stable security definer set search_path = '' as $$
  select make_interval(days => coalesce((select value::int from app.settings where name = 'offer_ttl_days'), 7))
$$;

-- ------------------------------------------------------------ lots : MOQ et date de confirmation
alter table public.lots add column if not exists moq integer check (moq >= 1);
-- Date du dernier chargement qui a confirmé la ligne. Au-delà du seuil, l'offre est « à reconfirmer » :
-- le vendeur la voit, l'acheteur ne la voit plus.
alter table public.lots add column if not exists confirmed_at timestamptz;
update public.lots set confirmed_at = updated_at where confirmed_at is null;
alter table public.lots alter column confirmed_at set default now(), alter column confirmed_at set not null;

create or replace function app.lot_fresh(p_confirmed timestamptz) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_confirmed > now() - app.offer_ttl()
$$;

-- ------------------------------------------------------------ liens personnels de dépôt
-- Un lien par vendeur approuvé (plusieurs possibles, révocables). Seule l'empreinte du jeton est gardée.
create table if not exists public.depot_links (
  id           bigint generated always as identity primary key,
  org_id       text not null references public.organizations on delete cascade,
  token_hash   text not null unique,
  label        text,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
alter table public.depot_links enable row level security;
revoke all on public.depot_links from public, anon, authenticated;

-- Crée un lien pour un vendeur approuvé ; renvoie le jeton, à transmettre une seule fois au vendeur.
create or replace function public.create_depot_link(p_org text, p_label text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare v_token text := encode(extensions.gen_random_bytes(24), 'hex');
begin
  if not exists (select 1 from public.organizations o where o.id = p_org and o.type = 'seller' and o.kyb = 'validated') then
    raise exception 'Vendeur inconnu ou non approuvé : %', p_org using errcode = 'P0002';
  end if;
  insert into public.depot_links (org_id, token_hash, label)
  values (p_org, encode(extensions.digest(v_token, 'sha256'), 'hex'), left(p_label, 60));
  insert into public.events (actor, text, ref) values ('ops', 'Lien de dépôt créé' || coalesce(' (' || left(p_label, 60) || ')', ''), p_org);
  return v_token;
end $$;

-- Révoque tous les liens d'un vendeur ; renvoie leur nombre.
create or replace function public.revoke_depot_links(p_org text)
returns int language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  update public.depot_links set revoked_at = now() where org_id = p_org and revoked_at is null;
  get diagnostics n = row_count;
  return n;
end $$;

-- Vendeur derrière un jeton : null si le jeton est inconnu ou révoqué, ou si le vendeur n'est plus approuvé.
create or replace function public.depot_link_identity(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare k public.depot_links; o public.organizations;
begin
  select * into k from public.depot_links
   where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex') and revoked_at is null;
  if k.id is null then return null; end if;
  select * into o from public.organizations where id = k.org_id;
  if not app.is_verified(o.id) then return null; end if;
  update public.depot_links set last_used_at = now() where id = k.id;
  return jsonb_build_object('org_id', o.id, 'name', o.name, 'currency', o.currency,
    'ttl_days', extract(day from app.offer_ttl())::int);
end $$;

-- État des offres d'un vendeur, pour lui seul : en ligne, à reconfirmer, dernière confirmation.
create or replace function public.seller_offer_status(p_org text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'live', count(*) filter (where app.lot_fresh(l.confirmed_at)),
    'to_reconfirm', count(*) filter (where not app.lot_fresh(l.confirmed_at)),
    'last_confirmed', max(l.confirmed_at),
    'expires_at', max(l.confirmed_at) + app.offer_ttl(),
    'ttl_days', extract(day from app.offer_ttl())::int)
  from public.lots l where l.seller_id = p_org and l.qty > 0
$$;

-- ------------------------------------------------------------ transformation des lignes (remplace 20261030000003)
-- Nouveautés : MOQ, date de confirmation, code de raison sur chaque rejet ; dans un fichier complet (cas des liens
-- personnels), les paliers et le MOQ absents d'une ligne sont effacés plutôt que gardés de la liste précédente.
create or replace function public.apply_stock_import_batch(p_import text, p_rows jsonb, p_rejected jsonb default '[]')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  imp public.stock_imports;
  r jsonb;
  v_cur text; v_mpn text; v_sku text; v_dc text; v_qty integer; v_moq integer; v_lot text; v_other text;
  n_created int := 0; n_updated int := 0; n_dupes int := 0; n_nodc int := 0;
  rej jsonb := coalesce(p_rejected, '[]'); dupes jsonb := '[]';
begin
  select * into imp from public.stock_imports where id = p_import for update;
  if imp.id is null then raise exception 'Import inconnu : %', p_import; end if;
  if imp.org_id is null or imp.status in ('done', 'failed') then raise exception 'Import % non modifiable (%)', p_import, imp.status; end if;
  if imp.status = 'received' then update public.stock_imports set status = 'processing' where id = p_import; end if;

  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]')) loop
    v_mpn := upper(btrim(coalesce(r->>'mpn', '')));
    v_sku := nullif(btrim(coalesce(r->>'sku', '')), '');
    v_dc := btrim(coalesce(r->>'dc', ''));
    v_qty := case when (r->>'qty') ~ '^\d+$' then (r->>'qty')::int end;
    v_moq := case when (r->>'moq') ~ '^\d+$' and (r->>'moq')::int >= 1 then (r->>'moq')::int end;
    v_cur := upper(btrim(coalesce(nullif(r->>'currency', ''),
               (select o.currency from public.organizations o where o.id = imp.org_id), 'USD')));
    if v_cur in ('RMB', 'CNY') then v_cur := 'CNH'; end if;

    if v_mpn = '' then rej := rej || jsonb_build_object('line', r->'line', 'code', 'mpn_missing', 'reason', 'MPN manquant'); continue; end if;
    if v_qty is null or v_qty <= 0 then
      rej := rej || jsonb_build_object('line', r->'line', 'code', 'qty_invalid', 'reason', 'Quantité invalide'); continue;
    end if;
    if not exists (select 1 from public.currencies c where c.code = v_cur) then
      rej := rej || jsonb_build_object('line', r->'line', 'code', 'currency', 'reason', 'Devise non prise en charge : ' || v_cur); continue;
    end if;
    if v_dc = '' then n_nodc := n_nodc + 1; end if;

    -- Même lot chez le même vendeur : même SKU s'il existe, sinon même référence et même date code.
    select l.id into v_lot from public.lots l
     where l.seller_id = imp.org_id
       and (case when v_sku is not null then l.sku = v_sku else l.sku is null and upper(l.mpn) = v_mpn and l.date_code = v_dc end)
     limit 1;

    if v_lot is not null then
      update public.lots set
        mpn = v_mpn,
        manufacturer = coalesce(nullif(r->>'mfr', ''), manufacturer),
        product_url = coalesce(nullif(r->>'url', ''), product_url),
        qty = v_qty,
        moq = case when imp.replace_all then v_moq else coalesce(v_moq, moq) end,
        date_code = coalesce(nullif(v_dc, ''), date_code),
        pack = coalesce(nullif(r->>'pack', ''), pack),
        unit_price = case when imp.replace_all then (r->>'price')::numeric else coalesce((r->>'price')::numeric, unit_price) end,
        currency = v_cur,
        confirmed_at = now(),
        import_id = p_import
      where id = v_lot;
      n_updated := n_updated + 1;
    else
      insert into public.lots (seller_id, source, sku, product_url, mpn, manufacturer, qty, moq, date_code, pack, unit_price, currency, import_id, confirmed_at)
      values (imp.org_id, 'file', v_sku, nullif(r->>'url', ''), v_mpn, coalesce(r->>'mfr', ''), v_qty, v_moq, v_dc,
              nullif(r->>'pack', ''), (r->>'price')::numeric, v_cur, p_import, now())
      returning id into v_lot;
      n_created := n_created + 1;
      -- Doublon possible : même référence, même date code, même quantité chez un autre vendeur (signalé, pas fusionné).
      select l.id into v_other from public.lots l
       where l.seller_id <> imp.org_id and upper(l.mpn) = v_mpn and l.date_code = v_dc and l.qty = v_qty limit 1;
      if v_other is not null then
        n_dupes := n_dupes + 1;
        dupes := dupes || jsonb_build_object('line', r->'line', 'lot', v_lot, 'same_as', v_other);
      end if;
    end if;

    -- Paliers : remplacés quand la ligne en fournit ; effacés dans un fichier complet qui n'en donne pas.
    if jsonb_typeof(r->'tiers') = 'object' and r->'tiers' <> '{}'::jsonb then
      delete from public.lot_price_breaks where lot_id = v_lot;
      insert into public.lot_price_breaks (lot_id, min_qty, unit_price)
        select v_lot, t.key::int, t.value::numeric from jsonb_each_text(r->'tiers') t
         where t.key ~ '^\d+$' and t.value ~ '^\d+(\.\d+)?$' and t.value::numeric >= 0;
    elsif imp.replace_all then
      delete from public.lot_price_breaks where lot_id = v_lot;
    end if;
  end loop;

  update public.stock_imports set
    rows_total = rows_total + jsonb_array_length(coalesce(p_rows, '[]')) + jsonb_array_length(coalesce(p_rejected, '[]')),
    created = created + n_created, updated = updated + n_updated,
    rejected = rejected + jsonb_array_length(rej), duplicates = duplicates + n_dupes,
    missing_date_code = missing_date_code + n_nodc,
    -- le rapport garde au plus 1 000 lignes rejetées et 1 000 doublons ; les compteurs restent exacts
    report = jsonb_build_object(
      'rejected', (select coalesce(jsonb_agg(x), '[]') from (select x from jsonb_array_elements(report->'rejected' || rej) x limit 1000) s),
      'duplicates', (select coalesce(jsonb_agg(x), '[]') from (select x from jsonb_array_elements(report->'duplicates' || dupes) x limit 1000) s))
  where id = p_import;

  return jsonb_build_object('created', n_created, 'updated', n_updated, 'rejected', jsonb_array_length(rej), 'duplicates', n_dupes);
end $$;
revoke execute on function public.apply_stock_import_batch(text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.apply_stock_import_batch(text, jsonb, jsonb) to service_role;

-- ------------------------------------------------------------ prix acheteur
-- Marge d'un vendeur : app.margin_for (migrations 009 et 010) si elle existe, sinon celle de sa catégorie de source.
-- Sans règle : null, le prix est « sur demande ».
create or replace function app.offer_margin(p_org text) returns numeric
language plpgsql stable security definer set search_path = '' as $$
declare m numeric;
begin
  if to_regprocedure('app.margin_for(text)') is not null then
    execute 'select app.margin_for($1)' into m using p_org;
    return m;
  end if;
  return (select r.margin_pct from app.price_rules r join public.organizations o on r.category = app.source_category(o.profile) where o.id = p_org);
end $$;
revoke execute on function app.offer_margin(text) from public, anon, authenticated;

-- Compteur de requêtes partagé par les recherches publiques : 30 par minute et par empreinte d'adresse IP.
create or replace function app.count_search(p_ip text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_hash text := encode(extensions.digest(coalesce(p_ip, '') || current_date::text, 'sha256'), 'hex'); v_hits int;
begin
  insert into app.search_hits (ip_hash, minute) values (v_hash, date_trunc('minute', now()))
  on conflict (ip_hash, minute) do update set hits = app.search_hits.hits + 1
  returning hits into v_hits;
  if v_hits > 30 then raise exception 'Trop de recherches, réessayer dans une minute' using errcode = 'CP429'; end if;
  delete from app.search_hits where minute < now() - interval '1 hour';
end $$;
revoke execute on function app.count_search(text) from public, anon, authenticated;

-- ------------------------------------------------------------ recherche publique (/recherche/) : offres à jour seulement
-- Même réponse qu'en 20261101000010 ; les lots non reconfirmés depuis le seuil n'y figurent plus.
create or replace function public.public_search(p_ip text, q text, p_currency text default 'EUR')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  k text := upper(regexp_replace(coalesce(q, ''), '\s+', '', 'g'));
  cur text := case when upper(p_currency) in (select code from public.currencies) then upper(p_currency) else 'EUR' end;
begin
  if length(k) < 3 then raise exception 'Saisir au moins 3 caractères' using errcode = '22023'; end if;
  perform app.count_search(p_ip);
  return jsonb_build_object('query', k, 'currency', cur, 'results', (
    select coalesce(jsonb_agg(r order by r->>'mpn', r->>'source'), '[]') from (
      select jsonb_build_object(
               'mpn', upper(l.mpn),
               'manufacturer', max(l.manufacturer),
               'source', app.source_category(o.profile),
               'ship_from', o.country,
               'availability', app.qty_band(sum(l.qty)),
               'price_from', round(min(
                  least(l.unit_price, (select min(b.unit_price) from public.lot_price_breaks b where b.lot_id = l.id))
                  * c.eur_rate / t.eur_rate * (1 + app.offer_margin(o.id) / 100)), 4)) as r
        from public.lots l
        join public.organizations o on o.id = l.seller_id
        join public.currencies c on c.code = l.currency
        join public.currencies t on t.code = cur
       where upper(l.mpn) like k || '%' and l.qty > 0 and app.lot_fresh(l.confirmed_at)
         and app.is_verified(l.seller_id) and not o.sandbox
       group by upper(l.mpn), app.source_category(o.profile), o.country
       limit 50) s));
end $$;
revoke execute on function public.public_search(text, text, text) from public, anon, authenticated;
grant execute on function public.public_search(text, text, text) to service_role;

-- ------------------------------------------------------------ API acheteur : une ligne par offre, vendeur anonyme
-- GET /functions/v1/offers?q=TPS&cur=EUR. Sans q : les 50 offres confirmées le plus récemment.
-- Le vendeur n'apparaît jamais (ni nom, ni pseudonyme, ni SKU, ni lien) : « supplier » vaut toujours « partner ».
-- Quantité par tranche et prix « à partir de » tout compris, comme la recherche publique (ADR 0013).
-- seller_category est réservé au modèle à deux axes (ADR 0021), null tant qu'il n'est pas défini.
create or replace function public.partner_offers(p_ip text, q text default '', p_currency text default 'EUR')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  k text := upper(regexp_replace(coalesce(q, ''), '\s+', '', 'g'));
  cur text := case when upper(p_currency) in (select code from public.currencies) then upper(p_currency) else 'EUR' end;
begin
  if length(k) between 1 and 2 then raise exception 'Saisir au moins 3 caractères' using errcode = '22023'; end if;
  perform app.count_search(p_ip);
  return jsonb_build_object('query', k, 'currency', cur, 'ttl_days', extract(day from app.offer_ttl())::int, 'offers', (
    select coalesce(jsonb_agg(r order by r->>'mpn', r->>'updated_at' desc), '[]') from (
      select jsonb_build_object(
               'mpn', upper(l.mpn),
               'manufacturer', l.manufacturer,
               'supplier', 'partner',
               'seller_category', null,
               'source', app.source_category(o.profile),
               'ship_from', o.country,
               'availability', app.qty_band(l.qty),
               'moq', l.moq,
               'price_from', round(least(l.unit_price, (select min(b.unit_price) from public.lot_price_breaks b where b.lot_id = l.id))
                                   * c.eur_rate / t.eur_rate * (1 + app.offer_margin(o.id) / 100), 4),
               'updated_at', l.confirmed_at) as r
        from public.lots l
        join public.organizations o on o.id = l.seller_id
        join public.currencies c on c.code = l.currency
        join public.currencies t on t.code = cur
       where (k = '' or upper(l.mpn) like k || '%') and l.qty > 0 and app.lot_fresh(l.confirmed_at)
         and app.is_verified(l.seller_id) and not o.sandbox
       order by l.confirmed_at desc
       limit 50) s));
end $$;

revoke execute on function public.partner_offers(text, text, text), public.create_depot_link(text, text),
  public.revoke_depot_links(text), public.depot_link_identity(text), public.seller_offer_status(text)
  from public, anon, authenticated;
grant execute on function public.partner_offers(text, text, text), public.create_depot_link(text, text),
  public.revoke_depot_links(text), public.depot_link_identity(text), public.seller_offer_status(text)
  to service_role;
revoke execute on function app.offer_ttl(), app.lot_fresh(timestamptz) from public, anon;
