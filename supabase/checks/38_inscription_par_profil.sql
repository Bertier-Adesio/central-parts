-- Tests de l'inscription par profil (migration 20261111000044, ADR 0034) : 3 profils, photo de la licence OU numéro,
-- marques déclarées, lettre d'agrément, rien de publié avant l'approbation, sous-catégorie obligatoire pour un
-- stock disponible (Spot), fiche complétée par l'administrateur, jamais de rattachement pour un Spot, durées de
-- validité inchangées, informations du message d'accueil. Comptes et sociétés fictifs. Lancé par tools/test-db.sh.
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
create table if not exists tests.vars (k text primary key, v text);
grant all on tests.vars to service_role, authenticated;

-- Comme le fait la fonction Edge depot (clé de service) ; lancé ici avec tous les droits pour lire aussi les fonctions app.*.
do $$
declare w jsonb; p text; o public.organizations;
begin
  -- Pièce déposée avant l'inscription : dossier propre au compte.
  p := app.pending_doc_prefix('oIP-SPOT');
  perform tests.eq('dossier des pièces : pending/ + empreinte de 32 caractères', p ~ '^pending/[0-9a-f]{32}/$', true);
  perform tests.fails('ni photo ni numéro : refusé', $s$select public.register_supplier('oIP-X', 'Société X (fictive)', null, null, 'Spot', 'USD')$s$, 'CP008');
  perform tests.fails('fabricant sans marque : refusé', $s$select public.register_supplier('oIP-X', 'Société X (fictive)', '91350100M000100Y43', null, 'Manufacturer', 'USD', 'CN')$s$, 'CP004');
  perform tests.fails('photo hors du dossier du compte : refusée',
    $s$select public.register_supplier('oIP-X', 'Société X (fictive)', null, null, 'Spot', 'USD', null, 'ORG-0101/licence-20261111-090000.jpg')$s$, 'CP004');
  perform tests.fails('photo déposée par un autre compte : refusée',
    format($s$select public.register_supplier('oIP-X', 'Société X (fictive)', null, null, 'Spot', 'USD', null, '%slicence-20261111-090000.jpg')$s$, app.pending_doc_prefix('oIP-AUTRE')), 'CP004');
  perform tests.fails('devise inconnue : refusée', $s$select public.register_supplier('oIP-X', 'Société X (fictive)', '91350100M000100Y43', null, 'Spot', 'XYZ', 'CN')$s$, 'CP004');

  -- Stock disponible, photo seule : ni numéro, ni ville, ni région.
  w := public.register_supplier('oIP-SPOT', ' Société spot (fictive) ', null, null, 'Spot', 'cnh', null, p || 'licence-20261111-090000.jpg');
  select * into o from public.organizations where id = w->>'org_id';
  insert into tests.vars values ('spot', o.id);
  perform tests.eq('photo seule : inscrite, profil Spot, sans numéro ni ville', o.profile || ' ' || o.currency || ' ' || coalesce(o.registration_number, '-') || ' '
    || coalesce(o.city, '-') || ' ' || coalesce(o.registration_region, '-') || ' ' || o.kyb || ' ' || (o.alias ~ '^P-[0-9A-F]{12}$')::text, 'Spot CNH - - - pending true');
  perform tests.eq('pièce fournie : licence', app.verification_piece(o), 'license');
  perform tests.eq('identité du dépôt : profil et pièce', (w->>'profile') || ' ' || (w->>'has_license') || ' ' || (w->>'has_code'), 'Spot true false');

  -- Distributeur, numéro seul, marques et lettre d'agrément.
  w := public.register_supplier('oIP-DIST', 'Distributeur (fictif)', '91440300MA5F00002D', null, 'Distributor', 'USD', 'CN', null,
    '  Marque A,  Marque B ', app.pending_doc_prefix('oIP-DIST') || 'agrement-20261111-090000.pdf');
  select * into o from public.organizations where id = w->>'org_id';
  insert into tests.vars values ('dist', o.id);
  perform tests.eq('numéro seul : inscrite, marques et lettre gardées', app.verification_piece(o) || ' ' || o.declared_brands || ' ' || (o.auth_letter_path is not null)::text
    || ' ' || o.registration_region || ' ' || o.country, 'number Marque A, Marque B true CN CN');

  -- Fabricant, les deux pièces ; un Spot ne garde pas de marques.
  w := public.register_supplier('oIP-FAB', 'Fabricant (fictif)', '91110000MA0000004X', 'Shenzhen', 'Manufacturer', 'USD', 'CN',
    app.pending_doc_prefix('oIP-FAB') || 'licence-20261111-090000.png', 'Marque F');
  insert into tests.vars values ('fab', w->>'org_id');
  perform tests.eq('photo et numéro : les deux', (select app.verification_piece(x) from public.organizations x where x.id = w->>'org_id'), 'both');
  perform tests.eq('commande pending : profil, pièce, marques',
    (select string_agg((x->>'profile') || '/' || (x->>'piece') || '/' || coalesce(x->>'brands', '-'), ' ' order by x->>'name')
       from jsonb_array_elements(public.pending_suppliers()) x where x->>'org_id' in (select v from tests.vars)),
    'Distributor/number/Marque A, Marque B Manufacturer/both/Marque F Spot/license/-');

  -- Rien n'est publié avant l'approbation.
  insert into public.lots (id, seller_id, mpn, manufacturer, qty, unit_price, currency) values
    ('LOT-IP1', (select v from tests.vars where k = 'spot'), 'IPTEST1', 'Fabricant fictif', 100, 1, 'USD');
  perform tests.eq('en attente : non publiée', app.is_verified((select v from tests.vars where k = 'spot')), false);

  -- Approbation d'un Spot : sous-catégorie obligatoire.
  perform tests.fails('Spot sans sous-catégorie : approbation refusée', format($s$select public.approve_supplier('%s', 'test')$s$, (select v from tests.vars where k = 'spot')), 'CP007');
  perform tests.fails('Spot, sous-catégorie inconnue : refusée', format($s$select public.approve_supplier('%s', 'test', 'grossiste')$s$, (select v from tests.vars where k = 'spot')), 'CP007');
  perform public.approve_supplier((select v from tests.vars where k = 'spot'), 'test', 'surplus');
  select * into o from public.organizations where id = (select v from tests.vars where k = 'spot');
  perform tests.eq('Spot approuvé comme surplus : profil, catégorie, publiée', o.profile || ' ' || app.source_category(o.profile) || ' ' || app.is_verified(o.id)::text, 'Surplus surplus true');
  perform tests.eq('choix inscrit au journal', (select reason from public.supplier_decisions where org_id = o.id and action = 'profile'), 'Spot → Surplus');
  perform tests.eq('message d''accueil : catégorie surplus', public.supplier_welcome(o.id)->>'category', 'surplus');
  -- Les autres profils : approbation sans sous-catégorie (ignorée si donnée).
  perform public.approve_supplier((select v from tests.vars where k = 'fab'), 'test', 'broker');
  perform tests.eq('fabricant : sous-catégorie ignorée, profil inchangé', (select profile from public.organizations where id = (select v from tests.vars where k = 'fab')), 'Manufacturer');
  perform tests.eq('validité : 14 jours pour un fabricant, 7 pour un surplus',
    extract(day from app.seller_ttl((select v from tests.vars where k = 'fab')))::int || ' ' || extract(day from app.seller_ttl((select v from tests.vars where k = 'spot')))::int, '14 7');
end $$;

with m as (insert into public.manufacturers (name, brands) values ('Fabricant inscription (fictif)', array['Marque A']) returning id)
insert into tests.vars select 'mfr', id from m;

-- Back office : fiche d'inscription, compléments, changement de profil, rattachements.
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
do $$ begin
  perform tests.fails('non-administrateur : fiche d''inscription refusée', format($s$select public.admin_supplier_signup('%s')$s$, (select v from tests.vars where k = 'dist')), '42501');
  perform tests.fails('non-administrateur : compléments refusés', format($s$select public.admin_supplier_complete('%s', '{}')$s$, (select v from tests.vars where k = 'dist')), '42501');
end $$;
reset role;
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000e1';
do $$
declare d text := (select v from tests.vars where k = 'dist'); s jsonb; m text := (select v from tests.vars where k = 'mfr');
begin
  s := public.admin_supplier_signup(d);
  perform tests.eq('fiche d''inscription : profil, pièce, marques, lettre', (s->>'profile') || ' ' || (s->>'piece') || ' ' || (s->>'brands') || ' ' || (s->>'has_auth_letter'),
    'Distributor number Marque A, Marque B true');
  s := public.admin_supplier_complete(d, '{"city": "Shenzhen", "region": "CN"}');
  perform tests.eq('compléments : ville et région', (s->>'city') || ' ' || (s->>'region'), 'Shenzhen CN');
  -- Distributeur rattaché à un fabricant, puis reclassé en stock disponible : le rattachement disparaît.
  perform public.admin_manufacturer_link(m, d, 'authorized');
  perform tests.eq('distributeur rattaché', jsonb_typeof(public.admin_manufacturer(m)), 'object');
  s := public.admin_supplier_complete(d, '{"profile": "Spot"}');
  perform tests.eq('reclassé en Spot', s->>'profile', 'Spot');
  perform tests.fails('Spot : rattachement à un fabricant refusé', format($s$select public.admin_manufacturer_link('%s', '%s', 'authorized')$s$, m, d), '22023');
  perform tests.fails('Spot : approbation sans sous-catégorie refusée (back office)', format($s$select public.admin_approve('%s')$s$, d), 'CP007');
  s := public.admin_approve(d, 'broker');
  perform tests.eq('approuvé comme broker depuis le back office', (select profile from public.organizations where id = d), 'Broker');
  perform tests.fails('approuvée : plus de compléments', format($s$select public.admin_supplier_complete('%s', '{"city": "X"}')$s$, d), 'P0002');
  perform tests.fails('profil inconnu refusé', format($s$select public.admin_supplier_complete('%s', '{"profile": "Grossiste"}')$s$,
    (select id from public.organizations where kyb = 'pending' and type = 'seller' limit 1)), '22023');
end $$;
reset role;

-- Reclassement : journalisé, rattachement retiré. Sociétés inscrites avant : profils d'origine inchangés.
do $$ begin
  perform tests.eq('reclassé en Spot : journalisé, rattachement retiré',
    (select count(*) from public.manufacturer_distributors where org_id = (select v from tests.vars where k = 'dist'))::text || ' '
    || (select string_agg(reason, ' | ' order by at, id) from public.supplier_decisions where org_id = (select v from tests.vars where k = 'dist') and action = 'profile'),
    '0 Distributor → Spot | Spot → Broker');
  perform tests.eq('profils existants inchangés', (select count(*) from public.organizations where profile = 'Spot' and kyb = 'validated')::int, 0);
end $$;

-- Nettoyage.
delete from public.lots where id = 'LOT-IP1';
delete from public.manufacturers where id = (select v from tests.vars where k = 'mfr');
delete from public.wechat_identities where openid like 'oIP-%';
drop schema tests cascade;
select 'Tous les tests de l''inscription par profil sont passés.' as resultat;
