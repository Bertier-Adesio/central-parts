-- Tests de 20261102000016 : liens, fiches techniques, descriptions et délais des références (ADR 0022).
-- Le lien du vendeur, la fiche technique et la description sont gardés et visibles des administrateurs, mais aucune
-- fonction publique ne les renvoie. Prérequis : checks précédents (comptes de 01_rls.sql). Lancé par tools/test-db.sh.
\set ON_ERROR_STOP 1

create schema if not exists tests;
create or replace function tests.eq(label text, got anyelement, want anyelement) returns void language plpgsql as $$
begin
  if got is distinct from want then raise exception 'ÉCHEC % : obtenu %, attendu %', label, got, want; end if;
  raise notice 'ok  %', label;
end $$;
grant usage on schema tests to service_role, authenticated, anon;
grant execute on all functions in schema tests to service_role, authenticated, anon;

-- Import chez un vendeur vérifié du jeu de données (S2, broker de Hong Kong) : ses offres sont publiques.
insert into public.stock_imports (id, org_id, storage_path, file_name, format, replace_all)
values ('IMP-T16A', 'S2', 'S2/liens-a.csv', 'liens-a.csv', 'csv', false);
set role service_role;
do $$
declare res jsonb;
begin
  res := public.apply_stock_import_batch('IMP-T16A', '[
    {"line": 2, "mpn": "LIEN16-A", "sku": "L16A", "qty": "500", "price": "1.5", "tiers": {"100": "1.2"}, "lead": "3",
     "url": "https://vendeur-secret.example/produit/LIEN16-A", "datasheet": "https://fabricant.example/ds/LIEN16-A.pdf",
     "desc": "Régulateur LDO 3,3 V — vendeur-secret.example"},
    {"line": 3, "mpn": "LIEN16-B", "sku": "L16B", "qty": "800", "price": "0.5", "lead": "999"}]'::jsonb);
  perform tests.eq('import : 2 références créées', res->>'created', '2');
end $$;
reset role;
do $$ begin
  perform tests.eq('lien du vendeur, fiche technique, description et délai gardés',
    (select product_url || ' | ' || datasheet_url || ' | ' || description || ' | ' || lead_days from public.lots where seller_id = 'S2' and sku = 'L16A'),
    'https://vendeur-secret.example/produit/LIEN16-A | https://fabricant.example/ds/LIEN16-A.pdf | Régulateur LDO 3,3 V — vendeur-secret.example | 3');
  perform tests.eq('délai au-delà d''un an : non gardé', (select lead_days from public.lots where seller_id = 'S2' and sku = 'L16B'), null::smallint);
end $$;

-- Réimport sans ces colonnes : les valeurs connues sont gardées.
insert into public.stock_imports (id, org_id, storage_path, file_name, format, replace_all)
values ('IMP-T16B', 'S2', 'S2/liens-b.csv', 'liens-b.csv', 'csv', false);
set role service_role;
do $$ begin
  perform public.apply_stock_import_batch('IMP-T16B', '[{"line": 2, "mpn": "LIEN16-A", "sku": "L16A", "qty": "450", "price": "1.5"}]'::jsonb);
end $$;
reset role;
do $$ begin
  perform tests.eq('réimport sans lien ni description : valeurs gardées, quantité mise à jour',
    (select qty || ' ' || (product_url is not null) || ' ' || (description is not null) || ' ' || lead_days from public.lots where seller_id = 'S2' and sku = 'L16A'),
    '450 true true 3');
end $$;

-- Description trop longue refusée par la base (la lecture du fichier la coupe déjà à 500 caractères).
do $$ begin
  begin
    update public.lots set description = repeat('x', 501) where seller_id = 'S2' and sku = 'L16A';
    raise exception 'ÉCHEC description de 501 caractères acceptée';
  exception when check_violation then raise notice 'ok  description limitée à 500 caractères';
  end;
end $$;

-- Administrateur : lien, fiche technique et description visibles ; recherche dans la description.
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000e1';
do $$
declare r jsonb := public.admin_lots('S2', 'LIEN16-A')->'rows'->0;
begin
  perform tests.eq('back office : lien du vendeur', r->>'product_url', 'https://vendeur-secret.example/produit/LIEN16-A');
  perform tests.eq('back office : fiche technique', r->>'datasheet_url', 'https://fabricant.example/ds/LIEN16-A.pdf');
  perform tests.eq('back office : description', r->>'description', 'Régulateur LDO 3,3 V — vendeur-secret.example');
  perform tests.eq('back office : recherche dans la description', (public.admin_lots(null, 'régulateur ldo')->>'total')::int, 1);
end $$;
reset role;

-- Fonctions publiques : jamais de lien, de fiche technique ni de description.
set role service_role;
do $$
declare s text; o text; q text;
begin
  s := public.public_search('test-16', 'LIEN16')::text;
  perform tests.eq('recherche publique : la référence est trouvée', s like '%LIEN16-A%', true);
  perform tests.eq('recherche publique : ni lien, ni fiche technique, ni description',
    s ~ '(vendeur-secret|fabricant\.example|Régulateur|https?://)', false);
  o := public.partner_offers('test-16', 'LIEN16')::text;
  perform tests.eq('offres partenaires : ni lien, ni fiche technique, ni description',
    o ~ '(vendeur-secret|fabricant\.example|Régulateur|https?://)', false);
  q := public.public_quote('LIEN16-A', (public.public_search('test-16b', 'LIEN16-A')->'results'->0->>'source'), 'HK', 100, 'EUR')::text;
  perform tests.eq('devis public : calculé', q like '%unit_price%', true);
  perform tests.eq('devis public : ni lien, ni fiche technique, ni description',
    q ~ '(vendeur-secret|fabricant\.example|Régulateur|https?://)', false);
end $$;
reset role;

drop schema tests cascade;
select 'Tous les tests des liens et descriptions sont passés.' as resultat;
