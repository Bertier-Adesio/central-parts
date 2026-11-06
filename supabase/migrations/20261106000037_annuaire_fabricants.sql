-- Annuaire public des fabricants en direct (décision de Bertier, 6 novembre 2026 : « ajoute une page pour les
-- fabricants en direct avec leurs logos, et une page du fabricant qui le présente »). ADR 0032, complément.
--
-- /fabricants/ (sans marque) liste les fabricants dont la page est publiée, distribués en Europe par Central.Parts :
-- logo, nom, positionnement, marques, siège et nombre d'offres en ligne de leur canal officiel ; chaque carte mène à la
-- page du fabricant (/fabricants/?b=MARQUE, 20261105000033). Jamais de contact, de site web, de chiffre d'affaires ni
-- de nom de distributeur. Rejouable.

-- Offres en ligne d'un fabricant par son canal officiel (lui-même et distributeurs agréés rattachés).
create or replace function app.manufacturer_live_offers(p_id text, p_role text default null) returns int
language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.lots l
    join public.manufacturer_distributors d on d.org_id = l.seller_id and d.manufacturer_id = p_id
    join public.organizations o on o.id = l.seller_id
    join public.manufacturers m on m.id = p_id
   where (p_role is null or d.role = p_role) and l.qty > 0 and app.is_verified(o.id) and not o.sandbox
     and app.source_category(o.profile) in ('manufacturer', 'distributor')
     and l.confirmed_at > now() - app.org_ttl(o.offer_ttl_days, o.profile)
     and upper(btrim(l.manufacturer)) = any (select upper(b) from unnest(m.brands) b)
$$;

create or replace function public.public_manufacturers(p_ip text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform app.count_search(p_ip);
  return coalesce((select jsonb_agg(jsonb_build_object('brand', m.brands[1], 'brands', to_jsonb(m.brands), 'name', m.name,
      'logo_path', m.logo_path, 'positioning', m.positioning, 'hq_city', m.hq_city, 'founded_year', m.founded_year,
      'offers', app.manufacturer_live_offers(m.id))
      order by app.manufacturer_live_offers(m.id) desc, m.name)
    from public.manufacturers m where m.public_page and cardinality(m.brands) > 0), '[]');
end $$;

revoke execute on function app.manufacturer_live_offers(text, text) from public, anon, authenticated;
revoke execute on function public.public_manufacturers(text) from public, anon, authenticated;
grant execute on function public.public_manufacturers(text) to service_role;
