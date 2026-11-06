-- Direct fabricant ou distributeur agréé, au choix pour chaque compte rattaché (décision de Bertier, 5 novembre 2026 :
-- « il faut que je puisse moduler direct fabricant et direct distributeur agréé » ; la société de distribution d'un
-- fabricant, en contact direct avec lui, est « direct fabricant »). ADR 0032, complément.
--
-- Un fabricant peut avoir plusieurs comptes « direct fabricant » (lui-même et sa société de distribution) : l'index
-- qui n'en permettait qu'un est retiré. Le rôle d'un compte déjà rattaché se change sans le détacher.
-- Remplace admin_manufacturer_link (20261105000033), recopiée. Rejouable.

drop index if exists public.manufacturer_self_idx;

-- Rattache un compte fournisseur à un fabricant, ou change son rôle : « self » (direct fabricant : le fabricant ou sa
-- propre société de distribution, plusieurs possibles) ou « authorized » (distributeur agréé).
create or replace function public.admin_manufacturer_link(p_id text, p_org text, p_role text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_by text := app.require_admin(); v_id text := upper(btrim(coalesce(p_id, ''))); v_org text := upper(btrim(coalesce(p_org, '')));
begin
  if not exists (select 1 from public.manufacturers where id = v_id) then raise exception 'Fabricant inconnu : %', p_id using errcode = 'P0002'; end if;
  if not exists (select 1 from public.organizations where id = v_org and type = 'seller') then
    raise exception 'Fournisseur inconnu : %', p_org using errcode = 'P0002';
  end if;
  -- Canal officiel seulement : fabricant ou distributeur. Jamais un revendeur, un broker ni un excédent de stock.
  if (select app.source_category(profile) from public.organizations where id = v_org) not in ('manufacturer', 'distributor') then
    raise exception 'Seul un fabricant ou un distributeur peut être rattaché (pas un revendeur, broker ou excédent)' using errcode = '22023';
  end if;
  if coalesce(p_role, '') not in ('self', 'authorized') then raise exception 'Rôle : self ou authorized' using errcode = '22023'; end if;
  insert into public.manufacturer_distributors (manufacturer_id, org_id, role, created_by) values (v_id, v_org, p_role, v_by)
  on conflict (manufacturer_id, org_id) do update set role = excluded.role, created_by = excluded.created_by, created_at = now();
  insert into public.events (actor, text, ref)
  values ('ops', v_org || case when p_role = 'self' then ' rattaché en direct fabricant par ' else ' rattaché comme distributeur agréé par ' end || v_by, v_id);
  return app.manufacturer_json(v_id);
end $$;
