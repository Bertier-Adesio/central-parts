-- Tests des demandes d'achat (ADR 0014). Prérequis : checks précédents. Lancé par tools/test-db.sh.
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
grant all on tests.vars to service_role;

-- Offre fictive : S4 (surplus, CN), XC2S50-5TQ144C, 500 pièces à 300 CNH, palier 100 pièces à 250 CNH ; marge 10 %.
insert into app.price_rules (category, margin_pct) values ('surplus', 10), ('broker', 10)
on conflict (category) do update set margin_pct = excluded.margin_pct;
insert into public.lot_price_breaks (lot_id, min_qty, unit_price)
select id, 100, 250 from public.lots where seller_id = 'S4' and upper(mpn) = 'XC2S50-5TQ144C';
-- Contact WeChat du fournisseur S4 (et d'un autre fournisseur).
insert into public.wechat_identities (openid, org_id, role) values ('oS4', 'S4', 'admin'), ('oS2', 'S2', 'admin')
on conflict (openid) do nothing;

set role service_role;
do $$
declare q jsonb; r jsonb; v jsonb := '{"mpn": "xc2s50-5tq144c", "source": "surplus", "ship_from": "CN", "qty": "200",
  "currency": "EUR", "company": "Atelier Test (fictif)", "vat": "FR 12 345678901", "name": "Jeanne Test",
  "email": "achats@example.com", "country": "fr", "address": "1 rue de l''Exemple, 69000 Lyon"}';
begin
  -- Devis : palier de 100 pièces appliqué, converti en EUR, marge incluse.
  q := public.public_quote('XC2S50-5TQ144C', 'surplus', 'CN', 200, 'EUR');
  perform tests.eq('devis : palier 250 CNH → EUR (0,128) + 10 %', (q->>'unit_price')::numeric, 35.2000);
  perform tests.eq('devis : total', (q->>'total')::numeric, 7040.00);
  perform tests.eq('devis : quantité couverte, sans révéler le stock', q - 'unit_price' - 'total', '{"qty": 200, "covered": true, "currency": "EUR"}'::jsonb);
  perform tests.eq('devis : au-delà du stock, non couvert', public.public_quote('XC2S50-5TQ144C', 'surplus', 'CN', 900, 'EUR')->>'covered', 'false');
  perform tests.fails('devis : offre inconnue', $s$select public.public_quote('NEXISTEPAS', 'surplus', 'CN', 1, 'EUR')$s$, 'P0002');

  -- Demande d'achat.
  perform tests.fails('demande : numéro de TVA invalide', format('select public.create_purchase_request(%L, %L)', '198.51.100.1', jsonb_set(v, '{vat}', '"123"')), '22023');
  perform tests.fails('demande : e-mail invalide', format('select public.create_purchase_request(%L, %L)', '198.51.100.1', jsonb_set(v, '{email}', '"x"')), '22023');
  r := public.create_purchase_request('198.51.100.1', v);
  insert into tests.vars values ('ref', r->>'ref'), ('token', r->>'token');
  perform tests.eq('demande : référence PR-', left(r->>'ref', 3), 'PR-');
  perform tests.eq('demande : même prix que le devis', (r->>'unit_price')::numeric, 35.2000);
  perform tests.eq('demande : TVA normalisée, pays en majuscules',
    (select buyer_vat || ' ' || delivery_country || ' ' || supplier_unit_price::numeric(10,2) || ' ' || supplier_currency from public.purchase_requests where id = r->>'ref'),
    'FR12345678901 FR 250.00 CNH');
  perform tests.eq('demande : jeton gardé sous forme d''empreinte', (select count(*) from public.purchase_requests where access_hash = r->>'token'), 0::bigint);
end $$;
reset role;

-- Marge propre au vendeur S4 dans le devis.
insert into app.seller_margins (org_id, margin_pct) values ('S4', 20);
set role service_role;
do $$ begin
  perform tests.eq('devis : marge du vendeur (20 %)', (public.public_quote('XC2S50-5TQ144C', 'surplus', 'CN', 200, 'EUR')->>'unit_price')::numeric, 38.4000);
end $$;
reset role;
delete from app.seller_margins;

-- Fournisseur : voit la demande sans l'acheteur, confirme ; un autre fournisseur ne peut pas répondre.
set role service_role;
do $$
declare v_ref text := (select v from tests.vars where k = 'ref'); s jsonb;
begin
  s := public.supplier_requests('oS4')->0;
  perform tests.eq('fournisseur : sa demande, avec son prix net', s->>'ref' || ' ' || (s->>'unit_price')::numeric(10,2) || ' ' || (s->>'currency'), v_ref || ' 250.00 CNH');
  perform tests.eq('fournisseur : jamais l''acheteur', s::text ~* 'atelier|achats@|FR12345', false);
  perform tests.eq('autre fournisseur : rien', jsonb_array_length(public.supplier_requests('oS2')), 0);
  perform tests.fails('autre fournisseur : réponse refusée', format('select public.supplier_answer(%L, %L, true)', 'oS2', v_ref), 'P0002');
  perform tests.eq('fournisseur : confirmation', public.supplier_answer('oS4', lower(v_ref), true)->>'status', 'confirmed');
  perform tests.eq('fournisseur : seconde réponse sans effet', public.supplier_answer('oS4', v_ref, false)->>'status', 'confirmed');
end $$;
reset role;

-- Opérateur puis acheteur.
set role service_role;
do $$
declare v_ref text := (select v from tests.vars where k = 'ref'); v_tok text := (select v from tests.vars where k = 'token'); o jsonb; b jsonb;
begin
  o := public.operator_set_request_status(v_ref, 'proforma_sent', 'test');
  perform tests.eq('opérateur : fiche complète', o->>'buyer_email' || ' ' || (o->>'supplier'), 'achats@example.com S4 V-4');
  perform tests.fails('opérateur : statut inconnu', format('select public.operator_set_request_status(%L, %L)', v_ref, 'livré'), '22023');
  b := public.purchase_request_status(v_ref, v_tok);
  perform tests.eq('acheteur : suivi avec son jeton', b->>'status', 'proforma_sent');
  perform tests.eq('acheteur : jamais le fournisseur', b::text ~* 'S4|V-4|seller|lot', false);
  perform tests.eq('acheteur : jeton faux, rien', public.purchase_request_status(v_ref, 'faux'), null::jsonb);
end $$;
reset role;

-- Limite : 5 demandes par heure et par adresse.
set role service_role;
do $$
declare i int; v jsonb := '{"mpn": "XC2S50-5TQ144C", "source": "surplus", "ship_from": "CN", "qty": "1", "company": "A",
  "vat": "DE123456789", "name": "B", "email": "b@example.com", "country": "DE", "address": "C"}';
begin
  for i in 1..4 loop perform public.create_purchase_request('198.51.100.1', v); end loop;
  perform tests.fails('limite : 5 demandes par heure', format('select public.create_purchase_request(%L, %L)', '198.51.100.1', v), 'CP429');
end $$;
reset role;

-- Droits : rien d'accessible sans le serveur ; un utilisateur connecté ne lit pas les demandes.
set role anon;
do $$ begin
  begin perform public.public_quote('XC2S50-5TQ144C', 'surplus', 'CN', 1); raise exception 'ÉCHEC devis direct par anon';
  exception when insufficient_privilege then raise notice 'ok  devis réservé à la fonction Edge'; end;
end $$;
reset role;
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b1';
do $$ begin
  perform tests.eq('acheteur connecté : aucune demande lisible', (select count(*) from public.purchase_requests), 0::bigint);
end $$;
reset role;

delete from app.price_rules;
drop schema tests cascade;
select 'Tous les tests des demandes d''achat sont passés.' as resultat;
