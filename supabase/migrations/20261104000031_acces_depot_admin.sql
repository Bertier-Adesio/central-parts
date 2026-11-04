-- Accès du back office au dépôt d'un fournisseur (décision de Bertier, 4 novembre 2026 : « j'ai besoin d'avoir un accès
-- back office au dépôt des fournisseurs »). ADR 0021, complément.
--
-- Depuis la fiche d'un fournisseur approuvé, l'administrateur ouvre son dépôt par un lien personnel (/depot/lien/),
-- comme celui qu'on remet au fournisseur, mais créé à son nom et valable 8 heures : charger un fichier de stock pour
-- lui, voir ses imports et leurs rapports, reconfirmer ses offres. Chaque ouverture est inscrite au journal.
-- Remplace depot_link_identity (20261103000023), recopiée : liens expirés refusés, accès opérateur signalé. Rejouable.

alter table public.depot_links add column if not exists created_by text;      -- « admin:adresse » si ouvert du back office
alter table public.depot_links add column if not exists expires_at timestamptz; -- null : sans échéance (lien du vendeur)

create or replace function public.depot_link_identity(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare k public.depot_links; o public.organizations;
begin
  select * into k from public.depot_links
   where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex') and revoked_at is null
     and (expires_at is null or expires_at > now());
  if k.id is null then return null; end if;
  select * into o from public.organizations where id = k.org_id;
  if not app.is_verified(o.id) then return null; end if;
  update public.depot_links set last_used_at = now() where id = k.id;
  return jsonb_build_object('org_id', o.id, 'name', o.name, 'currency', o.currency,
    'ttl_days', extract(day from app.seller_ttl(o.id))::int,
    'operator', k.created_by is not null, 'expires_at', k.expires_at);
end $$;

-- Back office : lien de dépôt d'un fournisseur approuvé, au nom de l'administrateur, valable 8 heures.
-- Renvoie le jeton (affiché une seule fois) et l'échéance. Erreur P0002 si le fournisseur n'est pas approuvé.
create or replace function public.admin_depot_link(p_org text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_by text := app.require_admin(); v_org text := upper(btrim(coalesce(p_org, '')));
  v_token text := encode(extensions.gen_random_bytes(24), 'hex'); v_exp timestamptz := now() + interval '8 hours';
begin
  if not exists (select 1 from public.organizations o where o.id = v_org and o.type = 'seller' and o.kyb = 'validated') then
    raise exception 'Fournisseur inconnu ou non approuvé : %', v_org using errcode = 'P0002';
  end if;
  insert into public.depot_links (org_id, token_hash, label, created_by, expires_at)
  values (v_org, encode(extensions.digest(v_token, 'sha256'), 'hex'), 'Back office', v_by, v_exp);
  insert into public.events (actor, text, ref) values ('ops', 'Dépôt ouvert depuis le back office par ' || v_by || ' (8 h)', v_org);
  return jsonb_build_object('token', v_token, 'expires_at', v_exp);
end $$;

revoke execute on function public.depot_link_identity(text), public.admin_depot_link(text) from public, anon, authenticated;
grant execute on function public.depot_link_identity(text) to service_role;
grant execute on function public.admin_depot_link(text) to authenticated, service_role;
