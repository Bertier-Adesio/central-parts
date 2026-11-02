-- API d'offres en direct (ADR 0024) : offres publiables, anonymat, prix tout compris, paliers, sur demande,
-- identifiant opaque, nomenclature, bac à sable, compteur de consultations, droits. Lancé par tools/test-db.sh.
\set ON_ERROR_STOP 1

create schema if not exists tests;
create or replace function tests.eq(label text, got anyelement, want anyelement) returns void language plpgsql as $$
begin
  if got is distinct from want then raise exception 'ÉCHEC % : obtenu %, attendu %', label, got, want; end if;
  raise notice 'ok  %', label;
end $$;
create or replace function tests.fails(label text, stmt text, code text) returns void language plpgsql as $$
begin
  execute stmt;
  raise exception 'ÉCHEC % : aucune erreur', label;
exception when others then
  if sqlerrm like 'ÉCHEC%' then raise; end if;
  if sqlstate <> code then raise exception 'ÉCHEC % : erreur % (%), attendu %', label, sqlstate, sqlerrm, code; end if;
  raise notice 'ok  %', label;
end $$;
grant usage on schema tests to service_role, authenticated, anon;
grant execute on all functions in schema tests to service_role, authenticated, anon;

-- Fournisseurs fictifs : CA1 broker (HK, USD, marge 10 %), CA2 fabricant (CN, CNH, marge 5 %), CA3 sans marge,
-- CA4 dont le lot n'est plus reconfirmé, CAS bac à sable.
insert into public.organizations (id, type, name, alias, city, country, currency, lang, profile, kyb, sandbox) values
  ('CA1', 'seller', 'Fournisseur partenaire A (fictif)', 'V-701', 'Hong Kong', 'HK', 'USD', 'zh', 'Broker', 'validated', false),
  ('CA2', 'seller', 'Fournisseur partenaire B (fictif)', 'V-702', 'Shenzhen', 'CN', 'CNH', 'zh', 'Manufacturer', 'validated', false),
  ('CA3', 'seller', 'Fournisseur partenaire C (fictif)', 'V-703', 'Shenzhen', 'CN', 'CNH', 'zh', 'Distributor', 'validated', false),
  ('CA4', 'seller', 'Fournisseur partenaire D (fictif)', 'V-704', 'Shenzhen', 'CN', 'USD', 'zh', 'Broker', 'validated', false),
  ('CAS', 'seller', 'Fournisseur du bac à sable (fictif)', 'V-705', 'Bac à sable', 'HK', 'USD', 'en', 'Broker', 'validated', true);
insert into public.subscriptions (org_id, plan, until) values ('CA1', 'T', current_date + 30), ('CA2', 'T', current_date + 30),
  ('CA3', 'T', current_date + 30), ('CA4', 'T', current_date + 30);
insert into public.lots (id, seller_id, sku, product_url, mpn, manufacturer, qty, moq, date_code, pack, unit_price, currency, lead_days, confirmed_at, description, datasheet_url) values
  ('LOT-CA1', 'CA1', 'SKU-SECRET-CA1', 'https://fournisseur.example/fiche-secrete', 'CATTEST 555', 'Texas Instruments', 5000, 100, '2430', 'Bande et bobine', 0.20, 'USD', 3, now(), 'Minuterie', 'https://www.ti.com/lit/ds/symlink/ne555.pdf'),
  ('LOT-CA2', 'CA2', 'SKU-SECRET-CA2', null, 'CATTEST555', 'texas instruments', 20000, 1000, '', 'Bande et bobine', 1.00, 'CNH', 10, now(), null, null),
  ('LOT-CA3', 'CA3', 'SKU-SECRET-CA3', null, 'CATTEST555', 'Texas Instruments', 300, null, '2401', null, 0.15, 'CNH', null, now(), null, null),
  ('LOT-CA4', 'CA4', 'SKU-SECRET-CA4', null, 'CATTEST555', 'Texas Instruments', 900, null, '2401', null, 0.10, 'USD', null, now() - interval '30 days', null, null),
  ('LOT-CAS', 'CAS', 'SKU-SECRET-CAS', null, 'CATTEST555', 'Texas Instruments', 7000, null, '2440', null, 0.12, 'USD', 2, now() - interval '90 days', null, null),
  ('LOT-CAO', 'CA1', 'SKU-SECRET-CAO', null, 'CATOTHER', 'Murata', 10, null, '', null, 1, 'USD', null, now(), null, null);
insert into public.lot_price_breaks (lot_id, min_qty, unit_price) values ('LOT-CA1', 1000, 0.18), ('LOT-CA1', 5000, 0.15), ('LOT-CA2', 10000, 0.90);
insert into app.seller_margins (org_id, margin_pct) values ('CA1', 10), ('CA2', 5), ('CA4', 10), ('CAS', 10)
on conflict (org_id) do update set margin_pct = excluded.margin_pct;
-- CA3 (Distributor) sans marge : la catégorie distributeur n'a pas de marge dans ce contrôle.
delete from app.price_rules where category = 'distributor';

-- Champs repris du tri DigiKey / TI, sur le lot de CA1.
update public.lots set standard_pack_quantity = 2500, package_case = 'SOIC-8', lifecycle = 'active', eccn = 'EAR99',
  hts_code = '8542330001', country_of_origin = 'my' where id = 'LOT-CA1';

set role service_role;
do $$
declare r jsonb; p jsonb; offs jsonb; o jsonb; v text;
begin
  r := public.catalog_offers('PLAT', 'cattest555', null, 2000, 'EUR');
  perform tests.eq('un produit : trois graphies de Texas Instruments, un seul fabricant', jsonb_array_length(r->'products'), 1);
  p := r->'products'->0; offs := p->'offers';
  perform tests.eq('offres : lots à jour seulement (CA4 non reconfirmé exclu), bac à sable exclu', jsonb_array_length(offs), 3);
  perform tests.eq('référence normalisée', (r->>'mpn') || ' ' || (p->>'mpn'), 'CATTEST555 CATTEST555');
  perform tests.eq('fabricant normalisé {id, name} (« texas instruments » déposé en minuscules)', p->'manufacturer', '{"id": "MFR-TI", "name": "Texas Instruments"}'::jsonb);
  perform tests.eq('produit : description, fiche technique, lien Central.Parts, boîtier, cycle de vie, ECCN, HTS',
    p - 'offers' - 'manufacturer' - 'mpn',
    '{"description": "Minuterie", "datasheet_url": "https://www.ti.com/lit/ds/symlink/ne555.pdf", "product_url": "https://central.parts/recherche/?q=CATTEST555",
      "package_case": "SOIC-8", "lifecycle": "active", "eccn": "EAR99", "hts_code": "8542330001"}'::jsonb);
  perform tests.eq('anonymat : ni fournisseur, ni pseudonyme, ni SKU, ni lien, ni lot, ni prix net',
    r::text ~ '(CA[0-9S]|V-70|SKU-SECRET|fournisseur\.example|LOT-|Fournisseur partenaire|"net"|"price")', false);
  -- Tri : CA2 1,05 CNH ≈ 0,1344 EUR ; CA1 0,22 USD ≈ 0,2024 EUR ; CA3 sans marge (sur demande) en dernier.
  perform tests.eq('tri sur le prix au minimum, sur demande en dernier', jsonb_path_query_array(offs, '$[*].ship_from'), '["CN", "HK", "CN"]');
  o := offs->1;
  perform tests.eq('devise du lot (conversion désactivée)', o->>'currency', 'USD');
  perform tests.eq('paliers {quantity, unit_price} tout compris à partir du MOQ', o->'price_breaks',
    '[{"unit_price": 0.2200, "quantity": 100}, {"unit_price": 0.1980, "quantity": 1000}, {"unit_price": 0.1650, "quantity": 5000}]'::jsonb);
  perform tests.eq('prix à la quantité (2000 → palier 1000)', (o->'quote'->>'unit_price')::numeric || ' ' || (o->'quote'->>'extended_price'), '0.1980 396.00');
  perform tests.eq('offre : catégorie, MOQ, conditionnement complet, délai, date code, conditionnement normalisé, origine',
    (o->>'source_category') || ' ' || (o->>'moq') || ' ' || (o->>'standard_pack_quantity') || ' ' || (o->>'lead_time_days') || ' ' || (o->>'date_code')
      || ' ' || (o->>'packaging') || ' ' || (o->>'packaging_label') || ' ' || (o->>'country_of_origin'),
    'broker_surplus 100 2500 3 2430 tape_reel Bande et bobine MY');
  perform tests.eq('champ inconnu absent, jamais null', (offs->0 ? 'standard_pack_quantity') or (offs->0 ? 'date_code') or (r::text ~ ': null'), false);
  perform tests.eq('fabricant : catégorie manufacturer', offs->0->>'source_category', 'manufacturer');
  perform tests.eq('sans marge : sur demande, sans prix ni devise', (offs->2->>'price_status') || ' ' || (offs->2->'price_breaks')::text || ' ' || coalesce(offs->2->>'currency', '-'), 'on_request [] -');
  perform tests.eq('distributeur présenté agréé', offs->2->>'source_category', 'authorized_distributor');
  perform tests.eq('validité du prix : 24 h au plus', ((o->>'price_valid_until')::timestamptz <= now() + interval '24 hours'), true);
  perform tests.eq('quantité sous le MOQ : pas de prix à la quantité', public.catalog_offers('PLAT', 'CATTEST555', null, 50)->'products'->0->'offers'->1->'quote', null::jsonb);

  -- Identifiant opaque, stable ; détail d'une offre avec son produit.
  v := o->>'offer_id';
  perform tests.eq('identifiant opaque cpo_', v ~ '^cpo_[0-9a-f]{20}$', true);
  perform tests.eq('identifiant stable d''un appel à l''autre', public.catalog_offers('PLAT', 'CATTEST555')->'products'->0->'offers'->1->>'offer_id', v);
  o := public.catalog_offer('PLAT', v, 5000, null);
  perform tests.eq('détail d''une offre : prix à 5000, produit joint', (o->'quote'->>'unit_price') || ' ' || (o->'product'->'manufacturer'->>'id') || ' ' || (o->'product' ? 'offers')::text,
    '0.1650 MFR-TI false');
  perform tests.fails('détail : quantité sous le MOQ', format('select public.catalog_offer(%L, %L, 10)', 'PLAT', v), '22023');
  perform tests.fails('détail : identifiant inconnu', $s$select public.catalog_offer('PLAT', 'cpo_00000000000000000000')$s$, 'P0002');
  perform tests.fails('détail : offre du bac à sable invisible en production',
    format('select public.catalog_offer(%L, %L)', 'PLAT', public.catalog_offers('PLAT', 'CATTEST555', null, null, null, null, true)->'products'->0->'offers'->0->>'offer_id'), 'P0002');

  -- Filtres et erreurs.
  perform tests.eq('filtre fabricant (casse ignorée)', jsonb_array_length(public.catalog_offers('PLAT', 'CATTEST555', 'TEXAS INSTRUMENTS')->'products'->0->'offers'), 3);
  perform tests.eq('filtre fabricant par alias (« TI », « 德州仪器 »)',
    jsonb_array_length(public.catalog_offers('PLAT', 'CATTEST555', 'TI')->'products'->0->'offers') || ' ' || jsonb_array_length(public.catalog_offers('PLAT', 'CATTEST555', '德州仪器')->'products'->0->'offers'), '3 3');
  perform tests.eq('filtre fabricant : autre fabricant', jsonb_array_length(public.catalog_offers('PLAT', 'CATTEST555', 'Murata')->'products'), 0);
  perform tests.eq('filtre catégorie', jsonb_path_query_array(public.catalog_offers('PLAT', 'CATTEST555', null, null, null, '{broker_surplus}'), '$.products[*].offers[*].source_category'), '["broker_surplus"]');
  perform tests.fails('catégorie inconnue', $s$select public.catalog_offers('PLAT', 'CATTEST555', null, null, null, '{agree}')$s$, '22023');
  perform tests.fails('mpn vide', $s$select public.catalog_offers('PLAT', ' ')$s$, '22023');
  perform tests.fails('devise refusée', $s$select public.catalog_offers('PLAT', 'CATTEST555', null, null, 'CHF')$s$, '22023');
  perform tests.eq('référence inconnue : aucun produit', public.catalog_offers('PLAT', 'INCONNU-XYZ')->'products', '[]'::jsonb);

  -- Bac à sable.
  r := public.catalog_offers('PLAT', 'CATTEST555', null, null, null, null, true);
  perform tests.eq('bac à sable : lot fictif jamais périmé, fournisseur de test seulement', jsonb_array_length(r->'products'->0->'offers') || ' ' || (r->'products'->0->'offers'->0->>'stock'), '1 7000');

  -- Nomenclature.
  r := public.catalog_search('PLAT', '{"lines": [{"line_id": "A", "mpn": "CATTEST555", "quantity": 2000}, {"line_id": "B", "mpn": "CATOTHER"}, {"mpn": "INCONNU"}]}');
  perform tests.eq('nomenclature : lignes reprises', jsonb_path_query_array(r, '$.lines[*].line_id'), '["A", "B", "3"]');
  perform tests.eq('nomenclature : produits par ligne', jsonb_path_query_array(r, '$.lines[*].products.size()'), '[1, 1, 0]');
  perform tests.eq('nomenclature : Murata reconnu', r->'lines'->1->'products'->0->'manufacturer'->>'id', 'MFR-MURATA');
  perform tests.fails('nomenclature : 501 lignes', format('select public.catalog_search(%L, %L)', 'PLAT',
    jsonb_build_object('lines', (select jsonb_agg(jsonb_build_object('mpn', 'X' || i)) from generate_series(1, 501) i))), '22023');
  perform tests.fails('nomenclature : quantité invalide', $s$select public.catalog_search('PLAT', '{"lines": [{"line_id": "Q", "mpn": "A", "quantity": 0}]}')$s$, '22023');

  -- Fabricants : référentiel, alias.
  r := public.catalog_manufacturers('tex');
  perform tests.eq('fabricants : référentiel (identifiant, nom), graphies regroupées', (r->'manufacturers'->0->>'id') || ' ' || (r->'manufacturers'->0->>'name') || ' ' || jsonb_array_length(r->'manufacturers'),
    'MFR-TI Texas Instruments 1');
  perform tests.eq('fabricants : recherche par alias', public.catalog_manufacturers('ti')->'manufacturers'->0->>'id', 'MFR-TI');
end $$;
reset role;

-- Conditionnement en liste fermée, depuis les libellés des fichiers.
do $$ begin
  perform tests.eq('conditionnement normalisé',
    array[app.packaging_code('Tape & Reel'), app.packaging_code('Cut Tape (CT)'), app.packaging_code('Digi-Reel®'), app.packaging_code('Bande et bobine'),
          app.packaging_code('编带'), app.packaging_code('Plateau'), app.packaging_code('Tube'), app.packaging_code('散装'), app.packaging_code('SOT-223'), app.packaging_code('')],
    array['tape_reel', 'cut_tape', 'tape_reel', 'tape_reel', 'tape_reel', 'tray', 'tube', 'bulk', null, null]);
  perform tests.eq('fabricant inconnu : pas d''identifiant', app.manufacturer_id('Fabricant inconnu SA'), null::text);
end $$;

-- Lecture d'un fichier de stock avec les champs facultatifs (même fonction que la fonction Edge import-stock).
insert into storage.objects (bucket_id, name) values ('stock-imports', 'CA1/champs-api.csv');
set role service_role;
do $$
declare imp text := (select id from public.stock_imports where storage_path = 'CA1/champs-api.csv');
begin
  perform public.apply_stock_import_batch(imp, '[{"line": 2, "mpn": "CATNEW1", "mfr": "TI", "sku": "SKU-SECRET-NEW", "qty": 4000, "currency": "USD", "price": 0.3,
    "pack": "Tape & Reel", "case": "SOT-23", "spq": 3000, "lifecycle": "nrnd", "eccn": "EAR99", "hts": "8541210000", "coo": "PH"}]');
  perform tests.eq('import : champs facultatifs enregistrés',
    (select standard_pack_quantity || ' ' || package_case || ' ' || lifecycle || ' ' || eccn || ' ' || hts_code || ' ' || country_of_origin from public.lots where sku = 'SKU-SECRET-NEW'),
    '3000 SOT-23 nrnd EAR99 8541210000 PH');
  perform public.apply_stock_import_batch(imp, '[{"line": 3, "mpn": "CATNEW1", "sku": "SKU-SECRET-NEW", "qty": 3500, "currency": "USD", "lifecycle": "peut-être", "spq": "x"}]');
  perform tests.eq('import : champ absent ou illisible, valeur gardée', (select qty || ' ' || standard_pack_quantity || ' ' || lifecycle from public.lots where sku = 'SKU-SECRET-NEW'), '3500 3000 nrnd');
end $$;
reset role;

-- Conversion activée : prix dans la devise demandée.
reset role;
update app.settings set value = 'true' where name = 'api_convert_currency';
set role service_role;
do $$ declare o jsonb;
begin
  o := public.catalog_offers('PLAT', 'CATTEST555', null, 2000, 'EUR')->'products'->0->'offers'->1;
  -- 0,18 USD × 0,92 × 1,1 = 0,18216 EUR.
  perform tests.eq('conversion activée : EUR', (o->>'currency') || ' ' || (o->'quote'->>'unit_price'), 'EUR 0.1822');
end $$;
reset role;
update app.settings set value = 'false' where name = 'api_convert_currency';

-- Compteur de consultations.
set role service_role;
do $$ declare v jsonb;
begin
  v := public.supplier_offer_views('CA1');
  perform tests.eq('compteur : consultations comptées pour CA1', (v->>'total')::int > 0, true);
  perform tests.eq('compteur : par référence', v->'top'->0->>'mpn', 'CATTEST555');
  perform tests.eq('compteur : lot non reconfirmé jamais compté', (public.supplier_offer_views('CA4')->>'total')::int, 0);
end $$;
reset role;

-- Limite propre à une clé.
insert into public.organizations (id, type, name, alias, country, currency, kyb) values ('PLATC', 'buyer', 'Plateforme C (fictive)', 'P-C', 'FR', 'EUR', 'validated');
insert into public.api_keys (id, org_id, environment, prefix, key_hash, calls_per_minute) values ('KEY-CAT', 'PLATC', 'live', 'cp_live_ct', 'empreinte-cat', 300);
set role service_role;
do $$ declare t timestamptz := '2026-11-05 10:00+00'; n int;
begin
  perform tests.eq('limite propre à la clé annoncée', public.rfq_auth('empreinte-cat', t)->>'limit', '300');
  for n in 2..300 loop perform public.rfq_auth('empreinte-cat', t); end loop;
  perform tests.fails('301e appel de la minute : 429', format('select public.rfq_auth(%L, %L)', 'empreinte-cat', t), 'CP429');
end $$;
reset role;

do $$ begin
  perform tests.eq('anon ne peut pas interroger l''API d''offres', has_function_privilege('anon', 'public.catalog_offers(text, text, text, int, text, text[], boolean, timestamptz)', 'execute'), false);
  perform tests.eq('authenticated non plus (clé d''API obligatoire)', has_function_privilege('authenticated', 'public.catalog_search(text, jsonb, boolean, timestamptz)', 'execute'), false);
end $$;
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000f2';
do $$ begin
  perform tests.fails('consultations : réservées à l''administrateur', $s$select public.admin_offer_views('CA1')$s$, '42501');
end $$;
reset role; reset request.jwt.claim.sub;
drop schema tests cascade;
