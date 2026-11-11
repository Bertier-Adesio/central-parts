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
  perform tests.fails('contact principal sans nom : refusé',
    format($s$select public.register_supplier('oIP-X', 'Société X (fictive)', null, null, 'Spot', 'USD', null, '%slicence-20261111-090000.jpg', null, null, null, null, '[{"phone": "13800000000"}]')$s$,
      app.pending_doc_prefix('oIP-X')), 'CP004');
  perform tests.fails('photo hors du dossier du compte : refusée',
    $s$select public.register_supplier('oIP-X', 'Société X (fictive)', null, null, 'Spot', 'USD', null, 'ORG-0101/licence-20261111-090000.jpg')$s$, 'CP004');
  perform tests.fails('photo déposée par un autre compte : refusée',
    format($s$select public.register_supplier('oIP-X', 'Société X (fictive)', null, null, 'Spot', 'USD', null, '%slicence-20261111-090000.jpg')$s$, app.pending_doc_prefix('oIP-AUTRE')), 'CP004');
  perform tests.fails('devise inconnue : refusée', $s$select public.register_supplier('oIP-X', 'Société X (fictive)', '91350100M000100Y43', null, 'Spot', 'XYZ', 'CN')$s$, 'CP004');

  -- Stock disponible, photo seule : ni numéro, ni ville, ni région.
  -- Inscription minimale : nom, profil, une pièce, nom du contact principal, devise ; tout le reste vide.
  w := public.register_supplier('oIP-SPOT', ' Société spot (fictive) ', null, null, 'Spot', 'cnh', null, p || 'licence-20261111-090000.jpg',
    null, null, null, null, '[{"family_name": "王", "given_name": ""}, {"family_name": "", "given_name": "", "phone": "", "email": ""}]', 'surplus');
  select * into o from public.organizations where id = w->>'org_id';
  insert into tests.vars values ('spot', o.id);
  perform tests.eq('photo seule : inscrite, profil Spot, sans numéro ni ville', o.profile || ' ' || o.currency || ' ' || coalesce(o.registration_number, '-') || ' '
    || coalesce(o.city, '-') || ' ' || coalesce(o.registration_region, '-') || ' ' || o.kyb || ' ' || (o.alias ~ '^P-[0-9A-F]{12}$')::text, 'Spot CNH - - - pending true');
  perform tests.eq('pièce fournie : licence', app.verification_piece(o), 'license');
  perform tests.eq('stock disponible : origine indiquée par le fournisseur', o.spot_hint, 'surplus');
  -- Marques : séparateurs chinois et occidentaux, doublons sans tenir compte de la casse (8A).
  perform tests.eq('marques normalisées', app.norm_brands(' Marque A，marque a、 Marque B ; Marque C/ '), 'Marque A, Marque B, Marque C');
  perform tests.eq('marques vides', app.norm_brands(' ，、 '), null::text);
  -- Ville d'après le code de la division administrative du 统一社会信用代码 (2A).
  perform tests.eq('ville d''après le numéro : Shenzhen, Fuzhou, Pékin ; inconnue : vide',
    concat_ws(' ', app.city_from_code('91440300MA5F00002D'), app.city_from_code('91350100M000100Y43'), app.city_from_code('91110108MA00000000'),
      coalesce(app.city_from_code('91999900MA00000000'), '-'), coalesce(app.city_from_code('12345678'), '-')), '深圳 福州 北京 - -');
  perform tests.eq('identité du dépôt : profil et pièce', (w->>'profile') || ' ' || (w->>'has_license') || ' ' || (w->>'has_code'), 'Spot true false');
  perform tests.eq('inscription minimale : un seul contact (ligne vide ignorée), principal, relié au robot',
    (select count(*) || ' ' || min(c.name) || ' ' || min(c.duty) || ' ' || bool_and(app.contact_linked(c))::text from public.seller_contacts c where c.org_id = o.id), '1 王 main true');
  perform tests.eq('ce qui manque : numéro, région, ville, site web, WeChat pro, coordonnées',
    array_to_string(app.signup_missing(o.id), ','), 'number,region,city,website,wecom,contact');

  -- Distributeur, numéro seul, marques et lettre d'agrément.
  w := public.register_supplier('oIP-DIST', 'Distributeur (fictif)', '91440300MA5F00002D', null, 'Distributor', 'USD', 'CN', null,
    '  Marque A,  Marque B ', app.pending_doc_prefix('oIP-DIST') || 'agrement-20261111-090000.pdf', 'exemple-fictif.cn', '示例公众号',
    '[{"family_name": "Li", "given_name": "Wei", "role": "经理", "phone": "+86 138 0000 0000", "wechat": "liwei_fictif", "email": "pas-un-email"},
      {"family_name": "陈", "given_name": "小姐", "duty": "sales", "email": "sales@exemple.test"},
      {"family_name": "", "given_name": "", "wechat": "logistique_fictif", "duty": "logistics"},
      {"family_name": "赵", "given_name": "", "duty": "finance"},
      {"family_name": "Cinquième", "duty": "other"}]');
  select * into o from public.organizations where id = w->>'org_id';
  insert into tests.vars values ('dist', o.id);
  perform tests.eq('tout rempli : site web complété (https), WeChat pro, 4 contacts au plus',
    o.website || ' ' || o.wecom || ' ' || (select count(*) from public.seller_contacts where org_id = o.id), 'https://exemple-fictif.cn 示例公众号 4');
  perform tests.eq('contacts : principal « Li Wei », rôles, e-mail mal formé gardé, contact sans nom nommé par son WeChat',
    (select string_agg(c.name || '/' || c.duty, ' ' order by c.created_at, c.id) from public.seller_contacts c where c.org_id = o.id) || ' '
    || (select email from public.seller_contacts where org_id = o.id and duty = 'main'),
    'Li Wei/main 陈小姐/sales logistique_fictif/logistics 赵/finance pas-un-email');
  perform tests.eq('contacts supplémentaires : non reliés au robot tant qu''ils n''ont pas accepté d''invitation',
    (select string_agg(app.contact_linked(c)::text, ' ' order by c.created_at, c.id) from public.seller_contacts c where c.org_id = o.id), 'true false false false');
  perform tests.eq('ville déduite du numéro chinois quand elle est vide', o.city, '深圳');
  perform tests.eq('numéro seul : inscrite, marques et lettre gardées', app.verification_piece(o) || ' ' || o.declared_brands || ' ' || (o.auth_letter_path is not null)::text
    || ' ' || o.registration_region || ' ' || o.country, 'number Marque A, Marque B true CN CN');

  -- Fabricant, les deux pièces ; un Spot ne garde pas de marques.
  w := public.register_supplier('oIP-FAB', 'Fabricant (fictif)', '91110000MA0000004X', 'Shenzhen', 'Manufacturer', 'USD', 'CN',
    app.pending_doc_prefix('oIP-FAB') || 'licence-20261111-090000.png', 'Marque F');
  insert into tests.vars values ('fab', w->>'org_id');
  w := public.register_supplier('oIP-FAB2', 'Fabricant 2 (fictif)', null, null, 'Manufacturer', 'EUR', null,
    app.pending_doc_prefix('oIP-FAB2') || 'licence-20261111-090000.jpg');
  insert into tests.vars values ('fab2', w->>'org_id');
  perform tests.eq('fabricant sans marque : accepté, signalé comme manquant', array_to_string(app.signup_missing(w->>'org_id'), ','),
    'number,region,city,brands,website,wecom,contact');
  perform tests.eq('photo et numéro : les deux', (select app.verification_piece(x) from public.organizations x where x.id = (select v from tests.vars where k = 'fab')), 'both');
  perform tests.eq('commande pending : profil, pièce, marques',
    (select string_agg((x->>'profile') || '/' || (x->>'piece') || '/' || coalesce(x->>'brands', '-'), ' ' order by x->>'name' collate "C")
       from jsonb_array_elements(public.pending_suppliers()) x where x->>'org_id' in (select v from tests.vars)),
    'Distributor/number/Marque A, Marque B Manufacturer/both/Marque F Manufacturer/license/- Spot/license/-');

  -- Compléter sa fiche avant l'approbation : numéro, région, ville, marques, site web, WeChat pro.
  perform public.supplier_signup_save('oIP-FAB2', '{"code": "91440300MA5F00004K", "region": "CN", "city": "Dongguan", "brands": "Marque G",
    "website": "http://exemple.test", "wecom": "公众号", "name": "Fabricant 2 renommé (fictif)"}');
  select * into o from public.organizations where id = (select v from tests.vars where k = 'fab2');
  perform tests.eq('avant l''approbation : tout se complète, y compris le nom et le numéro',
    o.name || ' ' || o.registration_number || ' ' || o.city || ' ' || o.declared_brands || ' ' || o.website, 'Fabricant 2 renommé (fictif) 91440300MA5F00004K Dongguan Marque G http://exemple.test');
  perform tests.fails('numéro invalide refusé', $s$select public.supplier_signup_save('oIP-FAB2', '{"code": "123"}')$s$, 'CP001');
  perform tests.fails('autre compte : refusé', $s$select public.supplier_signup_save('oIP-INCONNU', '{"city": "X"}')$s$, '42501');

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
  perform tests.eq('approbation avec une seule pièce : inscrite au journal', (select reason from public.supplier_decisions where org_id = o.id and action = 'approved'),
    'pièce unique : licence');
  perform tests.eq('message d''accueil : catégorie surplus', public.supplier_welcome(o.id)->>'category', 'surplus');
  -- Les autres profils : approbation sans sous-catégorie (ignorée si donnée).
  perform public.approve_supplier((select v from tests.vars where k = 'fab'), 'test', 'broker');
  perform tests.eq('fabricant : sous-catégorie ignorée, profil inchangé', (select profile from public.organizations where id = (select v from tests.vars where k = 'fab')), 'Manufacturer');
  perform tests.eq('approbation avec les deux pièces : rien de signalé',
    (select reason from public.supplier_decisions where org_id = (select v from tests.vars where k = 'fab') and action = 'approved'), null::text);
  -- Après l'approbation : le nom, le profil et le numéro ne changent plus seuls ; ville, site et WeChat pro, si.
  perform public.approve_supplier((select v from tests.vars where k = 'fab2'), 'test');
  perform public.supplier_signup_save('oIP-FAB2', '{"name": "Autre nom", "profile": "Spot", "code": "91110000MA0000002P", "city": "Shenzhen", "website": "exemple2.test"}');
  select * into o from public.organizations where id = (select v from tests.vars where k = 'fab2');
  perform tests.eq('après l''approbation : nom, profil et numéro inchangés, ville et site modifiés',
    o.name || ' ' || o.profile || ' ' || o.registration_number || ' ' || o.city || ' ' || o.website,
    'Fabricant 2 renommé (fictif) Manufacturer 91440300MA5F00004K Shenzhen https://exemple2.test');
  perform public.set_supplier_license(o.id, o.id || '/licence-autre.jpg');
  perform tests.eq('après l''approbation : licence inchangée', (select license_path from public.organizations where id = o.id) like 'pending/%', true);
  perform tests.eq('validité : 14 jours pour un fabricant, 7 pour un surplus',
    extract(day from app.seller_ttl((select v from tests.vars where k = 'fab')))::int || ' ' || extract(day from app.seller_ttl((select v from tests.vars where k = 'spot')))::int, '14 7');
end $$;

with m as (insert into public.manufacturers (name, brands) values ('Fabricant inscription (fictif)', array['Marque A']) returning id)
insert into tests.vars select 'mfr', id from m;

-- Coordonnées des contacts : jamais lisibles par un visiteur ni par un compte acheteur (RLS, aucun droit).
set role anon;
do $$ begin perform tests.fails('visiteur : contacts illisibles', $s$select count(*) from public.seller_contacts$s$, '42501'); end $$;
reset role;
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
do $$ begin perform tests.fails('compte non administrateur : contacts illisibles', $s$select count(*) from public.seller_contacts$s$, '42501'); end $$;
reset role;

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
  perform tests.eq('fiche d''inscription : site, WeChat pro, contacts et liaison au robot, ce qui manque',
    (s->>'website') || ' ' || (s->>'wecom') || ' ' || jsonb_array_length(s->'contacts') || ' ' || (s->'contacts'->0->>'linked') || ' ' || (s->'contacts'->1->>'linked')
    || ' ' || (select string_agg(x, ',') from jsonb_array_elements_text(s->'missing') x),
    'https://exemple-fictif.cn 示例公众号 4 true false license');
  perform tests.eq('liste des fournisseurs : ce qui manque à chaque fiche',
    (select x->'missing' from jsonb_array_elements(public.admin_suppliers('pending')->'rows') x where x->>'org_id' = d), s->'missing');
  perform tests.eq('fabricant reconnu d''après les marques déclarées', exists (select 1 from jsonb_array_elements(s->'brand_matches') x
    where x->>'name' = 'Fabricant inscription (fictif)'), true);
  s := public.admin_supplier_complete(d, '{"city": "Shenzhen", "region": "CN"}');
  perform tests.eq('compléments : ville et région', (s->>'city') || ' ' || (s->>'region'), 'Shenzhen CN');
  -- Distributeur rattaché à un fabricant, puis reclassé en stock disponible : le rattachement disparaît.
  perform public.admin_manufacturer_link(m, d, 'authorized');
  perform tests.eq('distributeur rattaché', jsonb_typeof(public.admin_manufacturer(m)), 'object');
  perform tests.eq('rattaché : plus proposé, rattachement listé', exists (select 1 from jsonb_array_elements(public.admin_supplier_signup(d)->'brand_matches') x
    where x->>'name' = 'Fabricant inscription (fictif)')::text || ' ' || (public.admin_supplier_signup(d)->'links'->0->>'name'), 'false Fabricant inscription (fictif)');
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

-- Coordonnées des contacts : aucune vue acheteur, aucune réponse de l'API d'offres, aucun journal (5A).
insert into public.lots (id, seller_id, mpn, manufacturer, qty, unit_price, currency) values
  ('LOT-IP2', (select v from tests.vars where k = 'dist'), 'IPCONTACT1', 'Marque A', 100, 1, 'USD');
do $$
declare blob text;
begin
  blob := concat_ws(' | ', public.public_search('10.9.9.1', 'IPCONTACT1')::text, public.partner_offers('10.9.9.1', 'IPCONTACT1')::text,
    public.catalog_search('B1', '{"mpn": "IPCONTACT1"}')::text, public.catalog_offers('B1', 'IPCONTACT1')::text,
    (select string_agg(text, ' ') from public.events));
  perform tests.eq('vues acheteurs, API d''offres, journal : aucune coordonnée de contact',
    blob ~ '(Li Wei|liwei_fictif|138 0000 0000|pas-un-email|sales@exemple\.test|logistique_fictif|陈小姐)', false);
end $$;

-- Nettoyage.
delete from public.lots where id in ('LOT-IP1', 'LOT-IP2');
delete from public.manufacturers where id = (select v from tests.vars where k = 'mfr');
delete from public.wechat_identities where openid like 'oIP-%';
drop schema tests cascade;
select 'Tous les tests de l''inscription par profil sont passés.' as resultat;
