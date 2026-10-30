-- Recherche publique du catalogue sur central.parts (ADR 0013), appelée par la fonction Edge « search ».
--
-- Sans compte, un visiteur voit : référence, fabricant, disponibilité par tranche, prix tout compris « à partir de »,
-- catégorie de source et pays d'expédition. Jamais le fournisseur, ni la quantité exacte, ni les paliers.
-- Seuls les lots des fournisseurs validés (app.is_verified) apparaissent.
--
-- Prix tout compris : prix du fournisseur (plus petit prix unitaire ou de palier), marge de la catégorie de source
-- (app.price_rules), conversion dans la devise demandée. Les taux de marge ne sont pas dans ce dépôt public :
-- l'opérateur les saisit dans la base. Sans règle pour une catégorie, le prix est « sur demande » (null).

-- Marge par catégorie de source, en pourcentage du prix du fournisseur.
create table app.price_rules (
  category   text primary key check (category in ('manufacturer', 'distributor', 'broker', 'surplus')),
  margin_pct numeric(6,2) not null check (margin_pct >= 0),
  updated_at timestamptz not null default now()
);
revoke all on app.price_rules from public, anon, authenticated;

-- Limite de requêtes : compteur par empreinte d'adresse IP et par minute (l'adresse elle-même n'est pas gardée).
create table app.search_hits (
  ip_hash text not null,
  minute  timestamptz not null,
  hits    integer not null default 1,
  primary key (ip_hash, minute)
);
revoke all on app.search_hits from public, anon, authenticated;

-- Catégorie de source affichée, à partir du profil de la société.
create or replace function app.source_category(p_profile text) returns text
language sql immutable set search_path = '' as $$
  select case
    when p_profile = 'Manufacturer' then 'manufacturer'
    when p_profile = 'Distributor' then 'distributor'
    when p_profile ilike 'surplus%' then 'surplus'
    else 'broker'
  end
$$;

-- Disponibilité par tranche, jamais la quantité exacte.
create or replace function app.qty_band(p_qty bigint) returns text
language sql immutable set search_path = '' as $$
  select case when p_qty >= 100000 then '100000+' when p_qty >= 10000 then '10000+' when p_qty >= 1000 then '1000+'
              when p_qty >= 100 then '100+' else '1+' end
$$;

-- Recherche par début de référence (3 caractères au moins) : 50 lignes au plus, une par référence, catégorie et pays.
create or replace function public.public_search(p_ip text, q text, p_currency text default 'EUR')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  k text := upper(regexp_replace(coalesce(q, ''), '\s+', '', 'g'));
  cur text := case when upper(p_currency) in (select code from public.currencies) then upper(p_currency) else 'EUR' end;
  v_hash text := encode(extensions.digest(coalesce(p_ip, '') || current_date::text, 'sha256'), 'hex');
  v_hits int;
begin
  if length(k) < 3 then raise exception 'Saisir au moins 3 caractères' using errcode = '22023'; end if;
  insert into app.search_hits (ip_hash, minute) values (v_hash, date_trunc('minute', now()))
  on conflict (ip_hash, minute) do update set hits = app.search_hits.hits + 1
  returning hits into v_hits;
  if v_hits > 30 then raise exception 'Trop de recherches, réessayer dans une minute' using errcode = 'CP429'; end if;
  delete from app.search_hits where minute < now() - interval '1 hour';

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
                  * c.eur_rate / t.eur_rate * (1 + pr.margin_pct / 100)), 4)) as r
        from public.lots l
        join public.organizations o on o.id = l.seller_id
        join public.currencies c on c.code = l.currency
        join public.currencies t on t.code = cur
        left join app.price_rules pr on pr.category = app.source_category(o.profile)
       where upper(l.mpn) like k || '%' and l.qty > 0 and app.is_verified(l.seller_id) and not o.sandbox
       group by upper(l.mpn), app.source_category(o.profile), o.country
       limit 50) s));
end $$;

revoke execute on function public.public_search(text, text, text) from public, anon, authenticated;
grant execute on function public.public_search(text, text, text) to service_role;
revoke execute on function app.source_category(text), app.qty_band(bigint) from public, anon;
