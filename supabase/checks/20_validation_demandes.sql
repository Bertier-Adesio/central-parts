-- Tests de la validation des demandes d'achat par l'administrateur (migration 20261103000024, ADR 0026).
-- Prérequis : checks précédents (fournisseur fictif S4, administrateur fictif e1). Lancé par tools/test-db.sh.
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

insert into app.price_rules (category, margin_pct) values ('surplus', 10) on conflict (category) do update set margin_pct = 10;
insert into public.wechat_identities (openid, org_id, role) values ('oS4', 'S4', 'admin') on conflict (openid) do nothing;

-- Deux demandes fictives : l'une sera refusée, l'autre validée.
set role service_role;
do $$
declare v jsonb := '{"mpn": "XC2S50-5TQ144C", "source": "surplus", "ship_from": "CN", "qty": "50", "currency": "EUR",
  "company": "Atelier Validation (fictif)", "vat": "FR98765432109", "name": "Paul Test", "email": "pv@example.com",
  "country": "FR", "address": "2 rue de l''Exemple, 75000 Paris"}';
  a jsonb; b jsonb;
begin
  a := public.create_purchase_request('198.51.100.20', v);
  b := public.create_purchase_request('198.51.100.20', v);
  insert into tests.vars values ('a', a->>'ref'), ('a_tok', a->>'token'), ('b', b->>'ref');
  perform tests.eq('nouvelle demande : en attente de validation', (select status from public.purchase_requests where id = a->>'ref'), 'pending_validation');
  perform tests.eq('en attente : invisible pour le fournisseur',
    (select count(*) from jsonb_array_elements(public.supplier_requests('oS4')) e where e->>'ref' in (a->>'ref', b->>'ref'))::int, 0);
  perform tests.fails('en attente : le fournisseur ne peut pas répondre', format('select public.supplier_answer(%L, %L, true)', 'oS4', a->>'ref'), 'P0002');
  perform tests.eq('en attente : l''acheteur voit le statut', public.purchase_request_status(a->>'ref', a->>'token')->>'status', 'pending_validation');
  perform tests.fails('décision : demande inconnue', $s$select public.decide_purchase_request('PR-999999', true, 'test')$s$, 'P0002');
  perform tests.fails('refus : motif obligatoire', format('select public.decide_purchase_request(%L, false, %L, %L)', a->>'ref', 'test', '  '), 'CP005');
end $$;
reset role;

-- Droits : anon et utilisateur ordinaire refusés.
set role anon;
do $$ begin
  begin perform public.admin_requests(); raise exception 'ÉCHEC liste lisible par anon';
  exception when insufficient_privilege then raise notice 'ok  liste des demandes refusée à anon'; end;
  begin perform public.decide_purchase_request('PR-1', true, 'x'); raise exception 'ÉCHEC décision par anon';
  exception when insufficient_privilege then raise notice 'ok  décision refusée à anon'; end;
end $$;
reset role;
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
do $$ begin
  perform tests.fails('non-administrateur : liste refusée', 'select public.admin_requests()', '42501');
  perform tests.fails('non-administrateur : validation refusée', format('select public.admin_request_approve(%L)', (select v from tests.vars where k = 'b')), '42501');
end $$;
reset role;

-- Administrateur : liste, refus de A, validation de B.
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000e1';
do $$
declare va text := (select v from tests.vars where k = 'a'); vb text := (select v from tests.vars where k = 'b'); l jsonb; d jsonb;
begin
  l := public.admin_requests();
  perform tests.eq('liste : les deux demandes en attente', (select count(*) from jsonb_array_elements(l->'rows') e where e->>'ref' in (va, vb))::int, 2);
  perform tests.eq('liste : fiche complète, origine site', (select e->>'origin' || ' ' || (e->>'buyer_email') || ' ' || (e->>'seller_id')
    from jsonb_array_elements(l->'rows') e where e->>'ref' = va), 'site pv@example.com S4');
  perform tests.eq('liste : compteur', (l->'counts'->>'pending_validation')::int >= 2, true);
  d := public.admin_request_reject(va, 'Demande de test');
  perform tests.eq('refus : statut et motif', d->>'status' || ' / ' || (d->>'reject_reason'), 'rejected / Demande de test');
  perform tests.eq('refus : auteur', d->>'decided_by', 'admin:ops1@example.test');
  perform tests.eq('refus : rien pour le fournisseur', d->'supplier_view', 'null'::jsonb);
  perform tests.fails('seconde décision refusée', format('select public.admin_request_approve(%L)', va), 'CP409');
  d := public.admin_request_approve(lower(vb));
  perform tests.eq('validation : en attente du fournisseur', d->>'status', 'submitted');
  perform tests.eq('validation : vue fournisseur sans l''acheteur', (d->'supplier_view')::text ~* 'pv@|Atelier|FR98765', false);
  perform tests.eq('validation : vue fournisseur avec son prix', d->'supplier_view'->>'ref' || ' ' || (d->'supplier_view'->>'currency'), vb || ' CNH');
  perform tests.eq('liste filtrée : refusées', (select count(*) from jsonb_array_elements(public.admin_requests('rejected')->'rows') e where e->>'ref' = va)::int, 1);
  perform tests.eq('liste complète (null)', (select count(*) from jsonb_array_elements(public.admin_requests(null)->'rows') e where e->>'ref' in (va, vb))::int, 2);
end $$;
reset role;

-- Après décision : le fournisseur voit et répond à B seulement ; l'acheteur de A voit « refusée », jamais le motif.
set role service_role;
do $$
declare va text := (select v from tests.vars where k = 'a'); vb text := (select v from tests.vars where k = 'b'); b jsonb;
begin
  perform tests.eq('fournisseur : B visible, A non', (select string_agg(e->>'ref', ',') from jsonb_array_elements(public.supplier_requests('oS4')) e
    where e->>'ref' in (va, vb)), vb);
  perform tests.eq('fournisseur : répond à B', public.supplier_answer('oS4', vb, true)->>'status', 'confirmed');
  perform tests.fails('fournisseur : A refusée, pas de réponse', format('select public.supplier_answer(%L, %L, true)', 'oS4', va), 'P0002');
  b := public.purchase_request_status(va, (select v from tests.vars where k = 'a_tok'));
  perform tests.eq('acheteur : statut refusé', b->>'status', 'rejected');
  perform tests.eq('acheteur : jamais le motif', b::text ~* 'Demande de test|reject_reason', false);
  perform tests.eq('journal : décisions inscrites', (select count(*) from public.events where text like 'Demande ' || va || ' refusée%' or text like 'Demande ' || vb || ' validée%')::int, 2);
end $$;
reset role;

delete from app.price_rules;
drop schema tests cascade;
select 'Tous les tests de la validation des demandes d''achat sont passés.' as resultat;
