-- Tests du back office /admin/ (ADR 0018) : accès réservé aux administrateurs, approbation, refus avec motif
-- obligatoire, remise en attente, journal d'audit en ajout seul, numéros de Hong Kong et de Chine continentale,
-- stocks en lecture seule. Prérequis : checks précédents (comptes de 01_rls.sql). Lancé par tools/test-db.sh.
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
grant usage on schema tests to authenticated, anon, service_role;
grant execute on all functions in schema tests to service_role, authenticated, anon;

-- Données fictives : une société de Chine continentale (18 caractères), une de Hong Kong (15 caractères),
-- un fichier de stock avec paliers de prix.
insert into public.organizations (id, type, name, alias, city, country, currency, lang, profile, registration_number,
                                  registration_region, kyb, registered_by, created_at) values
  ('BO-CN', 'seller', '深圳测试电子有限公司 (fictif)', 'P-BO-CN', '深圳', 'CN', 'CNH', 'zh', 'Distributor',
   '91440300MA5FDEM008', null, 'pending', 'oBO-CN', now() - interval '2 hours'),
  ('BO-HK', 'seller', '香港測試元件有限公司 (fictif)', 'P-BO-HK', 'Hong Kong', 'HK', 'USD', 'zh', 'Broker',
   '71234567-000-11', 'HK', 'pending', 'oBO-HK', now() - interval '1 hour');
insert into public.wechat_identities (openid, org_id, label, role) values ('oBO-CN', 'BO-CN', '王经理', 'admin');
insert into public.operators (openid, label) values ('oOPERATEUR', 'Opérateur de test');
insert into public.lots (id, seller_id, source, sku, mpn, manufacturer, qty, pack, unit_price, currency, lead_days) values
  ('LOT-BO1', 'BO-CN', 'file', 'BO-1', 'BOTEST358DR', 'Fabricant fictif', 2500, 'SOP-8', 0.05, 'CNH', 7),
  ('LOT-BO2', 'BO-CN', 'file', 'BO-2', 'BOTEST1117', 'Fabricant fictif', 0, 'SOT-223', 0.03, 'CNH', 7);
insert into public.lot_price_breaks (lot_id, min_qty, unit_price) values
  ('LOT-BO1', 1, 0.08), ('LOT-BO1', 100, 0.06), ('LOT-BO1', 1000, 0.05);
insert into public.stock_imports (org_id, storage_path, file_name, format, status, rows_total, created)
values ('BO-CN', 'BO-CN/stock-test.csv', 'stock-test.csv', 'csv', 'done', 2, 2);

-- 1. Accès refusé : visiteur anonyme, puis utilisateur connecté qui n'est pas de Central.Parts (broker S2).
set role anon;
do $$ begin
  begin perform public.admin_suppliers(); raise exception 'ÉCHEC liste lisible par anon';
  exception when insufficient_privilege then raise notice 'ok  accès refusé à un visiteur anonyme'; end;
  begin perform 1 from public.supplier_decisions; raise exception 'ÉCHEC journal lisible par anon';
  exception when insufficient_privilege then raise notice 'ok  journal inaccessible à un visiteur anonyme'; end;
end $$;
reset role;

set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
do $$ begin
  perform tests.fails('non-administrateur : identité refusée', 'select public.admin_me()', '42501');
  perform tests.fails('non-administrateur : liste refusée', 'select public.admin_suppliers()', '42501');
  perform tests.fails('non-administrateur : fiche refusée', $s$select public.admin_supplier('BO-CN')$s$, '42501');
  perform tests.fails('non-administrateur : approbation refusée', $s$select public.admin_approve('BO-CN')$s$, '42501');
  perform tests.fails('non-administrateur : refus refusé', $s$select public.admin_reject('BO-CN', 'x')$s$, '42501');
  perform tests.fails('non-administrateur : remise en attente refusée', $s$select public.admin_reset_pending('BO-CN')$s$, '42501');
  perform tests.fails('non-administrateur : stocks refusés', 'select public.admin_lots()', '42501');
  perform tests.eq('non-administrateur : journal vide (RLS)', (select count(*) from public.supplier_decisions), 0::bigint);
  begin perform public.reset_supplier_pending('BO-CN'); raise exception 'ÉCHEC remise en attente directe';
  exception when insufficient_privilege then raise notice 'ok  remise en attente réservée au serveur'; end;
end $$;
reset role;
do $$ begin
  perform tests.eq('non-administrateur : rien n''a changé', (select kyb from public.organizations where id = 'BO-CN'), 'pending');
end $$;

-- 2. Administrateur (ops1, membre de Central.Parts) : liste, fiche, numéros.
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000e1';
do $$
declare l jsonb; f jsonb; h jsonb;
begin
  perform tests.eq('administrateur : identité', public.admin_me()->>'email', 'ops1@example.test');
  l := public.admin_suppliers('pending');
  perform tests.eq('liste en attente : la plus récente d''abord',
    (select string_agg(e->>'org_id', ',' order by n) from jsonb_array_elements(l->'rows') with ordinality t(e, n)
      where e->>'org_id' like 'BO-%'), 'BO-HK,BO-CN');
  perform tests.eq('liste en attente : filtre', (select bool_and(e->>'status' = 'pending') from jsonb_array_elements(l->'rows') e), true);
  perform tests.eq('liste : compteurs par statut', (public.admin_suppliers()->'counts'->>'pending')::int >= 2, true);
  f := public.admin_supplier('BO-CN');
  perform tests.eq('fiche Chine : région CN (null lu comme Chine continentale)', f->>'region', 'CN');
  perform tests.eq('fiche Chine : numéro de 18 caractères', length(f->>'code'), 18);
  perform tests.eq('fiche Chine : contact WeChat', f->'contacts'->0->>'label', '王经理');
  perform tests.eq('fiche Chine : stock et dernier import', (f->'stock'->>'lines') || ' ' || (f->'last_import'->>'file_name'), '1 stock-test.csv');
  h := public.admin_supplier('BO-HK');
  perform tests.eq('fiche Hong Kong : région et numéro de 15 caractères', (h->>'region') || ' ' || length(h->>'code'), 'HK 15');
  perform tests.fails('fiche : société inconnue', $s$select public.admin_supplier('ORG-9999')$s$, 'P0002');
end $$;

-- 3. Refus sans motif impossible ; refus motivé ; approbation ; remise en attente ; réapprobation.
do $$
declare v_alias text;
begin
  perform tests.fails('refus sans motif', $s$select public.admin_reject('BO-HK', '')$s$, 'CP005');
  perform tests.fails('refus avec un motif blanc', $s$select public.admin_reject('BO-HK', '   ')$s$, 'CP005');
  perform tests.fails('refus avec un motif null', $s$select public.admin_reject('BO-HK', null)$s$, 'CP005');
  perform tests.eq('refus sans motif : statut inchangé', public.admin_supplier('BO-HK')->>'status', 'pending');
  perform public.admin_reject('BO-HK', 'Numéro d''immatriculation à vérifier');
  perform tests.eq('refus : statut et motif', (public.admin_supplier('BO-HK')->>'status') || ' / ' ||
    (public.admin_supplier('BO-HK')->>'rejected_reason'), 'rejected / Numéro d''immatriculation à vérifier');

  v_alias := public.admin_approve('BO-CN')->>'alias';
  perform tests.eq('approbation : pseudonyme V-n', v_alias ~ '^V-\d+$', true);
  perform tests.eq('approbation : société publiable', app.is_verified('BO-CN'), true);
  perform tests.fails('refus d''une société approuvée : la remettre en attente d''abord', $s$select public.admin_reject('BO-CN', 'x')$s$, 'P0002');
  perform public.admin_reset_pending('BO-CN', 'Licence à revoir');
  perform tests.eq('remise en attente : plus publiée', app.is_verified('BO-CN'), false);
  perform tests.fails('remise en attente : déjà en attente', $s$select public.admin_reset_pending('BO-CN')$s$, 'CP006');
  perform tests.eq('réapprobation : même pseudonyme', public.admin_approve('BO-CN')->>'alias', v_alias);
  perform tests.eq('approbation deux fois : sans effet', public.admin_approve('BO-CN')->>'alias', v_alias);
end $$;
reset role;

-- 4. Décision prise dans le robot WeChat (même fonction serveur) : inscrite au même journal.
set role service_role;
do $$ begin
  perform public.reset_supplier_pending('BO-HK', null, 'oOPERATEUR');
  perform public.reject_supplier('BO-HK', '', 'oOPERATEUR');
end $$;
reset role;

-- 5. Journal d'audit : qui, quand, quoi, motif ; dans l'ordre ; impossible à modifier ou à effacer.
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000e1';
do $$
declare d jsonb := public.admin_supplier('BO-CN')->'decisions'; k jsonb := public.admin_supplier('BO-HK')->'decisions';
begin
  perform tests.eq('journal Chine : trois décisions, la plus récente d''abord',
    (select string_agg(e->>'action', ',' order by n) from jsonb_array_elements(d) with ordinality t(e, n)), 'approved,pending,approved');
  perform tests.eq('journal : auteur = e-mail de l''administrateur', d->0->>'by', 'ops1@example.test');
  perform tests.eq('journal : statut avant et motif de la remise en attente', (d->1->>'from_status') || ' / ' || (d->1->>'reason'), 'validated / Licence à revoir');
  perform tests.eq('journal : date renseignée', (d->0->>'at') is not null, true);
  perform tests.eq('journal Hong Kong : refus motivé du back office conservé',
    (select e->>'reason' from jsonb_array_elements(k) e where e->>'by' = 'ops1@example.test' and e->>'action' = 'rejected'), 'Numéro d''immatriculation à vérifier');
  perform tests.eq('journal : décision du robot attribuée à l''opérateur WeChat', k->0->>'by', 'WeChat · Opérateur de test');
  perform tests.eq('journal lisible par l''administrateur (RLS)', (select count(*) from public.supplier_decisions where org_id in ('BO-CN', 'BO-HK')), 6::bigint);
end $$;
reset role;
do $$ begin
  perform tests.fails('journal : modification interdite', $s$update public.supplier_decisions set reason = 'x'$s$, 'P0001');
  perform tests.fails('journal : suppression interdite', $s$delete from public.supplier_decisions$s$, 'P0001');
end $$;

-- 6. Stocks : résumé par fournisseur, recherche, paliers « de … à … ».
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000e1';
do $$
declare s jsonb; r jsonb;
begin
  s := (select e from jsonb_array_elements(public.admin_stock_summary()) e where e->>'org_id' = 'BO-CN');
  perform tests.eq('stocks : une référence en stock, dernier import, devise', (s->>'lines') || ' ' || (s->>'last_import_file') || ' ' || (s->>'currency'), '1 stock-test.csv CNH');
  r := public.admin_lots('BO-CN');
  perform tests.eq('stocks : toutes les références du fournisseur', (r->>'total')::int, 2);
  perform tests.eq('recherche par boîtier', (public.admin_lots(null, 'sop-8')->'rows'->0->>'mpn'), 'BOTEST358DR');
  perform tests.eq('recherche par marque', (public.admin_lots('BO-CN', 'fictif')->>'total')::int, 2);
  perform tests.eq('recherche : % pris littéralement', (public.admin_lots(null, '%')->>'total')::int, 0);
  perform tests.eq('paliers : de 1 à 99, de 100 à 999, 1000 et plus',
    (select jsonb_agg(b) from jsonb_array_elements(public.admin_lots(null, 'BOTEST358DR')->'rows'->0->'breaks') b),
    '[{"from": 1, "to": 99, "price": 0.08}, {"from": 100, "to": 999, "price": 0.06}, {"from": 1000, "to": null, "price": 0.05}]'::jsonb);
  perform tests.eq('pagination : 200 lignes au plus', (select jsonb_array_length(public.admin_lots(null, '', 10000)->'rows')) <= 200, true);
end $$;
reset role;

drop schema tests cascade;
select 'Tous les tests du back office sont passés.' as resultat;
