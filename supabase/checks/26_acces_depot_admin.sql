-- Tests de l'accès du back office au dépôt d'un fournisseur (migration 20261104000031). Prérequis : checks précédents
-- (fournisseur approuvé S4, administrateur fictif e1). Lancé par tools/test-db.sh.
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

-- Non-administrateur : refusé.
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a2';
do $$ begin
  perform tests.fails('non-administrateur : lien refusé', $s$select public.admin_depot_link('S4')$s$, '42501');
end $$;
reset role;

-- Administrateur : lien de 8 heures pour S4, refusé pour un fournisseur non approuvé.
set role authenticated; set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000e1';
do $$
declare r jsonb;
begin
  r := public.admin_depot_link('s4');
  insert into tests.vars values ('tok', r->>'token');
  perform tests.eq('lien : jeton et échéance dans 8 heures', length(r->>'token') = 48 and (r->>'expires_at')::timestamptz between now() + interval '7 hours 59 minutes' and now() + interval '8 hours 1 minute', true);
  perform tests.fails('fournisseur inconnu : refusé', $s$select public.admin_depot_link('ORG-INCONNU')$s$, 'P0002');
end $$;
reset role;

do $$
declare v_tok text := (select v from tests.vars where k = 'tok'); w jsonb;
begin
  perform tests.eq('journal : lien au nom de l''administrateur', (select created_by || ' ' || label from public.depot_links where org_id = 'S4' and created_by is not null order by id desc limit 1),
    'admin:ops1@example.test Back office');
  perform tests.eq('journal : ouverture inscrite', (select count(*) from public.events where ref = 'S4' and text like 'Dépôt ouvert depuis le back office par admin:ops1@example.test%')::int, 1);
  w := public.depot_link_identity(v_tok);
  perform tests.eq('identité : fournisseur S4, accès opérateur signalé', (w->>'org_id') || ' ' || (w->>'operator'), 'S4 true');
  -- Lien expiré : refusé.
  update public.depot_links set expires_at = now() - interval '1 minute' where token_hash = encode(extensions.digest(v_tok, 'sha256'), 'hex');
  perform tests.eq('lien expiré : refusé', public.depot_link_identity(v_tok), null::jsonb);
  -- Lien du vendeur (sans échéance) : inchangé.
  perform tests.eq('lien du vendeur : sans échéance, pas d''accès opérateur', public.depot_link_identity(public.create_depot_link('S4', 'test'))->>'operator', 'false');
end $$;

drop schema tests cascade;
select 'Tous les tests de l''accès du back office au dépôt sont passés.' as resultat;
