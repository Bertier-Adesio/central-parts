-- Tests de 20261102000018 : prix 1KU dans la recherche publique et l'API des offres, « à partir de » inchangé.
-- Prérequis : checks précédents. Lancé par tools/test-db.sh.
\set ON_ERROR_STOP 1

create schema if not exists tests;
create or replace function tests.eq(label text, got anyelement, want anyelement) returns void language plpgsql as $$
begin
  if got is distinct from want then raise exception 'ÉCHEC % : obtenu %, attendu %', label, got, want; end if;
  raise notice 'ok  %', label;
end $$;
grant usage on schema tests to service_role, authenticated, anon;
grant execute on all functions in schema tests to service_role, authenticated, anon;

-- Vendeur vérifié S2 (USD), marge connue : 10 %.
insert into app.seller_margins (org_id, margin_pct) values ('S2', 10)
on conflict (org_id) do update set margin_pct = excluded.margin_pct;
insert into public.lots (id, seller_id, source, sku, mpn, manufacturer, qty, moq, unit_price, currency) values
  ('LOT-K1', 'S2', 'file', 'K1', 'PRIX1K-A', 'Fictif', 50000, 10, 1.30, 'USD'),
  ('LOT-K2', 'S2', 'file', 'K2', 'PRIX1K-B', 'Fictif', 50000, 2000, 0.90, 'USD');
insert into public.lot_price_breaks (lot_id, min_qty, unit_price) values
  ('LOT-K1', 100, 1.20), ('LOT-K1', 1000, 1.00), ('LOT-K1', 10000, 0.80),
  ('LOT-K2', 2000, 0.90), ('LOT-K2', 10000, 0.70);

set role service_role;
do $$
declare a jsonb; b jsonb; oa jsonb; ob jsonb;
begin
  a := public.public_search('test-18', 'PRIX1K-A', 'USD')->'results'->0;
  perform tests.eq('recherche : « à partir de » inchangé (palier le plus bas, marge 10 %)', (a->>'price_from')::numeric, 0.88);
  perform tests.eq('recherche : prix 1KU = palier de 1 000 pièces, marge 10 %', (a->>'price_1k')::numeric, 1.10);
  b := public.public_search('test-18', 'PRIX1K-B', 'USD')->'results'->0;
  perform tests.eq('recherche : MOQ au-delà de 1 000 pièces, pas de prix 1KU', b->'price_1k', 'null'::jsonb);
  perform tests.eq('recherche : « à partir de » toujours donné avec un MOQ élevé', (b->>'price_from')::numeric, 0.77);
  oa := public.partner_offers('test-18', 'PRIX1K-A', 'USD')->'offers'->0;
  perform tests.eq('offres : prix 1KU', (oa->>'price_1k')::numeric, 1.10);
  perform tests.eq('offres : « à partir de » inchangé', (oa->>'price_from')::numeric, 0.88);
  ob := public.partner_offers('test-18', 'PRIX1K-B', 'USD')->'offers'->0;
  perform tests.eq('offres : MOQ au-delà de 1 000 pièces, pas de prix 1KU', ob->'price_1k', 'null'::jsonb);
  perform tests.eq('recherche en EUR : prix 1KU converti comme « à partir de »',
    round((public.public_search('test-18b', 'PRIX1K-A', 'EUR')->'results'->0->>'price_1k')::numeric
        / (public.public_search('test-18c', 'PRIX1K-A', 'EUR')->'results'->0->>'price_from')::numeric, 2), 1.25);
end $$;
reset role;

drop schema tests cascade;
select 'Tous les tests du prix 1KU sont passés.' as resultat;
