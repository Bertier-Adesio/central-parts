-- Tests de la fiche société d'un fournisseur et de ses contacts (migrations 20261105000032 et 033). Société et contacts
-- fictifs. Prérequis : checks précédents (administrateur fictif e1). Lancé par tools/test-db.sh.
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


insert into public.organizations (id, type, name, alias, city, country, currency, lang, profile, kyb) values
  ('FB1', 'seller', 'Distributeur de démonstration (fictif)', 'tmp-FB1', 'Shenzhen', 'CN', 'USD', 'zh', 'Distributor', 'pending'),
  ('FB2', 'seller', 'Autre distributeur (fictif)', 'tmp-FB2', 'Hong Kong', 'HK', 'USD', 'en', 'Distributor', 'pending');
select public.approve_supplier('FB1', 'test'), public.approve_supplier('FB2', 'test');
insert into public.seller_addresses (org_id, label, address, city, country, is_default) values
  ('FB1', 'Entrepôt', '1 rue fictive', 'Shenzhen', 'CN', true);

-- Non-administrateur : refusé.
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
do $$ begin
  perform tests.fails('non-administrateur : fiche refusée', $s$select public.admin_supplier_profile('FB1')$s$, '42501');
  perform tests.fails('non-administrateur : enregistrement refusé', $s$select public.admin_supplier_profile_save('FB1', '{"staff": 1}')$s$, '42501');
end $$;
reset role;

set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000e1';
do $$
declare r jsonb; a text := (select id from public.seller_addresses where org_id = 'FB1' limit 1);
begin
  r := public.admin_supplier_profile_save('fb1', jsonb_build_object('founded_year', 2012, 'website', 'https://distributeur.example',
    'about', jsonb_build_object('fr', '  Présentation fictive.  ', 'en', 'Fictitious overview.', 'zh', '', 'de', 'ignoré'),
    'staff', 170, 'revenue_usd', 1000000, 'certifications', jsonb_build_array('ISO 9001', 'ISO 9001', ' '),
    'languages', jsonb_build_array('zh', 'en'), 'payment_methods', jsonb_build_array('T/T'), 'min_order_usd', 50));
  perform tests.eq('fiche : présentation nettoyée (clés fr, en, zh, vides retirées)', r->'about', '{"fr": "Présentation fictive.", "en": "Fictitious overview."}'::jsonb);
  perform tests.eq('fiche : listes sans doublon ni vide', r->'certifications', '["ISO 9001"]'::jsonb);
  perform tests.eq('fiche : chiffres enregistrés', (r->>'staff') || ' ' || (r->>'revenue_usd') || ' ' || (r->>'min_order_usd'), '170 1000000 50');
  perform tests.eq('fiche : aucun fabricant rattaché', jsonb_array_length(r->'manufacturers'), 0);
  perform tests.fails('fiche : site web sans http refusé', $s$select public.admin_supplier_profile_save('FB1', '{"website": "javascript:alert(1)"}')$s$, '22023');
  perform tests.fails('fiche : chiffre invalide refusé', $s$select public.admin_supplier_profile_save('FB1', '{"staff": "beaucoup"}')$s$, '22023');
  r := public.admin_supplier_profile_save('FB1', '{"payment_terms": "Net 30"}');
  perform tests.eq('fiche : clé absente conservée', (r->>'founded_year') || ' ' || (r->>'payment_terms'), '2012 Net 30');

  r := public.admin_seller_contact_save('FB1', jsonb_build_object('name', 'Contact fictif', 'role', 'Sales', 'email', ' Ventes@Distributeur.Example ',
    'address_id', a, 'languages', jsonb_build_array('en', 'zh'), 'for_rfq', true, 'for_po', true));
  perform tests.eq('contact : ajouté, e-mail en minuscules, préféré pour RFQ et commandes',
    (r->'contacts'->0->>'email') || ' ' || (r->'contacts'->0->>'for_rfq') || ' ' || (r->'contacts'->0->>'for_po'), 'ventes@distributeur.example true true');
  -- Depuis l'ADR 0034, un e-mail mal formé est signalé par la page (avertissement) mais n'empêche pas l'enregistrement.
  perform tests.eq('contact : e-mail mal formé accepté (avertissement dans la page)',
    (select count(*) from jsonb_array_elements(public.admin_seller_contact_save('FB1', '{"name": "X", "email": "pas-un-email"}')->'contacts') c where c->>'email' = 'pas-un-email')::int, 1);
  perform public.admin_seller_contact_delete('FB1', (select c->>'id' from jsonb_array_elements(public.admin_supplier_profile('FB1')->'contacts') c where c->>'email' = 'pas-un-email'));
  perform tests.fails('contact : nom obligatoire', $s$select public.admin_seller_contact_save('FB1', '{"name": " "}')$s$, '22023');
  perform tests.fails('contact : adresse d''un autre fournisseur refusée',
    format($s$select public.admin_seller_contact_save('FB2', '{"name": "X", "address_id": "%s"}')$s$, a), '22023');
  r := public.admin_seller_contact_save('FB1', jsonb_build_object('id', r->'contacts'->0->>'id', 'name', 'Contact fictif', 'email', 'rfq@distributeur.example', 'for_rfq', true));
  perform tests.eq('contact : modifié', (r->'contacts'->0->>'email') || ' ' || (r->'contacts'->0->>'for_po'), 'rfq@distributeur.example false');
  r := public.admin_seller_contact_delete('FB1', r->'contacts'->0->>'id');
  perform tests.eq('contact : retiré', jsonb_array_length(r->'contacts'), 0);
end $$;
reset role;
do $$ begin
  perform tests.eq('journal : modifications inscrites',
    (select count(*) from public.events where ref = 'FB1' and (text like 'Fiche société modifiée par admin:%' or text like 'Contact% par admin:%'))::int >= 4, true);
end $$;

drop schema tests cascade;
select 'Tous les tests de la fiche société sont passés.' as resultat;
