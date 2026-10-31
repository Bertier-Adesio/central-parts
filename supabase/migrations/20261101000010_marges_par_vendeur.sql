-- Marges par catégorie de source et par vendeur (ADR 0013, complété le 1er novembre 2026).
-- La marge d'un vendeur, si elle est saisie, remplace celle de sa catégorie. Les taux ne sont pas dans ce dépôt
-- public : l'opérateur les saisit dans la base (voir supabase/README.md).

create table if not exists app.seller_margins (
  org_id     text primary key references public.organizations on delete cascade,
  margin_pct numeric(6,2) not null check (margin_pct >= 0),
  updated_at timestamptz not null default now()
);
revoke all on app.seller_margins from public, anon, authenticated;

-- Marge applicable à un vendeur : la sienne, sinon celle de sa catégorie, sinon null (prix sur demande).
create or replace function app.margin_for(p_org text) returns numeric
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select m.margin_pct from app.seller_margins m where m.org_id = p_org),
    (select r.margin_pct from app.price_rules r join public.organizations o on r.category = app.source_category(o.profile) where o.id = p_org))
$$;
revoke execute on function app.margin_for(text) from public, anon, authenticated;

-- Recherche publique : même réponse qu'en 20261031000008, marge par vendeur ou par catégorie.
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
                  * c.eur_rate / t.eur_rate * (1 + app.margin_for(o.id) / 100)), 4)) as r
        from public.lots l
        join public.organizations o on o.id = l.seller_id
        join public.currencies c on c.code = l.currency
        join public.currencies t on t.code = cur
       where upper(l.mpn) like k || '%' and l.qty > 0 and app.is_verified(l.seller_id) and not o.sandbox
       group by upper(l.mpn), app.source_category(o.profile), o.country
       limit 50) s));
end $$;
revoke execute on function public.public_search(text, text, text) from public, anon, authenticated;
grant execute on function public.public_search(text, text, text) to service_role;
