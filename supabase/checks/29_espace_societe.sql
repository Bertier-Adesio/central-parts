-- Tests de l'espace fournisseur : fiche société, contacts, corrections proposées et accord (migration 20261106000035).
-- Société, fabricant et comptes WeChat fictifs. Prérequis : checks précédents (administrateur fictif e1). Lancé par tools/test-db.sh.
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
  ('ES1', 'seller', 'Société de distribution (fictive)', 'tmp-ES1', 'Shenzhen', 'CN', 'USD', 'zh', 'Distributor', 'pending'),
  ('ES2', 'seller', 'Autre société (fictive)', 'tmp-ES2', 'Hong Kong', 'HK', 'USD', 'en', 'Distributor', 'pending');
select public.approve_supplier('ES1', 'test'), public.approve_supplier('ES2', 'test');
insert into public.wechat_identities (openid, org_id, role, label) values
  ('oES-admin', 'ES1', 'admin', 'Responsable'), ('oES-member', 'ES1', 'member', 'Collègue'), ('oES2-admin', 'ES2', 'admin', 'Autre');
-- Second administrateur WeChat de la même société, rattaché plus tard : pas responsable de la fiche.
insert into public.wechat_identities (openid, org_id, role, label, bound_at) values ('oES-admin2', 'ES1', 'admin', 'Second', now() + interval '1 minute');

-- Fabricant rattaché à ES1, saisi par Central.Parts (chiffre d'affaires et site web internes).
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000e1';
do $$
declare m jsonb;
begin
  m := public.admin_manufacturer_save(null, jsonb_build_object('name', 'Fabricant ES (fictif)', 'brands', jsonb_build_array('Marque ES'),
    'about', jsonb_build_object('en', 'Fictitious.'), 'staff', 100, 'revenue_usd', 5000000, 'website', 'https://fabricant-es.example'));
  insert into tests.vars values ('m', m->>'id');
  perform public.admin_manufacturer_link(m->>'id', 'ES1', 'self');
end $$;
reset role;

set role service_role;
do $$
declare m text := (select v from tests.vars where k = 'm'); c jsonb;
begin
  c := public.supplier_company('oES-member');
  perform tests.eq('membre : lecture, sans droit de modifier', (c->>'name') || ' · ' || (c->>'can_edit'), 'Société de distribution (fictive) · false');
  perform tests.eq('fabricant rattaché visible, sans CA ni site web', (c->'manufacturers'->0->>'name') || ' · ' || (c->'manufacturers'->0 ?| array['revenue_usd', 'website'])::text,
    'Fabricant ES (fictif) · false');
  perform tests.fails('membre : modification refusée', $s$select public.supplier_company_save('oES-member', '{"staff": 5}')$s$, '42501');
  perform tests.fails('compte inconnu refusé', $s$select public.supplier_company('inconnu')$s$, '42501');
  perform tests.eq('second administrateur : lecture seule', (public.supplier_company('oES-admin2')->>'can_edit')::boolean, false);
  perform tests.fails('second administrateur : modification refusée', $s$select public.supplier_company_save('oES-admin2', '{"staff": 5}')$s$, '42501');

  -- Fiche société : le fournisseur ne touche pas aux champs réservés à Central.Parts.
  c := public.supplier_company_save('oES-admin', '{"staff": 170, "revenue_usd": 1, "languages": ["zh", "en"], "about": {"zh": "虚构公司。"}}');
  perform tests.eq('fiche société enregistrée par le fournisseur', (c->>'staff') || ' ' || (c->'about'->>'zh') || ' ' || (c->>'can_edit'), '170 虚构公司。 true');
  perform tests.eq('chiffre d''affaires non modifiable par le fournisseur', (select revenue_usd from public.organizations where id = 'ES1'), null::numeric);
  perform tests.fails('site web invalide refusé', $s$select public.supplier_company_save('oES-admin', '{"website": "ftp://x"}')$s$, '22023');

  -- Contacts.
  c := public.supplier_contact_save('oES-admin', '{"name": "Contact ES (fictif)", "email": "Ventes@ES.Example", "for_rfq": true, "for_po": true}');
  perform tests.eq('contact ajouté par le fournisseur', (c->'contacts'->0->>'email') || ' ' || (c->'contacts'->0->>'for_po'), 'ventes@es.example true');
  perform tests.fails('contact d''une autre société : refusé', format($s$select public.supplier_contact_delete('oES2-admin', '%s')$s$, c->'contacts'->0->>'id'), 'P0002');
  c := public.supplier_contact_delete('oES-admin', c->'contacts'->0->>'id');
  perform tests.eq('contact retiré', jsonb_array_length(c->'contacts'), 0);

  -- Corrections proposées : enregistrées, pas appliquées.
  c := public.supplier_manufacturer_propose('oES-admin', m, '{"staff": "120", "about": {"zh": "虚构的制造商。"}, "revenue_usd": 9}', 'Merci de corriger.');
  perform tests.eq('correction en attente', (c->'manufacturers'->0->>'pending')::boolean, true);
  perform tests.eq('correction non appliquée avant validation', (select staff from public.manufacturers where id = m), 100);
  perform tests.eq('champs non prévus écartés', (select proposed ? 'revenue_usd' from public.manufacturer_proposals where manufacturer_id = m and status = 'pending'), false);
  perform tests.fails('fabricant non rattaché : proposition refusée', format($s$select public.supplier_manufacturer_propose('oES2-admin', '%s', '{"staff": "1"}')$s$, m), '42501');
  perform tests.fails('proposition vide refusée', format($s$select public.supplier_manufacturer_propose('oES-admin', '%s', '{}')$s$, m), '22023');

  -- Accord.
  c := public.supplier_manufacturer_consent('oES-admin', m, true);
  perform tests.eq('accord enregistré', (c->'manufacturers'->0->>'consent_at') is not null, true);
  perform tests.eq('accord au nom du compte WeChat', (select consent_by from public.manufacturer_distributors where manufacturer_id = m and org_id = 'ES1'), 'wechat:oES-admin');
  perform tests.fails('membre : accord refusé', format($s$select public.supplier_manufacturer_consent('oES-member', '%s', true)$s$, m), '42501');
end $$;
reset role;

-- Back office : correction appliquée, publication possible avec l'accord, retrait de l'accord.
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000e1';
do $$
declare m text := (select v from tests.vars where k = 'm'); j jsonb;
begin
  j := public.admin_manufacturer(m);
  perform tests.eq('back office : proposition et accord visibles', jsonb_array_length(j->'proposals') || ' ' || (j->'distributors'->0->>'consent_by') || ' ' || (j->>'can_publish'),
    '1 wechat:oES-admin true');
  j := public.admin_manufacturer_proposal_decide((j->'proposals'->0->>'id')::bigint, true);
  perform tests.eq('correction appliquée', (j->>'staff') || ' ' || (j->'about'->>'zh') || ' ' || (j->'about'->>'en') || ' ' || jsonb_array_length(j->'proposals'),
    '120 虚构的制造商。 Fictitious. 0');
  j := public.admin_manufacturer_publish(m, true);
  perform tests.eq('page publiée avec l''accord', (j->>'public_page')::boolean, true);
end $$;
reset role;
set role service_role;
do $$
declare m text := (select v from tests.vars where k = 'm');
begin
  perform public.supplier_manufacturer_consent('oES-admin', m, false);
  perform tests.eq('accord retiré : page retirée', (select public_page from public.manufacturers where id = m), false);
end $$;
reset role;
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000e1';
do $$
declare m text := (select v from tests.vars where k = 'm'); j jsonb;
begin
  j := public.admin_manufacturer_consent(m, 'ES1', true);
  perform tests.eq('accord hors plateforme enregistré par l''administrateur', j->'distributors'->0->>'consent_by', 'admin:ops1@example.test (hors plateforme)');
  perform tests.fails('accord sur un compte non rattaché refusé', format($s$select public.admin_manufacturer_consent('%s', 'ES2', true)$s$, m), 'P0002');
  -- Responsable de la fiche désigné par Central.Parts : un seul à la fois.
  j := public.admin_set_profile_editor('ES1', 'oES-member');
  perform tests.eq('responsable désigné, devenu administrateur', (j->>'profile_editor') || ' ' || (select role from public.wechat_identities where openid = 'oES-member'),
    'oES-member admin');
  perform tests.fails('compte d''une autre société refusé', $s$select public.admin_set_profile_editor('ES1', 'oES2-admin')$s$, 'P0002');
end $$;
reset role;

set role service_role;
do $$ begin
  perform tests.eq('ancien responsable : lecture seule', (public.supplier_company('oES-admin')->>'can_edit')::boolean, false);
  perform tests.eq('nouveau responsable : modification', (public.supplier_company_save('oES-member', '{"staff": 171}')->>'staff'), '171');
end $$;
reset role;

drop schema tests cascade;
select 'Tous les tests de l''espace fournisseur sont passés.' as resultat;
