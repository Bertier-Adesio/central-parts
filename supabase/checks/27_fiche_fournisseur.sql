-- Tests de la fiche fournisseur et de la page publique « fabricant » (migration 20261105000032). Fabricant, marque et
-- contacts fictifs. Prérequis : checks précédents (administrateur fictif e1). Lancé par tools/test-db.sh.
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
create table tests.vars (k text primary key, v text);
grant all on tests.vars to service_role, authenticated;

-- Un fabricant fictif (marque « Marque Test ») et un distributeur fictif qui revend la même marque.
insert into public.organizations (id, type, name, alias, city, country, currency, lang, profile, kyb) values
  ('FB1', 'seller', 'Fabricant de démonstration (fictif)', 'tmp-FB1', 'Shenzhen', 'CN', 'USD', 'zh', 'Manufacturer', 'pending'),
  ('FB2', 'seller', 'Distributeur de démonstration (fictif)', 'tmp-FB2', 'Hong Kong', 'HK', 'USD', 'en', 'Distributor', 'pending');
select public.approve_supplier('FB1', 'test'), public.approve_supplier('FB2', 'test');
insert into public.lots (id, seller_id, source, sku, mpn, manufacturer, qty, unit_price, currency, confirmed_at) values
  ('LOT-FB1', 'FB1', 'file', 'FB-1', 'FICHETEST01', 'Marque Test', 100000, 0.10, 'USD', now()),
  ('LOT-FB2', 'FB2', 'file', 'FB-2', 'FICHETEST02', 'MARQUE TEST', 5000, 0.12, 'USD', now());
insert into public.seller_addresses (org_id, label, address, city, country, is_default) values
  ('FB1', 'Usine', '1 rue fictive', 'Chongqing', 'CN', true);

-- Non-administrateur : refusé.
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
do $$ begin
  perform tests.fails('non-administrateur : fiche refusée', $s$select public.admin_supplier_profile('FB1')$s$, '42501');
  perform tests.fails('non-administrateur : enregistrement refusé', $s$select public.admin_supplier_profile_save('FB1', '{"staff": 1}')$s$, '42501');
end $$;
reset role;

-- Administrateur : saisie de la fiche, des contacts, puis publication.
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000e1';
do $$
declare r jsonb; a text := (select id from public.seller_addresses where org_id = 'FB1' limit 1);
begin
  perform tests.fails('page publique : refusée sans marque ni présentation', $s$select public.admin_supplier_publish('FB1', true)$s$, '22023');
  r := public.admin_supplier_profile_save('fb1', jsonb_build_object('founded_year', 2013, 'website', 'https://fabricant.example',
    'about', jsonb_build_object('fr', '  Présentation fictive.  ', 'en', 'Fictitious overview.', 'zh', '', 'de', 'ignoré'),
    'positioning', jsonb_build_object('en', 'Analog and discrete'), 'hq_city', 'Shenzhen', 'production_site', 'Chongqing',
    'area_m2', 12000, 'staff', 120, 'annual_units', 3000000000, 'revenue_usd', 70000000,
    'certifications', jsonb_build_array('ISO 9001', 'IATF 16949', 'ISO 9001', ' '), 'languages', jsonb_build_array('zh', 'en'),
    'payment_methods', jsonb_build_array('T/T'), 'min_order_usd', 50, 'brands', jsonb_build_array('Marque Test'),
    'brand_name', 'Fabricant Marque Test (fictif)'));
  perform tests.eq('fiche : présentation nettoyée (clés fr, en, zh, vides retirées)', r->'about', '{"fr": "Présentation fictive.", "en": "Fictitious overview."}'::jsonb);
  perform tests.eq('fiche : listes sans doublon ni vide', r->'certifications', '["IATF 16949", "ISO 9001"]'::jsonb);
  perform tests.eq('fiche : chiffres enregistrés', (r->>'annual_units') || ' ' || (r->>'staff') || ' ' || (r->>'revenue_usd'), '3000000000 120 70000000');
  perform tests.eq('fiche : publication possible', (r->>'can_publish')::boolean, true);
  perform tests.fails('fiche : site web sans http refusé', $s$select public.admin_supplier_profile_save('FB1', '{"website": "javascript:alert(1)"}')$s$, '22023');
  perform tests.fails('fiche : chiffre invalide refusé', $s$select public.admin_supplier_profile_save('FB1', '{"staff": "beaucoup"}')$s$, '22023');
  perform tests.fails('fiche : logo hors du dossier du fournisseur refusé', $s$select public.admin_supplier_profile_save('FB1', '{"logo_path": "FB2/logo.png"}')$s$, '22023');
  r := public.admin_supplier_profile_save('FB1', '{"logo_path": "FB1/logo-1.png"}');
  perform tests.eq('fiche : clé absente conservée', (r->>'founded_year') || ' ' || (r->>'logo_path'), '2013 FB1/logo-1.png');

  r := public.admin_seller_contact_save('FB1', jsonb_build_object('name', 'Contact fictif', 'role', 'Sales', 'email', ' Ventes@Fabricant.Example ',
    'address_id', a, 'languages', jsonb_build_array('en', 'zh'), 'for_rfq', true, 'for_po', true));
  perform tests.eq('contact : ajouté, e-mail en minuscules, préféré pour RFQ et commandes',
    (r->'contacts'->0->>'email') || ' ' || (r->'contacts'->0->>'for_rfq') || ' ' || (r->'contacts'->0->>'for_po'), 'ventes@fabricant.example true true');
  perform tests.fails('contact : e-mail invalide refusé', $s$select public.admin_seller_contact_save('FB1', '{"name": "X", "email": "pas-un-email"}')$s$, '22023');
  perform tests.fails('contact : nom obligatoire', $s$select public.admin_seller_contact_save('FB1', '{"name": " "}')$s$, '22023');
  perform tests.fails('contact : adresse d''un autre fournisseur refusée',
    format($s$select public.admin_seller_contact_save('FB2', '{"name": "X", "address_id": "%s"}')$s$, a), '22023');
  r := public.admin_seller_contact_save('FB1', jsonb_build_object('id', r->'contacts'->0->>'id', 'name', 'Contact fictif', 'email', 'rfq@fabricant.example', 'for_rfq', true));
  perform tests.eq('contact : modifié', (r->'contacts'->0->>'email') || ' ' || (r->'contacts'->0->>'for_po'), 'rfq@fabricant.example false');
  insert into tests.vars values ('contact', r->'contacts'->0->>'id');

  r := public.admin_supplier_publish('FB1', true);
  perform tests.eq('page publique : activée, au nom de l''administrateur', (r->>'public_page') || ' ' || (r->>'public_page_by'), 'true admin:ops1@example.test');
end $$;
reset role;

-- Page publique : présentation seulement, jamais de contact, d'adresse, de site web ni de chiffre d'affaires.
set role service_role;
do $$
declare p jsonb; o jsonb;
begin
  p := public.public_manufacturer('10.9.0.1', 'marque test');
  perform tests.eq('page publique : trouvée par la marque, insensible à la casse', p->>'brand', 'Marque Test');
  perform tests.eq('page publique : chiffres et présentation', (p->>'founded_year') || ' ' || (p->>'staff') || ' ' || (p->'about'->>'en'), '2013 120 Fictitious overview.');
  perform tests.eq('page publique : une offre en ligne du fabricant', (p->>'offers')::int, 1);
  perform tests.eq('page publique : ni contact, ni site, ni CA, ni identifiant, ni pseudonyme',
    p ?| array['contacts', 'website', 'revenue_usd', 'payment_methods', 'payment_terms', 'org_id', 'alias', 'min_order_usd'], false);
  perform tests.eq('page publique : aucune adresse e-mail dans la réponse', p::text ~ '@', false);
  perform tests.eq('page publique : marque inconnue', public.public_manufacturer('10.9.0.1', 'Inconnue'), null::jsonb);

  o := (select x from jsonb_array_elements(public.partner_offers('10.9.0.2', 'FICHETEST', 'USD')->'offers') x where x->>'mpn' = 'FICHETEST01');
  perform tests.eq('offres : lien vers la page et offre directe du fabricant', (o->>'brand_page') || ' ' || (o->>'factory_direct'), 'Marque Test true');
  o := (select x from jsonb_array_elements(public.partner_offers('10.9.0.2', 'FICHETEST', 'USD')->'offers') x where x->>'mpn' = 'FICHETEST02');
  perform tests.eq('offres : même marque chez un distributeur, lien sans offre directe', (o->>'brand_page') || ' ' || (o->>'factory_direct'), 'Marque Test false');
  perform tests.eq('offres : le distributeur reste anonyme', o->>'supplier', 'partner');
end $$;
reset role;

-- Page retirée, ou vidée de sa présentation : plus rien de public.
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000e1';
do $$
declare r jsonb;
begin
  r := public.admin_seller_contact_delete('FB1', (select v from tests.vars where k = 'contact'));
  perform tests.eq('contact : retiré', jsonb_array_length(r->'contacts'), 0);
  r := public.admin_supplier_profile_save('FB1', '{"about": {}}');
  perform tests.eq('présentation vidée : page publique retirée', (r->>'public_page')::boolean, false);
end $$;
reset role;
set role service_role;
do $$ begin
  perform tests.eq('page retirée : introuvable', public.public_manufacturer('10.9.0.3', 'Marque Test'), null::jsonb);
  perform tests.eq('page retirée : plus de lien dans les offres',
    (select count(*) from jsonb_array_elements(public.partner_offers('10.9.0.4', 'FICHETEST', 'USD')->'offers') x where x->>'brand_page' is not null)::int, 0);
end $$;
reset role;
do $$ begin
  perform tests.eq('journal : publication et modifications inscrites',
    (select count(*) from public.events where ref = 'FB1' and (text like 'Page fabricant publiée par admin:%' or text like 'Fiche société modifiée par admin:%'))::int >= 3, true);
end $$;

drop schema tests cascade;
select 'Tous les tests de la fiche fournisseur et de la page fabricant sont passés.' as resultat;
