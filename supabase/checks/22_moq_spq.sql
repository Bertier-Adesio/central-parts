-- Tests des quantités compatibles avec le MOQ et le SPQ (migration 20261103000027, ADR 0028).
-- Prérequis : checks précédents. Lancé par tools/test-db.sh. Vendeur et lot fictifs.
\set ON_ERROR_STOP 1

create schema if not exists tests;
create or replace function tests.eq(label text, got anyelement, want anyelement) returns void language plpgsql as $$
begin
  if got is distinct from want then raise exception 'ÉCHEC % : obtenu %, attendu %', label, got, want; end if;
  raise notice 'ok  %', label;
end $$;
grant usage on schema tests to service_role;
grant execute on all functions in schema tests to service_role;

do $$ begin
  perform tests.eq('quantité minimale : MOQ 100, SPQ 2 500 → 2 500', app.lot_min_qty(100, 2500), 2500);
  perform tests.eq('quantité minimale : MOQ 3 000, SPQ 2 500 → 5 000', app.lot_min_qty(3000, 2500), 5000);
  perform tests.eq('quantité minimale : sans SPQ → MOQ', app.lot_min_qty(100, null), 100);
  perform tests.eq('quantité minimale : ni MOQ ni SPQ → 1', app.lot_min_qty(null, null), 1);
  perform tests.eq('quantité valide : multiples du SPQ au-delà du MOQ', app.qty_ok(5000, 100, 2500) and app.qty_ok(2500, 100, 2500), true);
  perform tests.eq('quantité refusée : pas un multiple du SPQ', app.qty_ok(2600, 100, 2500), false);
  perform tests.eq('quantité refusée : sous le MOQ', app.qty_ok(50, 100, null), false);
end $$;

insert into public.organizations (id, type, name, alias, city, country, currency, lang, profile, kyb) values
  ('SPQ1', 'seller', 'Fabricant bobines (fictif)', 'tmp-SPQ1', 'Shenzhen', 'CN', 'EUR', 'zh', 'Manufacturer', 'pending');
insert into app.price_rules (category, margin_pct) values ('manufacturer', 10) on conflict (category) do update set margin_pct = 10;
select public.approve_supplier('SPQ1', 'test');
insert into public.lots (id, seller_id, source, sku, mpn, manufacturer, qty, unit_price, currency, moq, standard_pack_quantity, confirmed_at)
values ('LOT-SPQ1', 'SPQ1', 'file', 'SPQ-1', 'SPQTEST01', 'Test Semi', 100000, 0.10, 'EUR', 100, 2500, now());

set role service_role;
do $$
declare q jsonb; o jsonb; buyer jsonb := '{"currency": "EUR", "company": "A", "vat": "DE123456789", "name": "B", "email": "b@example.com", "country": "DE", "address": "C"}';
begin
  o := (select e from jsonb_array_elements(public.partner_offers('10.22.0.1', 'SPQTEST01', 'EUR')->'offers') e);
  perform tests.eq('offres : MOQ, SPQ et quantité minimale', (o->>'moq') || ' ' || (o->>'spq') || ' ' || (o->>'min_qty'), '100 2500 2500');
  q := public.public_quote('SPQTEST01', 'manufacturer', 'CN', 2600, 'EUR');
  perform tests.eq('devis : quantité invalide signalée, minimum et SPQ donnés', (q->>'qty_ok') || ' ' || (q->>'min_qty') || ' ' || (q->>'spq'), 'false 2500 2500');
  perform tests.eq('devis : quantité valide', public.public_quote('SPQTEST01', 'manufacturer', 'CN', 5000, 'EUR')->>'qty_ok', 'true');
  begin
    perform public.create_purchase_cart('10.22.0.2', buyer || '{"lines": [{"mpn": "SPQTEST01", "source": "manufacturer", "ship_from": "CN", "qty": "2600"}]}');
    raise exception 'ÉCHEC panier : quantité hors SPQ acceptée';
  exception when sqlstate 'CP422' then
    declare d text; h text;
    begin
      get stacked diagnostics d = pg_exception_detail, h = pg_exception_hint;
      perform tests.eq('panier : quantité hors SPQ refusée, référence et minimum donnés', d || ' ' || h, 'SPQTEST01 2500/2500');
    end;
  end;
  perform tests.eq('panier : quantité valide acceptée',
    jsonb_array_length(public.create_purchase_cart('10.22.0.3', buyer || '{"lines": [{"mpn": "SPQTEST01", "source": "manufacturer", "ship_from": "CN", "qty": "7500"}]}')->'lines'), 1);
end $$;
reset role;

delete from public.purchase_requests where mpn = 'SPQTEST01';
delete from public.lots where id = 'LOT-SPQ1';
delete from app.price_rules;
drop schema tests cascade;
select 'Tous les tests des quantités MOQ et SPQ sont passés.' as resultat;
