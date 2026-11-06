-- Tests de la recherche payante de composants rares (migration 20261106000040). Acheteurs et demandes fictifs.
-- Prérequis : checks précédents (administrateur fictif e1). Lancé par tools/test-db.sh.
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


set role service_role;
do $$
declare fr jsonb; de jsonb; us jsonb; s jsonb;
begin
  fr := public.create_sourcing_request('10.9.7.1', '{"mpn": " cm8071505024905 ", "qty": "10", "company": "Acheteur FR (fictif)", "contact": "Contact fictif",
    "email": "Achat@Exemple.Test", "country": "fr", "vat": "FR 12 345678901", "vat_checked": true, "needed_by": "2026-12-01", "target_price": "120"}');
  insert into tests.vars values ('fr', fr->>'id'), ('fr_tok', fr->>'token');
  perform tests.eq('France : 49 € HT, TVA 20 %, 58,80 € TTC', (fr->>'amount_ht') || ' ' || (fr->>'vat_rate') || ' ' || (fr->>'amount_ttc'), '4900 0.20 5880');
  perform tests.eq('référence en capitales, sans espaces autour', fr->>'mpn', 'CM8071505024905');
  de := public.create_sourcing_request('10.9.7.1', '{"mpn": "X1", "qty": 5, "company": "Acheteur DE (fictif)", "contact": "K", "email": "k@exemple.test", "country": "DE", "vat": "DE123456789"}');
  perform tests.eq('autre pays de l''Union : autoliquidation', (de->>'amount_ttc')::int, 4900);
  us := public.create_sourcing_request('10.9.7.1', '{"mpn": "X2", "qty": 5, "company": "Acheteur US (fictif)", "contact": "K", "email": "k@exemple.test", "country": "US"}');
  perform tests.eq('hors Union : sans TVA, numéro facultatif', (us->>'amount_ttc')::int, 4900);
  perform tests.fails('Union sans numéro de TVA : refusé', $s$select public.create_sourcing_request('10.9.7.1', '{"mpn": "X", "qty": 1, "company": "A", "contact": "B", "email": "a@b.test", "country": "IT"}')$s$, '22023');
  perform tests.fails('quantité invalide : refusée', $s$select public.create_sourcing_request('10.9.7.1', '{"mpn": "X", "qty": 0, "company": "A", "contact": "B", "email": "a@b.test", "country": "US"}')$s$, '22023');
  perform tests.fails('e-mail invalide : refusé', $s$select public.create_sourcing_request('10.9.7.1', '{"mpn": "X", "qty": 1, "company": "A", "contact": "B", "email": "pas-un-email", "country": "US"}')$s$, '22023');

  -- Paiement : session Stripe, puis confirmation par le webhook (une seule fois, montant contrôlé).
  perform public.sourcing_set_session(fr->>'id', 'cs_test_fictif_1');
  perform tests.eq('montant différent : paiement refusé', public.sourcing_mark_paid('cs_test_fictif_1', 4900), null::jsonb);
  s := public.sourcing_mark_paid('cs_test_fictif_1', 5880);
  perform tests.eq('paiement confirmé : demande payée, avis aux opérateurs', (s->>'id') || ' ' || (s->>'mpn'), (fr->>'id') || ' CM8071505024905');
  perform tests.eq('paiement rejoué : sans effet', public.sourcing_mark_paid('cs_test_fictif_1', 5880), null::jsonb);
  s := public.sourcing_status(fr->>'token');
  perform tests.eq('suivi : état payé, sans note interne ni e-mail', (s->>'status') || ' ' || (s ?| array['admin_note', 'email', 'token_hash', 'stripe_session'])::text, 'paid false');
  perform tests.eq('suivi : jeton inconnu', public.sourcing_status('inconnu'), null::jsonb);
end $$;
reset role;

-- Back office : liste (payées seulement par défaut), avancement, notes, déduction sur une commande.
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
do $$ begin perform tests.fails('non-administrateur : refusé', $s$select public.admin_sourcing_list()$s$, '42501'); end $$;
reset role;
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000e1';
do $$
declare l jsonb := public.admin_sourcing_list(); id text := (select v from tests.vars where k = 'fr'); r jsonb;
begin
  perform tests.eq('liste : demandes payées seulement, sans jeton ni session', (select count(*) from jsonb_array_elements(l->'rows') x
    where x->>'status' = 'awaiting_payment' or x ? 'token_hash' or x ? 'stripe_session')::int || ' ' || ((l->'counts'->>'awaiting_payment')::int >= 2)::text, '0 true');
  r := public.admin_sourcing_update(id, '{"status": "offers_sent", "admin_note": "Trois brokers consultés.", "buyer_note": "Deux offres envoyées par e-mail.", "credit_used_by": "pr-0042"}');
  perform tests.eq('avancement, notes et déduction enregistrés', (r->>'status') || ' ' || (r->>'credit_used_by') || ' ' || (r->>'updated_by'), 'offers_sent PR-0042 admin:ops1@example.test');
  perform tests.fails('état inconnu refusé', format($s$select public.admin_sourcing_update('%s', '{"status": "perdu"}')$s$, id), '22023');
end $$;
reset role;
set role service_role;
do $$
declare s jsonb := public.sourcing_status((select v from tests.vars where k = 'fr_tok'));
begin
  perform tests.eq('suivi : note acheteur et déduction visibles, pas la note interne', (s->>'buyer_note') || ' ' || (s->>'credit_used') || ' ' || (s::text ~ 'brokers consultés')::text,
    'Deux offres envoyées par e-mail. true false');
end $$;
reset role;

drop schema tests cascade;
select 'Tous les tests de la recherche payante sont passés.' as resultat;
