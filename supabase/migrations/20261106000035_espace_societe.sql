-- Espace fournisseur : fiche société, contacts, fabricants, corrections proposées et accord sur la mention de
-- distribution (décision de Bertier, 6 novembre 2026 : « le fournisseur devrait avoir accès à un back office
-- fournisseur »). ADR 0032, complément.
--
-- Dans /depot/ (connexion WeChat), l'administrateur de la société :
--   - complète la fiche de sa société et ses contacts (adresses préférées RFQ et commandes), à usage interne ;
--   - relit la page de chaque fabricant qui lui est rattaché, propose des corrections (appliquées seulement après
--     validation par un administrateur Central.Parts, qui garde la main sur la page publique) ;
--   - donne ou retire son accord sur la mention « distribué en Europe par Central.Parts » et sur le badge de ses offres.
-- La page publique d'un fabricant ne peut être publiée qu'avec au moins un accord enregistré (par le fournisseur dans
-- /depot/, ou par un administrateur qui a reçu l'accord hors plateforme). Retirer le dernier accord retire la page.
-- Remplace admin_supplier_profile_save, admin_seller_contact_save, admin_seller_contact_delete, app.manufacturer_json et
-- admin_manufacturer_publish (20261105000032 et 033) : la logique d'enregistrement passe dans des fonctions communes.
-- Rejouable.

alter table public.manufacturer_distributors
  add column if not exists consent_at timestamptz,   -- accord sur la mention de distribution et le badge
  add column if not exists consent_by text;          -- « wechat:openid » (dans /depot/) ou « admin:adresse (hors plateforme) »

create table if not exists public.manufacturer_proposals (
  id              bigint generated always as identity primary key,
  manufacturer_id text not null references public.manufacturers on delete cascade,
  org_id          text not null references public.organizations on delete cascade,
  proposed        jsonb not null,                      -- champs de la fiche du fabricant, nettoyés
  note            text,
  status          text not null default 'pending' check (status in ('pending', 'applied', 'dismissed')),
  created_by      text not null,
  created_at      timestamptz not null default now(),
  decided_by      text,
  decided_at      timestamptz
);
create index if not exists manufacturer_proposals_pending_idx on public.manufacturer_proposals (manufacturer_id) where status = 'pending';
alter table public.manufacturer_proposals enable row level security;
revoke all on public.manufacturer_proposals from anon, authenticated;

-- Un seul responsable de la fiche par société (décision de Bertier : « s'il y a plusieurs utilisateurs connectés, il y a
-- seulement un admin autorisé à modifier la description, et Central.Parts »). Par défaut, le premier administrateur
-- WeChat rattaché ; un administrateur Central.Parts peut en désigner un autre (admin_set_profile_editor).
alter table public.organizations add column if not exists profile_editor text;   -- openid

create or replace function app.org_editor(p_org text) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select o.profile_editor from public.organizations o join public.wechat_identities w on w.openid = o.profile_editor
      where o.id = p_org and w.org_id = p_org and w.revoked_at is null),
    (select w.openid from public.wechat_identities w where w.org_id = p_org and w.role = 'admin' and w.revoked_at is null
      order by w.bound_at, w.openid limit 1))
$$;

-- Société d'un compte WeChat de /depot/ ; pour modifier (p_admin), le compte doit être le responsable de la fiche.
create or replace function app.depot_org(p_openid text, p_admin boolean) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v_org text;
begin
  select w.org_id into v_org from public.wechat_identities w where w.openid = p_openid and w.revoked_at is null;
  if v_org is null or (p_admin and app.org_editor(v_org) is distinct from p_openid) then
    raise exception 'Réservé au responsable de la fiche de la société' using errcode = '42501';
  end if;
  return v_org;
end $$;

create or replace function app.org_profile_apply(p_org text, p jsonb, p_by text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_by text := p_by; v_org text := upper(btrim(coalesce(p_org, '')));
  txt constant text[] := array['website', 'hq_city', 'production_site', 'payment_terms'];
  k text;
begin
  if not exists (select 1 from public.organizations where id = v_org and type = 'seller') then
    raise exception 'Fournisseur inconnu : %', p_org using errcode = 'P0002';
  end if;
  if jsonb_typeof(p) <> 'object' then raise exception 'Fiche invalide' using errcode = '22023'; end if;
  if p ? 'website' and nullif(btrim(p->>'website'), '') is not null and p->>'website' !~ '^https?://' then
    raise exception 'Site web : adresse http(s) attendue' using errcode = '22023';
  end if;
  begin
    foreach k in array txt loop
      if p ? k then execute format('update public.organizations set %I = $1 where id = $2', k) using left(nullif(btrim(p->>k), ''), 300), v_org; end if;
    end loop;
    update public.organizations set
      founded_year    = case when p ? 'founded_year' then nullif(p->>'founded_year', '')::int else founded_year end,
      area_m2         = case when p ? 'area_m2' then nullif(p->>'area_m2', '')::int else area_m2 end,
      staff           = case when p ? 'staff' then nullif(p->>'staff', '')::int else staff end,
      annual_units    = case when p ? 'annual_units' then nullif(p->>'annual_units', '')::bigint else annual_units end,
      revenue_usd     = case when p ? 'revenue_usd' then nullif(p->>'revenue_usd', '')::numeric else revenue_usd end,
      min_order_usd   = case when p ? 'min_order_usd' then nullif(p->>'min_order_usd', '')::numeric else min_order_usd end,
      about           = case when p ? 'about' then app.tri_text(p->'about') else about end,
      positioning     = case when p ? 'positioning' then app.tri_text(p->'positioning') else positioning end,
      certifications  = case when p ? 'certifications' then app.short_list(p->'certifications') else certifications end,
      languages       = case when p ? 'languages' then app.short_list(p->'languages') else languages end,
      payment_methods = case when p ? 'payment_methods' then app.short_list(p->'payment_methods') else payment_methods end
     where id = v_org;
  exception when invalid_text_representation or numeric_value_out_of_range or check_violation then
    raise exception 'Valeur invalide : %', sqlerrm using errcode = '22023';
  end;
  insert into public.events (actor, text, ref) values ('ops', 'Fiche société modifiée par ' || v_by, v_org);
  return v_org;
end $$;

create or replace function app.org_contact_apply(p_org text, p jsonb, p_by text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_by text := p_by; v_org text := upper(btrim(coalesce(p_org, ''))); v_id text := nullif(p->>'id', '');
  v_addr text := nullif(p->>'address_id', '');
begin
  if not exists (select 1 from public.organizations where id = v_org and type = 'seller') then
    raise exception 'Fournisseur inconnu : %', p_org using errcode = 'P0002';
  end if;
  if v_addr is not null and not exists (select 1 from public.seller_addresses where id = v_addr and org_id = v_org) then
    raise exception 'Adresse inconnue pour ce fournisseur' using errcode = '22023';
  end if;
  begin
    if v_id is null then
      insert into public.seller_contacts (org_id, address_id, name, role, email, phone, wechat, languages, for_rfq, for_po)
      values (v_org, v_addr, btrim(coalesce(p->>'name', '')), nullif(btrim(p->>'role'), ''), nullif(lower(btrim(p->>'email')), ''),
        nullif(btrim(p->>'phone'), ''), nullif(btrim(p->>'wechat'), ''), app.short_list(p->'languages'),
        coalesce((p->>'for_rfq')::boolean, false), coalesce((p->>'for_po')::boolean, false));
    else
      update public.seller_contacts set address_id = v_addr, name = btrim(coalesce(p->>'name', '')), role = nullif(btrim(p->>'role'), ''),
        email = nullif(lower(btrim(p->>'email')), ''), phone = nullif(btrim(p->>'phone'), ''), wechat = nullif(btrim(p->>'wechat'), ''),
        languages = app.short_list(p->'languages'), for_rfq = coalesce((p->>'for_rfq')::boolean, false),
        for_po = coalesce((p->>'for_po')::boolean, false)
       where id = v_id and org_id = v_org;
      if not found then raise exception 'Contact inconnu' using errcode = 'P0002'; end if;
    end if;
  exception when check_violation or invalid_text_representation then
    raise exception 'Contact invalide : nom obligatoire, e-mail au bon format' using errcode = '22023';
  end;
  insert into public.events (actor, text, ref) values ('ops', 'Contacts modifiés par ' || v_by, v_org);
  return v_org;
end $$;

create or replace function app.org_contact_remove(p_org text, p_id text, p_by text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_by text := p_by; v_org text := upper(btrim(coalesce(p_org, '')));
begin
  delete from public.seller_contacts where id = p_id and org_id = v_org;
  if not found then raise exception 'Contact inconnu' using errcode = 'P0002'; end if;
  insert into public.events (actor, text, ref) values ('ops', 'Contact retiré par ' || v_by, v_org);
  return v_org;
end $$;

create or replace function app.manufacturer_json(p_id text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', m.id, 'name', m.name, 'brands', to_jsonb(m.brands), 'about', m.about, 'positioning', m.positioning,
    'founded_year', m.founded_year, 'website', m.website, 'hq_city', m.hq_city, 'production_site', m.production_site,
    'area_m2', m.area_m2, 'staff', m.staff, 'annual_units', m.annual_units, 'revenue_usd', m.revenue_usd,
    'certifications', to_jsonb(m.certifications), 'languages', to_jsonb(m.languages), 'logo_path', m.logo_path,
    'public_page', m.public_page, 'public_page_by', m.public_page_by, 'public_page_at', m.public_page_at,
    'can_publish', cardinality(m.brands) > 0 and m.about <> '{}'
      and exists (select 1 from public.manufacturer_distributors d where d.manufacturer_id = m.id and d.consent_at is not null),
    'has_consent', exists (select 1 from public.manufacturer_distributors d where d.manufacturer_id = m.id and d.consent_at is not null),
    'proposals', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'org_id', r.org_id, 'by', r.created_by, 'at', r.created_at,
        'proposed', r.proposed, 'note', r.note) order by r.created_at) from public.manufacturer_proposals r
        where r.manufacturer_id = m.id and r.status = 'pending'), '[]'),
    'distributors', coalesce((select jsonb_agg(jsonb_build_object('org_id', o.id, 'name', o.name, 'alias', o.alias, 'role', d.role,
        'status', o.kyb, 'consent_at', d.consent_at, 'consent_by', d.consent_by, 'offers', (select count(*) from public.lots l where l.seller_id = o.id and l.qty > 0
          and upper(btrim(l.manufacturer)) = any (select upper(b) from unnest(m.brands) b)))
        order by d.role desc, o.name) from public.manufacturer_distributors d join public.organizations o on o.id = d.org_id
        where d.manufacturer_id = m.id), '[]'))
    from public.manufacturers m where m.id = p_id
$$;

-- Publie ou retire la page publique. Publication : au moins une marque, une présentation et l'accord d'un compte
-- rattaché sur la mention « distribué en Europe par Central.Parts » (migration 20261106000035).
create or replace function public.admin_manufacturer_publish(p_id text, p_on boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_by text := app.require_admin(); m public.manufacturers;
begin
  select * into m from public.manufacturers where id = upper(btrim(coalesce(p_id, '')));
  if m.id is null then raise exception 'Fabricant inconnu : %', p_id using errcode = 'P0002'; end if;
  if p_on and (cardinality(m.brands) = 0 or m.about = '{}') then
    raise exception 'Page publique : marque et présentation requises' using errcode = '22023';
  end if;
  if p_on and not exists (select 1 from public.manufacturer_distributors where manufacturer_id = m.id and consent_at is not null) then
    raise exception 'Page publique : accord du fabricant ou de son distributeur requis' using errcode = '22023';
  end if;
  update public.manufacturers set public_page = p_on, public_page_by = v_by, public_page_at = now() where id = m.id;
  insert into public.events (actor, text, ref)
  values ('ops', case when p_on then 'Page fabricant publiée par ' else 'Page fabricant retirée par ' end || v_by, m.id);
  return app.manufacturer_json(m.id);
end $$;

-- ------------------------------------------------------------ back office : mêmes fonctions, logique commune
-- (deux instructions : admin_supplier_profile, STABLE, ne verrait pas la modification faite dans la même instruction)
create or replace function public.admin_supplier_profile_save(p_org text, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v text;
begin v := app.org_profile_apply(p_org, p, app.require_admin()); return public.admin_supplier_profile(v); end $$;

create or replace function public.admin_seller_contact_save(p_org text, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v text;
begin v := app.org_contact_apply(p_org, p, app.require_admin()); return public.admin_supplier_profile(v); end $$;

create or replace function public.admin_seller_contact_delete(p_org text, p_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v text;
begin v := app.org_contact_remove(p_org, p_id, app.require_admin()); return public.admin_supplier_profile(v); end $$;

create or replace function public.admin_supplier_profile(p_org text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare o public.organizations;
begin
  perform app.require_admin();
  select * into o from public.organizations where id = upper(btrim(coalesce(p_org, ''))) and type = 'seller';
  if o.id is null then raise exception 'Fournisseur inconnu : %', p_org using errcode = 'P0002'; end if;
  return jsonb_build_object('org_id', o.id, 'founded_year', o.founded_year, 'website', o.website, 'about', o.about,
    'positioning', o.positioning, 'hq_city', o.hq_city, 'production_site', o.production_site, 'area_m2', o.area_m2,
    'staff', o.staff, 'annual_units', o.annual_units, 'revenue_usd', o.revenue_usd, 'certifications', to_jsonb(o.certifications),
    'languages', to_jsonb(o.languages), 'payment_methods', to_jsonb(o.payment_methods), 'payment_terms', o.payment_terms,
    'min_order_usd', o.min_order_usd,
    'profile_editor', app.org_editor(o.id),
    'identities', coalesce((select jsonb_agg(jsonb_build_object('openid', w.openid, 'label', w.label, 'role', w.role) order by w.bound_at)
        from public.wechat_identities w where w.org_id = o.id and w.revoked_at is null), '[]'),
    'manufacturers', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'brands', to_jsonb(m.brands),
        'role', d.role, 'public_page', m.public_page) order by m.name)
        from public.manufacturer_distributors d join public.manufacturers m on m.id = d.manufacturer_id where d.org_id = o.id), '[]'),
    'contacts', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'address_id', c.address_id, 'name', c.name, 'role', c.role,
        'email', c.email, 'phone', c.phone, 'wechat', c.wechat, 'languages', to_jsonb(c.languages), 'for_rfq', c.for_rfq, 'for_po', c.for_po)
        order by c.created_at) from public.seller_contacts c where c.org_id = o.id), '[]'));
end $$;

-- Désigne le responsable de la fiche (compte WeChat actif de la société), qui devient administrateur de la société.
create or replace function public.admin_set_profile_editor(p_org text, p_openid text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_by text := app.require_admin(); v_org text := upper(btrim(coalesce(p_org, '')));
begin
  update public.wechat_identities set role = 'admin' where openid = p_openid and org_id = v_org and revoked_at is null;
  if not found then raise exception 'Compte WeChat inconnu pour cette société' using errcode = 'P0002'; end if;
  update public.organizations set profile_editor = p_openid where id = v_org;
  insert into public.events (actor, text, ref) values ('ops', 'Responsable de la fiche désigné par ' || v_by, v_org);
  declare r jsonb; begin r := public.admin_supplier_profile(v_org); return r; end;
end $$;

-- Applique ou écarte une correction proposée par un fournisseur.
create or replace function public.admin_manufacturer_proposal_decide(p_id bigint, p_apply boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_by text := app.require_admin(); r public.manufacturer_proposals; m public.manufacturers; v jsonb;
begin
  select * into r from public.manufacturer_proposals where id = p_id and status = 'pending';
  if r.id is null then raise exception 'Proposition inconnue ou déjà traitée' using errcode = 'P0002'; end if;
  if p_apply then
    -- Textes en trois langues : la correction d'une langue garde les autres.
    select * into m from public.manufacturers where id = r.manufacturer_id;
    v := r.proposed;
    if v ? 'about' then v := jsonb_set(v, '{about}', m.about || (v->'about')); end if;
    if v ? 'positioning' then v := jsonb_set(v, '{positioning}', m.positioning || (v->'positioning')); end if;
    perform public.admin_manufacturer_save(r.manufacturer_id, v);
  end if;
  update public.manufacturer_proposals set status = case when p_apply then 'applied' else 'dismissed' end,
    decided_by = v_by, decided_at = now() where id = r.id;
  insert into public.events (actor, text, ref)
  values ('ops', 'Corrections de ' || r.org_id || case when p_apply then ' appliquées par ' else ' écartées par ' end || v_by, r.manufacturer_id);
  return app.manufacturer_json(r.manufacturer_id);
end $$;

-- Accord reçu hors plateforme (WeChat, e-mail) : enregistré par l'administrateur, à son nom.
create or replace function public.admin_manufacturer_consent(p_id text, p_org text, p_on boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_by text := app.require_admin(); v_id text := upper(btrim(coalesce(p_id, ''))); v_org text := upper(btrim(coalesce(p_org, '')));
begin
  update public.manufacturer_distributors
     set consent_at = case when p_on then now() end, consent_by = case when p_on then v_by || ' (hors plateforme)' end
   where manufacturer_id = v_id and org_id = v_org;
  if not found then raise exception 'Rattachement inconnu' using errcode = 'P0002'; end if;
  perform app.manufacturer_consent_changed(v_id);
  insert into public.events (actor, text, ref)
  values ('ops', 'Accord de ' || v_org || case when p_on then ' enregistré par ' else ' retiré par ' end || v_by, v_id);
  return app.manufacturer_json(v_id);
end $$;

-- Plus aucun accord : la page publique est retirée.
create or replace function app.manufacturer_consent_changed(p_id text) returns void
language sql security definer set search_path = '' as $$
  update public.manufacturers m set public_page = false
   where m.id = p_id and m.public_page
     and not exists (select 1 from public.manufacturer_distributors d where d.manufacturer_id = m.id and d.consent_at is not null)
$$;

-- ------------------------------------------------------------ espace fournisseur (/depot/, fonction Edge depot)
-- Fiche de la société du compte, ses contacts et les fabricants qui lui sont rattachés (page, accord, correction en
-- attente). Lecture : tout membre ; les fabricants ne montrent ni le chiffre d'affaires ni le site web saisis par
-- Central.Parts.
create or replace function public.supplier_company(p_openid text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_org text := app.depot_org(p_openid, false); o public.organizations;
begin
  select * into o from public.organizations where id = v_org;
  return jsonb_build_object('org_id', o.id, 'name', o.name,
    'can_edit', app.org_editor(o.id) = p_openid,
    'founded_year', o.founded_year, 'website', o.website, 'about', o.about, 'hq_city', o.hq_city, 'staff', o.staff,
    'certifications', to_jsonb(o.certifications), 'languages', to_jsonb(o.languages),
    'payment_methods', to_jsonb(o.payment_methods), 'payment_terms', o.payment_terms, 'min_order_usd', o.min_order_usd,
    'contacts', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'role', c.role, 'email', c.email,
        'phone', c.phone, 'wechat', c.wechat, 'languages', to_jsonb(c.languages), 'for_rfq', c.for_rfq, 'for_po', c.for_po)
        order by c.created_at) from public.seller_contacts c where c.org_id = o.id), '[]'),
    'manufacturers', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'brands', to_jsonb(m.brands),
        'role', d.role, 'consent_at', d.consent_at, 'public_page', m.public_page, 'logo_path', m.logo_path,
        'about', m.about, 'positioning', m.positioning, 'founded_year', m.founded_year, 'hq_city', m.hq_city,
        'production_site', m.production_site, 'area_m2', m.area_m2, 'staff', m.staff, 'annual_units', m.annual_units,
        'certifications', to_jsonb(m.certifications), 'languages', to_jsonb(m.languages),
        'pending', exists (select 1 from public.manufacturer_proposals r where r.manufacturer_id = m.id and r.org_id = o.id and r.status = 'pending'))
        order by m.name)
        from public.manufacturer_distributors d join public.manufacturers m on m.id = d.manufacturer_id where d.org_id = o.id), '[]'));
end $$;

create or replace function public.supplier_company_save(p_openid text, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_org text := app.depot_org(p_openid, true);
begin
  -- Le fournisseur ne modifie pas ce que Central.Parts saisit seul (chiffre d'affaires, site de production, surface…).
  perform app.org_profile_apply(v_org, p - array['revenue_usd', 'production_site', 'area_m2', 'annual_units', 'positioning'], 'wechat:' || p_openid);
  return public.supplier_company(p_openid);
end $$;

create or replace function public.supplier_contact_save(p_openid text, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_org text := app.depot_org(p_openid, true);
begin
  perform app.org_contact_apply(v_org, p - 'address_id', 'wechat:' || p_openid);
  return public.supplier_company(p_openid);
end $$;

create or replace function public.supplier_contact_delete(p_openid text, p_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_org text := app.depot_org(p_openid, true);
begin
  perform app.org_contact_remove(v_org, p_id, 'wechat:' || p_openid);
  return public.supplier_company(p_openid);
end $$;

-- Corrections proposées pour la page d'un fabricant rattaché : enregistrées, appliquées après validation.
create or replace function public.supplier_manufacturer_propose(p_openid text, p_mfr text, p jsonb, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_org text := app.depot_org(p_openid, true); v_id text := upper(btrim(coalesce(p_mfr, ''))); v jsonb := '{}'; k text;
begin
  if not exists (select 1 from public.manufacturer_distributors where manufacturer_id = v_id and org_id = v_org) then
    raise exception 'Fabricant non rattaché à votre société' using errcode = '42501';
  end if;
  if jsonb_typeof(p) <> 'object' then raise exception 'Proposition invalide' using errcode = '22023'; end if;
  foreach k in array array['founded_year', 'hq_city', 'production_site', 'area_m2', 'staff', 'annual_units'] loop
    if p ? k then v := v || jsonb_build_object(k, left(btrim(coalesce(p->>k, '')), 300)); end if;
  end loop;
  if p ? 'about' then v := v || jsonb_build_object('about', app.tri_text(p->'about')); end if;
  if p ? 'positioning' then v := v || jsonb_build_object('positioning', app.tri_text(p->'positioning')); end if;
  if p ? 'certifications' then v := v || jsonb_build_object('certifications', to_jsonb(app.short_list(p->'certifications'))); end if;
  if p ? 'languages' then v := v || jsonb_build_object('languages', to_jsonb(app.short_list(p->'languages'))); end if;
  if v = '{}' and btrim(coalesce(p_note, '')) = '' then raise exception 'Aucune correction' using errcode = '22023'; end if;
  -- Une seule proposition en attente par société et fabricant : la nouvelle remplace l'ancienne.
  update public.manufacturer_proposals set status = 'dismissed', decided_by = 'remplacée', decided_at = now()
   where manufacturer_id = v_id and org_id = v_org and status = 'pending';
  insert into public.manufacturer_proposals (manufacturer_id, org_id, proposed, note, created_by)
  values (v_id, v_org, v, nullif(left(btrim(coalesce(p_note, '')), 2000), ''), 'wechat:' || p_openid);
  insert into public.events (actor, text, ref) values ('supplier', 'Corrections proposées par ' || v_org, v_id);
  return public.supplier_company(p_openid);
end $$;

-- Accord (ou retrait) sur la mention « distribué en Europe par Central.Parts » et le badge des offres.
create or replace function public.supplier_manufacturer_consent(p_openid text, p_mfr text, p_on boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_org text := app.depot_org(p_openid, true); v_id text := upper(btrim(coalesce(p_mfr, '')));
begin
  update public.manufacturer_distributors
     set consent_at = case when p_on then now() end, consent_by = case when p_on then 'wechat:' || p_openid end
   where manufacturer_id = v_id and org_id = v_org;
  if not found then raise exception 'Fabricant non rattaché à votre société' using errcode = '42501'; end if;
  perform app.manufacturer_consent_changed(v_id);
  insert into public.events (actor, text, ref)
  values ('supplier', case when p_on then 'Accord donné par ' else 'Accord retiré par ' end || v_org, v_id);
  return public.supplier_company(p_openid);
end $$;

-- ------------------------------------------------------------ droits
revoke execute on function app.depot_org(text, boolean), app.org_editor(text), app.org_profile_apply(text, jsonb, text), app.org_contact_apply(text, jsonb, text),
  app.org_contact_remove(text, text, text), app.manufacturer_consent_changed(text) from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array['public.supplier_company(text)', 'public.supplier_company_save(text, jsonb)',
    'public.supplier_contact_save(text, jsonb)', 'public.supplier_contact_delete(text, text)',
    'public.supplier_manufacturer_propose(text, text, jsonb, text)', 'public.supplier_manufacturer_consent(text, text, boolean)']
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
  foreach f in array array['public.admin_set_profile_editor(text, text)', 'public.admin_manufacturer_proposal_decide(bigint, boolean)', 'public.admin_manufacturer_consent(text, text, boolean)']
  loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;
