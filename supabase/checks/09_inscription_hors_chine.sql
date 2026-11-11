-- Tests de l'inscription des sociétés de Hong Kong et d'autres pays (migration 20261102000013).
-- Prérequis : checks précédents. Lancé par tools/test-db.sh. Numéros fictifs.
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
grant usage on schema tests to service_role;
grant execute on all functions in schema tests to service_role;

-- Règle du numéro selon le pays / région.
do $$ begin
  perform tests.eq('Chine : 18 caractères valides acceptés', app.registration_number_ok('CN', '91350100M000100Y43'), true);
  perform tests.eq('Chine : 15 caractères refusés', app.registration_number_ok('CN', '123456789012345'), false);
  perform tests.eq('Hong Kong : 15 caractères acceptés', app.registration_number_ok('HK', '123456789012345'), true);
  perform tests.eq('Hong Kong : 8 chiffres acceptés', app.registration_number_ok('HK', '12345678'), true);
  perform tests.eq('autre pays : lettres, tiret, barre oblique, espace', app.registration_number_ok('OTHER', 'HRB 12345/B-1'), true);
  perform tests.eq('Hong Kong : 4 caractères refusés', app.registration_number_ok('HK', '1234'), false);
  perform tests.eq('Hong Kong : 31 caractères refusés', app.registration_number_ok('HK', repeat('1', 31)), false);
  perform tests.eq('Hong Kong : caractère interdit refusé', app.registration_number_ok('HK', '12345678#'), false);
  perform tests.eq('Hong Kong : seulement des tirets refusés', app.registration_number_ok('HK', '-----'), false);
  perform tests.eq('vide refusé', app.registration_number_ok('HK', ''), false);
  perform tests.eq('région inconnue refusée', app.registration_number_ok('FR', '12345678'), false);
end $$;

set role service_role;
do $$
declare who jsonb;
begin
  -- Hong Kong : numéro de 15 caractères, avec espaces et minuscules normalisés.
  who := public.register_supplier('oHK1', 'Société HK (fictive)', ' 1234 5678  90123 ', 'Hong Kong', 'Manufacturer', 'HKD', 'HK', null, 'Marque fictive');
  perform tests.eq('Hong Kong : inscription en attente', who->>'status', 'pending');
  perform tests.eq('Hong Kong : région, pays, devise et numéro normalisé',
    (select registration_region || ' ' || country || ' ' || currency || ' ' || registration_number from public.organizations where id = who->>'org_id'),
    'HK HK HKD 1234 5678 90123');
  perform tests.eq('opérateur : région dans la liste des sociétés en attente',
    (select e->>'region' from jsonb_array_elements(public.pending_suppliers()) e where e->>'org_id' = who->>'org_id'), 'HK');

  -- Autre pays : pays laissé vide, complété par l'opérateur.
  who := public.register_supplier('oAUTRE9', 'Société étrangère (fictive)', 'hrb-2026/77', 'Singapore', 'Distributor', 'USD', 'OTHER', null, 'Marque fictive');
  perform tests.eq('autre pays : région OTHER, pays à compléter',
    (select registration_region || ' ' || coalesce(country, '(vide)') || ' ' || registration_number from public.organizations where id = who->>'org_id'),
    'OTHER (vide) HRB-2026/77');

  -- Chine continentale : règle inchangée.
  perform tests.fails('Chine : numéro de 15 caractères refusé', $s$select public.register_supplier('oCN15', 'Société CN', '123456789012345', 'Shenzhen', 'Broker', 'CNH', 'CN')$s$, 'CP001');
  who := public.register_supplier('oCN18', 'Société CN (fictive)', '91440300MA5F00001A', 'Shanghai', 'Broker', 'CNH', 'CN');
  perform tests.eq('Chine : 18 caractères acceptés, pays CN', (select registration_region || ' ' || country from public.organizations where id = who->>'org_id'), 'CN CN');

  -- Champs obligatoires.
  perform tests.fails('numéro vide et sans photo : refusé (l''un des deux requis)', $s$select public.register_supplier('oVIDE', 'Société', '', 'Hong Kong', 'Broker', 'USD', 'HK')$s$, 'CP008');
  perform tests.fails('pays / région vide refusé', $s$select public.register_supplier('oVIDE', 'Société', '12345678', 'Hong Kong', 'Broker', 'USD', '')$s$, 'CP004');
  perform tests.fails('pays / région inconnu refusé', $s$select public.register_supplier('oVIDE', 'Société', '12345678', 'Paris', 'Broker', 'USD', 'FR')$s$, 'CP004');
  perform tests.fails('même numéro de Hong Kong une seconde fois', $s$select public.register_supplier('oHK2', 'Copie', '1234 5678 90123', 'Hong Kong', 'Broker', 'USD', 'HK')$s$, 'CP002');

  -- Page restée en cache, sans le champ : Chine continentale par défaut, comme avant.
  perform tests.fails('sans région : règle chinoise appliquée', $s$select public.register_supplier('oCACHE', 'Société', '12345678', 'Hong Kong', 'Broker')$s$, 'CP001');
end $$;
reset role;

-- Les sociétés inscrites avant la migration ne sont pas modifiées.
do $$ begin
  perform tests.eq('sociétés existantes : région laissée vide',
    (select count(*) from public.organizations where registration_region is null and registered_by is null and id in ('S1', 'S2', 'S3', 'S4')), 4::bigint);
end $$;

drop schema tests cascade;
select 'Tous les tests de l''inscription hors de Chine continentale sont passés.' as resultat;
