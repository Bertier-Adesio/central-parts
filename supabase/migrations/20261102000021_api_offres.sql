-- API d'offres en direct pour les plateformes de chiffrage (Adesio d'abord), ADR 0024 : Central.Parts répond comme
-- l'API produit d'un distributeur, en quelques millisecondes, à partir des stocks déposés (lots à jour).
-- À appliquer à la main dans le SQL Editor, après 20261102000020 (clés d'API, rfq_auth). Rejouable.
--
--   catalog_offers      une référence (GET /v1/offers) : produits (référence + fabricant), chacun avec ses offres
--   catalog_search      une nomenclature, 500 lignes au plus (POST /v1/offers/search)
--   catalog_offer       une offre et son prix à la quantité (GET /v1/offers/{offer_id})
--   catalog_manufacturers  référentiel des fabricants (identifiant, nom, alias)
--
-- Forme de la réponse : tri des champs des API DigiKey et TI (validé par Bertier le 2 novembre 2026). Gardés :
-- produit et offres (DigiKey : Product / ProductVariations), fabricant normalisé {id, name}, paliers
-- {quantity, unit_price}, MOQ, stock, quantité d'un conditionnement complet, conditionnement en liste fermée, boîtier,
-- cycle de vie, ECCN, code HTS, pays d'origine, lien vers la page Central.Parts. Écartés : prix propres au client,
-- fournisseur, frais de bobine, total calculable, nombre de broches, prévisions de stock. Champs en snake_case ;
-- un champ absent veut dire « inconnu » (jamais null).
--
-- Règles :
--   - lots à jour seulement (app.lot_fresh), quantité > 0, fournisseur approuvé ; bac à sable avec bac à sable ;
--   - fournisseur jamais nommé : ni nom, ni pseudonyme, ni SKU, ni lien de sa fiche, ni prix net ; le fabricant oui ;
--   - prix tout compris (marge du vendeur ou de sa catégorie) ; sans marge applicable ou sans prix : « on_request » ;
--   - devise : celle du lot (décision du 2 novembre 2026, conversion traitée plus tard). Le réglage
--     app.settings 'api_convert_currency' = 'true' convertit dans la devise demandée au taux de public.currencies ;
--   - identifiant d'offre opaque (cpo_…), stable pour un lot, sans rien révéler du lot ;
--   - compteur de consultations par fournisseur, référence et semaine (aucune identité de l'appelant gardée).

-- ------------------------------------------------------------ identifiants opaques
create table if not exists app.catalog_offer_ids (
  lot_id     text primary key references public.lots on delete cascade,
  offer_id   text not null unique default ('cpo_' || encode(extensions.gen_random_bytes(10), 'hex')),
  created_at timestamptz not null default now()
);
revoke all on app.catalog_offer_ids from public, anon, authenticated;

create or replace function app.catalog_offer_id(p_lot text) returns text
language plpgsql security definer set search_path = '' as $$
declare v text;
begin
  select offer_id into v from app.catalog_offer_ids where lot_id = p_lot;
  if v is null then
    insert into app.catalog_offer_ids (lot_id) values (p_lot) on conflict (lot_id) do nothing;
    select offer_id into v from app.catalog_offer_ids where lot_id = p_lot;
  end if;
  return v;
end $$;

-- ------------------------------------------------------------ compteur de consultations
-- Une consultation = une réponse de l'API qui contient l'offre (une fois par appel). Semaine ISO (lundi).
create table if not exists app.offer_views (
  seller_id text not null references public.organizations on delete cascade,
  mpn       text not null,
  week      date not null,
  views     integer not null default 0,
  primary key (seller_id, mpn, week)
);
revoke all on app.offer_views from public, anon, authenticated;

create or replace function app.count_offer_views(p_lots text[], p_now timestamptz) returns void
language sql security definer set search_path = '' as $$
  insert into app.offer_views (seller_id, mpn, week, views)
  select l.seller_id, upper(regexp_replace(l.mpn, '\s+', '', 'g')), date_trunc('week', p_now)::date, count(*)
    from public.lots l where l.id = any (p_lots)
   group by 1, 2
  on conflict (seller_id, mpn, week) do update set views = app.offer_views.views + excluded.views
$$;

-- Consultations d'un fournisseur (administrateur ; affichage au fournisseur à décider), 8 dernières semaines.
create or replace function public.supplier_offer_views(p_org text, p_now timestamptz default now())
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('org', p_org,
    'total', coalesce(sum(v.views), 0),
    'by_week', coalesce((select jsonb_agg(jsonb_build_object('week', w.week, 'views', w.n) order by w.week desc)
        from (select week, sum(views) n from app.offer_views where seller_id = p_org and week >= (p_now - interval '8 weeks')::date
              group by week) w), '[]'),
    'top', coalesce((select jsonb_agg(jsonb_build_object('mpn', t.mpn, 'views', t.n) order by t.n desc, t.mpn)
        from (select mpn, sum(views) n from app.offer_views where seller_id = p_org and week >= (p_now - interval '8 weeks')::date
              group by mpn order by 2 desc limit 20) t), '[]'))
    from app.offer_views v where v.seller_id = p_org and v.week >= (p_now - interval '8 weeks')::date
$$;

-- ------------------------------------------------------------ champs du lot (tri DigiKey / TI)
alter table public.lots
  add column if not exists standard_pack_quantity integer check (standard_pack_quantity >= 1),  -- bobine, plateau complets
  add column if not exists package_case text check (length(package_case) <= 60),                 -- boîtier : SOIC-8, 0603…
  add column if not exists lifecycle text check (lifecycle in ('active', 'nrnd', 'last_time_buy', 'obsolete')),
  add column if not exists eccn text check (length(eccn) <= 20),                                 -- contrôle à l'export
  add column if not exists hts_code text check (length(hts_code) <= 20);                         -- nomenclature douanière

-- ------------------------------------------------------------ référentiel des fabricants
-- Identifiant stable et alias (graphies des fichiers, abréviations, noms chinois, sociétés rachetées), pour que
-- « TI », « Texas Instruments Inc. » et « 德州仪器 » donnent le même fabricant. Les noms inconnus restent tels quels.
create table if not exists app.manufacturers (
  id      text primary key check (id ~ '^MFR-[A-Z0-9]+$'),
  name    text not null unique,
  aliases text[] not null default '{}'
);
revoke all on app.manufacturers from public, anon, authenticated;
insert into app.manufacturers (id, name, aliases) values
  ('MFR-TI', 'Texas Instruments', '{TI,"Texas Instruments Inc.","Texas Instrument","Burr-Brown",德州仪器,德州}'),
  ('MFR-ST', 'STMicroelectronics', '{ST,STM,"ST Microelectronics",意法半导体,意法}'),
  ('MFR-NXP', 'NXP Semiconductors', '{NXP,Freescale,恩智浦}'),
  ('MFR-IFX', 'Infineon Technologies', '{Infineon,IFX,Cypress,"International Rectifier",英飞凌}'),
  ('MFR-MCHP', 'Microchip Technology', '{Microchip,MCHP,Atmel,Microsemi,微芯}'),
  ('MFR-ADI', 'Analog Devices', '{ADI,"Analog Devices Inc.","Linear Technology","Maxim Integrated",Maxim,亚德诺}'),
  ('MFR-ONSEMI', 'onsemi', '{"ON Semiconductor","ON Semi",Fairchild,安森美}'),
  ('MFR-RENESAS', 'Renesas Electronics', '{Renesas,Intersil,IDT,"Dialog Semiconductor",瑞萨}'),
  ('MFR-AMD', 'AMD', '{"AMD Xilinx",Xilinx,赛灵思}'),
  ('MFR-INTEL', 'Intel', '{Altera,"Intel FPGA",英特尔}'),
  ('MFR-MURATA', 'Murata', '{"Murata Manufacturing","Murata Electronics",村田}'),
  ('MFR-YAGEO', 'YAGEO', '{Yageo,国巨}'),
  ('MFR-SEMCO', 'Samsung Electro-Mechanics', '{SEMCO,"Samsung EM",三星电机}'),
  ('MFR-TDK', 'TDK', '{"TDK Corporation",EPCOS,"TDK-Lambda"}'),
  ('MFR-KEMET', 'KEMET', '{Kemet,"KEMET Electronics"}'),
  ('MFR-VISHAY', 'Vishay', '{"Vishay Intertechnology",Siliconix,威世}'),
  ('MFR-NEXPERIA', 'Nexperia', '{安世}'),
  ('MFR-ROHM', 'ROHM Semiconductor', '{ROHM,Rohm,罗姆}'),
  ('MFR-TOSHIBA', 'Toshiba', '{"Toshiba Electronic Devices",东芝}'),
  ('MFR-BOURNS', 'Bourns', '{"Bourns Inc."}'),
  ('MFR-DIODES', 'Diodes Incorporated', '{Diodes,"Diodes Inc."}'),
  ('MFR-MOLEX', 'Molex', '{莫仕}'),
  ('MFR-TE', 'TE Connectivity', '{TE,Tyco,泰科}'),
  ('MFR-AVX', 'KYOCERA AVX', '{AVX,"Kyocera AVX"}'),
  ('MFR-MPS', 'Monolithic Power Systems', '{MPS}'),
  ('MFR-GIGADEVICE', 'GigaDevice', '{兆易创新}'),
  ('MFR-WCH', 'WCH', '{"Nanjing Qinheng",沁恒}')
on conflict (id) do update set name = excluded.name, aliases = excluded.aliases;

-- Clé de comparaison d'un nom de fabricant : minuscules, sans espaces ni ponctuation.
create or replace function app.mfr_key(p text) returns text language sql immutable as $$
  select nullif(lower(regexp_replace(coalesce(p, ''), '[[:space:].,/&()_®™-]+', '', 'g')), '')
$$;

create or replace function app.manufacturer_id(p text) returns text
language sql stable security definer set search_path = '' as $$
  select m.id from app.manufacturers m
   where app.mfr_key(m.name) = app.mfr_key(p) or app.mfr_key(p) = any (select app.mfr_key(a) from unnest(m.aliases) a)
   order by m.id limit 1
$$;

-- ------------------------------------------------------------ conditionnement en liste fermée
-- tape_reel (bande et bobine), cut_tape (bande coupée), tray (plateau), tube, bulk (vrac) ; inconnu : null.
create or replace function app.packaging_code(p text) returns text language sql immutable as $$
  select case
    when p is null or btrim(p) = '' then null
    when lower(p) ~ 'cut.?tape|\mct\M|剪切|切带|散料带|bande coup' then 'cut_tape'
    when lower(p) ~ 'reel|\mt&r\M|\mtr\M|bobine|卷带|编带|盘装|卷盘' then 'tape_reel'
    when lower(p) ~ 'tray|plateau|托盘' then 'tray'
    when lower(p) ~ '\mtubes?\M|管装' then 'tube'
    when lower(p) ~ 'bulk|vrac|散装|袋装|\mbag\M' then 'bulk'
  end
$$;

-- ------------------------------------------------------------ prix
create or replace function app.catalog_max_lines() returns int language sql immutable as $$ select 500 $$;
-- Validité annoncée d'un prix : 24 h, et jamais au-delà de la date où le lot doit être reconfirmé.
create or replace function app.catalog_price_hours() returns int language sql immutable as $$ select 24 $$;

insert into app.settings (name, value) values ('api_convert_currency', 'false') on conflict (name) do nothing;

-- Devise de sortie : celle du lot, sauf conversion activée et devise demandée acceptée.
create or replace function app.catalog_currency(p_lot_currency text, p_requested text) returns text
language sql stable security definer set search_path = '' as $$
  select case when coalesce((select value from app.settings where name = 'api_convert_currency'), 'false') = 'true'
              and app.norm_currency(p_requested) is not null then app.norm_currency(p_requested) else p_lot_currency end
$$;

-- Prix tout compris d'un lot pour une quantité, dans la devise de sortie ; null : prix sur demande.
create or replace function app.catalog_price(p_lot text, p_qty int, p_out text) returns numeric
language sql stable security definer set search_path = '' as $$
  select round(app.lot_price_for(l.id, p_qty) * c.eur_rate / t.eur_rate * (1 + app.offer_margin(l.seller_id) / 100), 4)
    from public.lots l
    join public.currencies c on c.code = l.currency
    join public.currencies t on t.code = p_out
   where l.id = p_lot
$$;

-- Offre (propre au lot) telle que la voit la plateforme. p_qty : quantité visée (prix à la quantité si donnée).
-- Volatile : attribue l'identifiant opaque à la première publication du lot.
create or replace function app.catalog_offer_json(p_lot text, p_qty int, p_requested text, p_now timestamptz)
returns jsonb language sql volatile security definer set search_path = '' as $$
  with x as (
    select l.*, o.profile, o.country, o.sandbox, app.catalog_currency(l.currency, p_requested) as out_cur,
           greatest(coalesce(l.moq, 1), 1) as min_qty, app.offer_margin(l.seller_id) as margin
      from public.lots l join public.organizations o on o.id = l.seller_id where l.id = p_lot),
  breaks as (
    -- Paliers : le minimum de commande au prix de base, puis les paliers du fournisseur au-delà.
    select q, app.catalog_price(x.id, q, x.out_cur) as price from x,
      lateral (select x.min_qty as q union select b.min_qty from public.lot_price_breaks b where b.lot_id = x.id and b.min_qty > x.min_qty) s)
  select jsonb_strip_nulls(jsonb_build_object(
    'offer_id', app.catalog_offer_id(x.id),
    'source_category', app.api_source_category(x.profile),
    'price_status', case when x.margin is null or (x.unit_price is null and not exists (select 1 from public.lot_price_breaks b where b.lot_id = x.id))
                         then 'on_request' else 'priced' end,
    'stock', x.qty,
    'moq', x.min_qty,
    'order_multiple', 1,
    'standard_pack_quantity', x.standard_pack_quantity,
    'currency', case when x.margin is not null then x.out_cur end,
    'price_breaks', case when x.margin is null then '[]'::jsonb else coalesce(
       (select jsonb_agg(jsonb_build_object('quantity', b.q, 'unit_price', b.price) order by b.q) from breaks b where b.price is not null), '[]') end,
    'quote', case when p_qty is not null and x.margin is not null and p_qty >= x.min_qty then jsonb_build_object(
       'quantity', p_qty, 'unit_price', app.catalog_price(x.id, p_qty, x.out_cur),
       'extended_price', round(app.catalog_price(x.id, p_qty, x.out_cur) * p_qty, 2), 'covered', x.qty >= p_qty) end,
    'lead_time_days', x.lead_days,
    'packaging', app.packaging_code(x.pack),
    -- Libellé tel que déposé, sauf s'il s'agit en fait du boîtier (« 封装 » des anciens fichiers).
    'packaging_label', case when app.packaging_code(x.pack) is not null or btrim(coalesce(x.package_case, '')) = '' then nullif(btrim(x.pack), '') end,
    'date_code', nullif(x.date_code, ''),
    'ship_from', x.country,
    'country_of_origin', case when upper(x.country_of_origin) ~ '^[A-Z]{2}$' then upper(x.country_of_origin) end,
    'price_valid_until', case when x.sandbox then p_now + make_interval(hours => app.catalog_price_hours())
                         else least(p_now + make_interval(hours => app.catalog_price_hours()), x.confirmed_at + app.offer_ttl()) end,
    'updated_at', x.confirmed_at))
  from x
$$;

-- Produit (référence + fabricant) et ses offres, dans l'ordre donné. Les caractéristiques du produit sont la valeur
-- la plus fréquente parmi ses lots ; le fabricant, celui du référentiel s'il est connu.
create or replace function app.catalog_product_json(p_mpn text, p_lots text[], p_qty int, p_requested text, p_now timestamptz,
  p_with_offers boolean default true)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_mid text; v_name text; r jsonb;
begin
  select app.manufacturer_id(l.manufacturer) into v_mid
    from unnest(p_lots) with ordinality t(id, i) join public.lots l on l.id = t.id
   where btrim(l.manufacturer) <> '' order by t.i limit 1;
  select coalesce((select m.name from app.manufacturers m where m.id = v_mid),
                  (select mode() within group (order by btrim(l.manufacturer)) from public.lots l
                    where l.id = any (p_lots) and btrim(l.manufacturer) <> '')) into v_name;
  select jsonb_strip_nulls(jsonb_build_object(
      'mpn', p_mpn,
      'manufacturer', case when v_name is not null then jsonb_strip_nulls(jsonb_build_object('id', v_mid, 'name', v_name)) end,
      'description', mode() within group (order by l.description),
      'datasheet_url', mode() within group (order by l.datasheet_url),
      'product_url', 'https://central.parts/recherche/?q=' || p_mpn,
      'package_case', mode() within group (order by l.package_case),
      'lifecycle', mode() within group (order by l.lifecycle),
      'eccn', mode() within group (order by l.eccn),
      'hts_code', mode() within group (order by l.hts_code)))
    into r from public.lots l where l.id = any (p_lots);
  if p_with_offers then
    r := r || jsonb_build_object('offers', coalesce((select jsonb_agg(app.catalog_offer_json(t.id, p_qty, p_requested, p_now) order by t.i)
                                                     from unnest(p_lots) with ordinality t(id, i)), '[]'));
  end if;
  return r;
end $$;

-- Lots publiables pour une référence (exacte, espaces ignorés) et un appelant (bac à sable ou non).
-- Fabricant demandé : même fabricant du référentiel (alias compris), ou même nom ; lot sans fabricant : gardé.
create or replace function app.catalog_lots(p_mpn text, p_manufacturer text, p_sources text[], p_sandbox boolean, p_now timestamptz)
returns table (lot_id text, sort_eur numeric)
language sql stable security definer set search_path = '' as $$
  select l.id, app.lot_price_for(l.id, greatest(coalesce(l.moq, 1), 1)) * c.eur_rate * (1 + app.offer_margin(l.seller_id) / 100)
    from public.lots l
    join public.organizations o on o.id = l.seller_id
    join public.currencies c on c.code = l.currency
   where upper(regexp_replace(l.mpn, '\s+', '', 'g')) = upper(regexp_replace(coalesce(p_mpn, ''), '\s+', '', 'g'))
     -- Les lots du bac à sable (fictifs) ne vieillissent pas : le bac à sable reste utilisable sans entretien.
     and l.qty > 0 and (o.sandbox or l.confirmed_at > p_now - app.offer_ttl())
     and o.type = 'seller' and app.is_verified(o.id) and o.sandbox = p_sandbox
     and (p_manufacturer is null or btrim(p_manufacturer) = '' or btrim(l.manufacturer) = ''
          or app.mfr_key(l.manufacturer) = app.mfr_key(p_manufacturer)
          or app.manufacturer_id(l.manufacturer) = app.manufacturer_id(p_manufacturer))
     and (p_sources is null or app.api_source_category(o.profile) = any (p_sources))
   order by 2 asc nulls last, l.qty desc, l.id
   limit 20
$$;

-- Lots triés → produits : un par fabricant (référentiel, sinon nom), le plus gros stock d'abord.
create or replace function app.catalog_products(p_mpn text, p_lots text[], p_qty int, p_requested text, p_now timestamptz)
returns jsonb language sql volatile security definer set search_path = '' as $$
  with l as (
    select t.id, t.i, l.qty, coalesce(app.manufacturer_id(l.manufacturer), 'n:' || coalesce(app.mfr_key(l.manufacturer), '')) as k
      from unnest(coalesce(p_lots, '{}')) with ordinality t(id, i) join public.lots l on l.id = t.id),
  g as (select k, array_agg(id order by i) as lots, sum(qty) as stock, min(i) as first from l group by k)
  select coalesce(jsonb_agg(app.catalog_product_json(p_mpn, g.lots, p_qty, p_requested, p_now) order by g.stock desc, g.first), '[]')
    from g
$$;

-- ------------------------------------------------------------ API
-- Erreurs : 22023 (detail : champ).
create or replace function public.catalog_offers(p_org text, p_mpn text, p_manufacturer text default null, p_qty int default null,
  p_currency text default null, p_sources text[] default null, p_sandbox boolean default false, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_lots text[]; v_bad text[]; v_mpn text;
begin
  if coalesce(btrim(p_mpn), '') = '' or length(p_mpn) > 80 then raise exception 'Référence (mpn) requise' using errcode = '22023', detail = 'mpn'; end if;
  if p_qty is not null and (p_qty < 1 or p_qty > 100000000) then raise exception 'Quantité invalide' using errcode = '22023', detail = 'qty'; end if;
  if p_currency is not null and app.norm_currency(p_currency) is null then raise exception 'Devise non acceptée' using errcode = '22023', detail = 'currency'; end if;
  select array_agg(s) into v_bad from unnest(coalesce(p_sources, '{}')) s where s not in ('manufacturer', 'authorized_distributor', 'broker_surplus');
  if v_bad is not null then raise exception 'Catégorie de source inconnue' using errcode = '22023', detail = 'source_category'; end if;
  v_mpn := upper(regexp_replace(btrim(p_mpn), '\s+', '', 'g'));
  select array_agg(lot_id order by sort_eur nulls last) into v_lots from app.catalog_lots(p_mpn, p_manufacturer, p_sources, p_sandbox, p_now);
  if v_lots is not null then perform app.count_offer_views(v_lots, p_now); end if;
  return jsonb_strip_nulls(jsonb_build_object('mpn', v_mpn, 'quantity', p_qty, 'currency_requested', app.norm_currency(p_currency),
    'products', app.catalog_products(v_mpn, v_lots, p_qty, p_currency, p_now)));
end $$;

-- Nomenclature : { currency?, lines: [{line_id?, mpn, manufacturer?, quantity?}] }, 500 lignes au plus.
create or replace function public.catalog_search(p_org text, p jsonb, p_sandbox boolean default false, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare l jsonb; v_i int := 0; v_out jsonb := '[]'; v_line text; v_qty int; r jsonb;
begin
  if jsonb_typeof(p->'lines') <> 'array' or jsonb_array_length(p->'lines') not between 1 and app.catalog_max_lines() then
    raise exception 'De 1 à % lignes', app.catalog_max_lines() using errcode = '22023', detail = 'lines';
  end if;
  if p->>'currency' is not null and app.norm_currency(p->>'currency') is null then
    raise exception 'Devise non acceptée' using errcode = '22023', detail = 'currency';
  end if;
  for l in select * from jsonb_array_elements(p->'lines') loop
    v_i := v_i + 1;
    v_line := left(coalesce(nullif(btrim(l->>'line_id'), ''), v_i::text), 80);
    if coalesce(btrim(l->>'mpn'), '') = '' then
      raise exception 'Référence (mpn) vide' using errcode = '22023', detail = 'lines[' || v_line || '].mpn';
    end if;
    v_qty := case when coalesce(l->>'quantity', '') ~ '^\d{1,9}$' then (l->>'quantity')::int end;
    if l ? 'quantity' and (v_qty is null or v_qty < 1) then
      raise exception 'Quantité invalide' using errcode = '22023', detail = 'lines[' || v_line || '].quantity';
    end if;
    r := public.catalog_offers(p_org, l->>'mpn', l->>'manufacturer', v_qty, p->>'currency', null, p_sandbox, p_now);
    v_out := v_out || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('line_id', v_line, 'mpn', r->>'mpn', 'quantity', v_qty,
      'products', r->'products')));
  end loop;
  return jsonb_strip_nulls(jsonb_build_object('currency_requested', app.norm_currency(p->>'currency'), 'lines', v_out));
end $$;

-- Une offre et son prix à la quantité, avec son produit. Erreurs : P0002 inconnue ou plus publiée, 22023 sous le MOQ.
create or replace function public.catalog_offer(p_org text, p_offer_id text, p_qty int default null, p_currency text default null,
  p_sandbox boolean default false, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_lot text; v_moq int; v_mpn text;
begin
  select i.lot_id, greatest(coalesce(l.moq, 1), 1), upper(regexp_replace(l.mpn, '\s+', '', 'g')) into v_lot, v_moq, v_mpn
    from app.catalog_offer_ids i join public.lots l on l.id = i.lot_id join public.organizations o on o.id = l.seller_id
   where i.offer_id = p_offer_id and l.qty > 0 and (o.sandbox or l.confirmed_at > p_now - app.offer_ttl())
     and app.is_verified(o.id) and o.sandbox = p_sandbox;
  if v_lot is null then raise exception 'Offre inconnue ou expirée' using errcode = 'P0002'; end if;
  if p_qty is not null and p_qty < v_moq then raise exception 'Quantité sous le minimum de commande (%)', v_moq using errcode = '22023', detail = 'qty'; end if;
  if p_currency is not null and app.norm_currency(p_currency) is null then raise exception 'Devise non acceptée' using errcode = '22023', detail = 'currency'; end if;
  perform app.count_offer_views(array[v_lot], p_now);
  return app.catalog_offer_json(v_lot, p_qty, p_currency, p_now)
      || jsonb_build_object('product', app.catalog_product_json(v_mpn, array[v_lot], p_qty, p_currency, p_now, false));
end $$;

-- Fabricants présents dans le stock publiable : identifiant et alias du référentiel s'il le connaît.
-- p_q : début du nom ou d'un alias. 50 au plus.
create or replace function public.catalog_manufacturers(p_q text default '', p_sandbox boolean default false, p_now timestamptz default now())
returns jsonb language sql stable security definer set search_path = '' as $$
  with l as (
    select l.mpn, btrim(l.manufacturer) as raw, app.manufacturer_id(l.manufacturer) as mid
      from public.lots l join public.organizations o on o.id = l.seller_id
     where btrim(l.manufacturer) <> '' and l.qty > 0 and (o.sandbox or l.confirmed_at > p_now - app.offer_ttl())
       and app.is_verified(o.id) and o.sandbox = p_sandbox),
  g as (
    -- Graphie la plus fréquente pour un nom hors référentiel (indépendante de la collation de la base).
    select l.mid, coalesce(m.name, mode() within group (order by l.raw)) as name, m.aliases,
           count(distinct upper(regexp_replace(l.mpn, '\s+', '', 'g'))) as parts
      from l left join app.manufacturers m on m.id = l.mid
     group by l.mid, m.name, m.aliases, case when l.mid is null then app.mfr_key(l.raw) end)
  select jsonb_build_object('manufacturers', coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'id', g.mid, 'name', g.name, 'aliases', case when cardinality(g.aliases) > 0 then to_jsonb(g.aliases) end, 'parts', g.parts))
           order by g.name), '[]'))
    from g
   where coalesce(p_q, '') = '' or app.mfr_key(g.name) like app.mfr_key(p_q) || '%'
      or exists (select 1 from unnest(coalesce(g.aliases, '{}')) a where app.mfr_key(a) like app.mfr_key(p_q) || '%')
$$;

create or replace function public.admin_offer_views(p_org text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin perform app.require_admin(); return public.supplier_offer_views(upper(p_org)); end $$;

-- ------------------------------------------------------------ offres consolidées des RFQ (remplace 20261102000020)
-- Mêmes noms de champs que l'API d'offres : fabricant {id, name}, conditionnement en liste fermée et libellé,
-- conditionnement complet, pays d'origine. Toujours jamais : fournisseur, pseudonyme, SKU, lot, prix net.
create or replace function public.rfq_offers_for_client(p_org text, p_id text, p_now timestamptz default now())
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare d public.demands;
begin
  select * into d from public.demands where id = upper(p_id) and client_org_id = p_org;
  if d.id is null then raise exception 'Demande inconnue' using errcode = 'P0002'; end if;
  return jsonb_build_object('demand_id', d.id, 'status', app.rfq_api_status(d.status), 'currency', d.currency,
    'offers', coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
               'offer_id', f.id, 'rank', f.rank, 'mpn', upper(regexp_replace(l.mpn, '\s+', '', 'g')),
               'manufacturer', case when btrim(l.manufacturer) <> '' then jsonb_strip_nulls(jsonb_build_object(
                  'id', app.manufacturer_id(l.manufacturer),
                  'name', coalesce((select m.name from app.manufacturers m where m.id = app.manufacturer_id(l.manufacturer)), btrim(l.manufacturer)))) end,
               'source_category', app.api_source_category(s.profile), 'price_status', 'priced',
               'quantity', d.qty, 'stock', l.qty, 'standard_pack_quantity', l.standard_pack_quantity,
               'currency', f.buyer_currency, 'unit_price', f.unit_price,
               'extended_price', round(f.unit_price * d.qty, 2), 'lead_time_days', f.lead_days,
               'date_code', nullif(f.date_code, ''), 'packaging', app.packaging_code(l.pack),
               'packaging_label', case when app.packaging_code(l.pack) is not null or btrim(coalesce(l.package_case, '')) = '' then nullif(btrim(l.pack), '') end,
               'package_case', l.package_case, 'ship_from', s.country,
               'country_of_origin', case when upper(l.country_of_origin) ~ '^[A-Z]{2}$' then upper(l.country_of_origin) end,
               'price_valid_until', f.valid_until)) order by f.rank)
        from public.offers f
        join public.lots l on l.id = f.lot_id
        join public.organizations s on s.id = f.seller_id
       where f.demand_id = d.id and f.status in ('open', 'accepted') and f.valid_until > p_now), '[]'));
end $$;
revoke execute on function public.rfq_offers_for_client(text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.rfq_offers_for_client(text, text, timestamptz) to service_role;

-- ------------------------------------------------------------ lecture des fichiers de stock (remplace 20261102000017)
-- Mêmes règles qu'en 20261102000017, avec les champs facultatifs du tri DigiKey / TI : quantité d'un conditionnement
-- complet, boîtier, cycle de vie, ECCN, code HTS, pays d'origine.
create or replace function public.apply_stock_import_batch(p_import text, p_rows jsonb, p_rejected jsonb default '[]')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  imp public.stock_imports;
  r jsonb;
  v_cur text; v_mpn text; v_sku text; v_dc text; v_qty integer; v_moq integer; v_lot text; v_other text; v_lead smallint; v_src text; curs jsonb := '{}';
  v_spq integer; v_case text; v_life text; v_eccn text; v_hts text; v_coo text;
  -- Complétude des fiches produit (fabricant reconnu, description, fiche technique, boîtier, cycle de vie, ECCN, HTS).
  c_lines int := 0; c_mfr int := 0; c_desc int := 0; c_ds int := 0; c_case int := 0; c_life int := 0; c_eccn int := 0; c_hts int := 0;
  c_unknown text[] := '{}';
  n_created int := 0; n_updated int := 0; n_dupes int := 0; n_nodc int := 0;
  rej jsonb := coalesce(p_rejected, '[]'); dupes jsonb := '[]'; v_org_cur text;
begin
  select * into imp from public.stock_imports where id = p_import for update;
  if imp.id is null then raise exception 'Import inconnu : %', p_import; end if;
  if imp.org_id is null or imp.status in ('done', 'failed') then raise exception 'Import % non modifiable (%)', p_import, imp.status; end if;
  if imp.status = 'received' then update public.stock_imports set status = 'processing' where id = p_import; end if;
  select o.currency into v_org_cur from public.organizations o where o.id = imp.org_id;

  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]')) loop
    v_mpn := upper(btrim(coalesce(r->>'mpn', '')));
    v_sku := nullif(btrim(coalesce(r->>'sku', '')), '');
    v_dc := btrim(coalesce(r->>'dc', ''));
    v_qty := case when (r->>'qty') ~ '^\d+$' then (r->>'qty')::int end;
    v_moq := case when (r->>'moq') ~ '^\d+$' and (r->>'moq')::int >= 1 then (r->>'moq')::int end;
    v_lead := case when (r->>'lead') ~ '^\d{1,3}$' and (r->>'lead')::int <= 365 then (r->>'lead')::smallint end;
    -- Champs repris du tri DigiKey / TI (ADR 0024), facultatifs ; lus et normalisés par import-stock/parse.js.
    v_spq := case when (r->>'spq') ~ '^\d{1,9}$' and (r->>'spq')::int >= 1 then (r->>'spq')::int end;
    v_case := nullif(left(btrim(coalesce(r->>'case', '')), 60), '');
    v_life := case when r->>'lifecycle' in ('active', 'nrnd', 'last_time_buy', 'obsolete') then r->>'lifecycle' end;
    v_eccn := nullif(left(upper(btrim(coalesce(r->>'eccn', ''))), 20), '');
    v_hts := nullif(left(regexp_replace(coalesce(r->>'hts', ''), '[^0-9]', '', 'g'), 20), '');
    v_coo := case when upper(btrim(coalesce(r->>'coo', ''))) ~ '^[A-Z]{2}$' then upper(btrim(r->>'coo')) end;
    -- Devise : celle du fichier (colonne ou en-tête de prix), sinon celle choisie au dépôt, sinon celle de la société.
    if nullif(btrim(r->>'currency'), '') is not null then v_cur := upper(btrim(r->>'currency')); v_src := 'file';
    elsif imp.currency is not null then v_cur := imp.currency; v_src := 'upload';
    else v_cur := upper(coalesce(v_org_cur, 'USD')); v_src := 'company';
    end if;
    if v_cur in ('RMB', 'CNY') then v_cur := 'CNH'; end if;
    curs := jsonb_set(curs, array[v_cur || '|' || v_src], to_jsonb(coalesce((curs->>(v_cur || '|' || v_src))::int, 0) + 1));

    if v_mpn = '' then rej := rej || jsonb_build_object('line', r->'line', 'code', 'mpn_missing', 'reason', 'MPN manquant'); continue; end if;
    if v_qty is null or v_qty <= 0 then
      rej := rej || jsonb_build_object('line', r->'line', 'code', 'qty_invalid', 'reason', 'Quantité invalide'); continue;
    end if;
    if not exists (select 1 from public.currencies c where c.code = v_cur) then
      rej := rej || jsonb_build_object('line', r->'line', 'code', 'currency', 'reason', 'Devise non prise en charge : ' || v_cur); continue;
    end if;
    if v_dc = '' then n_nodc := n_nodc + 1; end if;
    c_lines := c_lines + 1;
    if app.manufacturer_id(r->>'mfr') is not null then c_mfr := c_mfr + 1;
    elsif nullif(btrim(r->>'mfr'), '') is not null and cardinality(c_unknown) < 20 and not (btrim(r->>'mfr') = any (c_unknown)) then
      c_unknown := c_unknown || btrim(r->>'mfr');
    end if;
    if nullif(btrim(r->>'desc'), '') is not null then c_desc := c_desc + 1; end if;
    if nullif(btrim(r->>'datasheet'), '') is not null then c_ds := c_ds + 1; end if;
    if v_case is not null then c_case := c_case + 1; end if;
    if v_life is not null then c_life := c_life + 1; end if;
    if v_eccn is not null then c_eccn := c_eccn + 1; end if;
    if v_hts is not null then c_hts := c_hts + 1; end if;

    -- Même lot chez le même vendeur : même SKU s'il existe, sinon même référence et même date code.
    -- Deux requêtes distinctes plutôt qu'un « case » : chacune utilise son index (seller_id, sku) ou
    -- lots_seller_mpn_dc ; avec le « case », chaque ligne relisait tout le stock du vendeur.
    v_lot := null;
    if v_sku is not null then
      select l.id into v_lot from public.lots l where l.seller_id = imp.org_id and l.sku = v_sku limit 1;
    else
      select l.id into v_lot from public.lots l
       where l.seller_id = imp.org_id and l.sku is null and upper(l.mpn) = v_mpn and l.date_code = v_dc limit 1;
    end if;

    if v_lot is not null then
      update public.lots set
        mpn = v_mpn,
        manufacturer = coalesce(nullif(r->>'mfr', ''), manufacturer),
        product_url = coalesce(nullif(r->>'url', ''), product_url),
        datasheet_url = coalesce(nullif(r->>'datasheet', ''), datasheet_url),
        description = coalesce(nullif(left(r->>'desc', 500), ''), description),
        lead_days = coalesce(v_lead, lead_days),
        qty = v_qty,
        moq = case when imp.replace_all then v_moq else coalesce(v_moq, moq) end,
        date_code = coalesce(nullif(v_dc, ''), date_code),
        pack = coalesce(nullif(r->>'pack', ''), pack),
        standard_pack_quantity = coalesce(v_spq, standard_pack_quantity),
        package_case = coalesce(v_case, package_case),
        lifecycle = coalesce(v_life, lifecycle),
        eccn = coalesce(v_eccn, eccn),
        hts_code = coalesce(v_hts, hts_code),
        country_of_origin = coalesce(v_coo, country_of_origin),
        unit_price = case when imp.replace_all then (r->>'price')::numeric else coalesce((r->>'price')::numeric, unit_price) end,
        currency = v_cur,
        confirmed_at = now(),
        import_id = p_import
      where id = v_lot;
      n_updated := n_updated + 1;
    else
      insert into public.lots (seller_id, source, sku, product_url, datasheet_url, description, lead_days, mpn, manufacturer,
                               qty, moq, date_code, pack, unit_price, currency, import_id, confirmed_at,
                               standard_pack_quantity, package_case, lifecycle, eccn, hts_code, country_of_origin)
      values (imp.org_id, 'file', v_sku, nullif(r->>'url', ''), nullif(r->>'datasheet', ''), nullif(left(r->>'desc', 500), ''),
              v_lead, v_mpn, coalesce(r->>'mfr', ''), v_qty, v_moq, v_dc, nullif(r->>'pack', ''), (r->>'price')::numeric,
              v_cur, p_import, now(), v_spq, v_case, v_life, v_eccn, v_hts, v_coo)
      returning id into v_lot;
      n_created := n_created + 1;
      -- Doublon possible : même référence, même date code, même quantité chez un autre vendeur (signalé, pas fusionné).
      select l.id into v_other from public.lots l
       where l.seller_id <> imp.org_id and upper(l.mpn) = v_mpn and l.date_code = v_dc and l.qty = v_qty limit 1;
      if v_other is not null then
        n_dupes := n_dupes + 1;
        dupes := dupes || jsonb_build_object('line', r->'line', 'lot', v_lot, 'same_as', v_other);
      end if;
    end if;

    -- Paliers : remplacés quand la ligne en fournit ; effacés dans un fichier complet qui n'en donne pas.
    if jsonb_typeof(r->'tiers') = 'object' and r->'tiers' <> '{}'::jsonb then
      delete from public.lot_price_breaks where lot_id = v_lot;
      insert into public.lot_price_breaks (lot_id, min_qty, unit_price)
        select v_lot, t.key::int, t.value::numeric from jsonb_each_text(r->'tiers') t
         where t.key ~ '^\d+$' and t.value ~ '^\d+(\.\d+)?$' and t.value::numeric >= 0;
    elsif imp.replace_all then
      delete from public.lot_price_breaks where lot_id = v_lot;
    end if;
  end loop;

  update public.stock_imports set
    rows_total = rows_total + jsonb_array_length(coalesce(p_rows, '[]')) + jsonb_array_length(coalesce(p_rejected, '[]')),
    created = created + n_created, updated = updated + n_updated,
    rejected = rejected + jsonb_array_length(rej), duplicates = duplicates + n_dupes,
    missing_date_code = missing_date_code + n_nodc,
    currency_used = (select coalesce(jsonb_object_agg(k, n), '{}') from (
      select k, sum(v::int) as n from (select * from jsonb_each_text(coalesce(currency_used, '{}')) union all
                                       select * from jsonb_each_text(curs)) e(k, v) group by k) s),
    -- le rapport garde au plus 1 000 lignes rejetées et 1 000 doublons ; les compteurs restent exacts
    report = jsonb_build_object(
      'rejected', (select coalesce(jsonb_agg(x), '[]') from (select x from jsonb_array_elements(report->'rejected' || rej) x limit 1000) s),
      'duplicates', (select coalesce(jsonb_agg(x), '[]') from (select x from jsonb_array_elements(report->'duplicates' || dupes) x limit 1000) s),
      -- Complétude des fiches produit, cumulée sur les lots de l'import ; 20 marques non reconnues au plus.
      'completeness', (select jsonb_build_object(
          'lines', coalesce((c->>'lines')::int, 0) + c_lines, 'manufacturer', coalesce((c->>'manufacturer')::int, 0) + c_mfr,
          'description', coalesce((c->>'description')::int, 0) + c_desc, 'datasheet', coalesce((c->>'datasheet')::int, 0) + c_ds,
          'package_case', coalesce((c->>'package_case')::int, 0) + c_case, 'lifecycle', coalesce((c->>'lifecycle')::int, 0) + c_life,
          'eccn', coalesce((c->>'eccn')::int, 0) + c_eccn, 'hts_code', coalesce((c->>'hts_code')::int, 0) + c_hts,
          'unknown_manufacturers', (select coalesce(jsonb_agg(u), '[]') from (select distinct u from (
              select jsonb_array_elements_text(coalesce(c->'unknown_manufacturers', '[]')) as u union select unnest(c_unknown)) a
              order by u limit 20) b))
        from (select report->'completeness' as c) x))
  where id = p_import;

  return jsonb_build_object('created', n_created, 'updated', n_updated, 'rejected', jsonb_array_length(rej), 'duplicates', n_dupes);
end $$;
revoke execute on function public.apply_stock_import_batch(text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.apply_stock_import_batch(text, jsonb, jsonb) to service_role;

-- ------------------------------------------------------------ qualité des fiches produit d'un fournisseur
-- Ce qu'on demande aux fabricants et aux distributeurs agréés, facultatif mais apprécié : fabricant reconnu par le
-- référentiel, description, fiche technique, boîtier, cycle de vie, ECCN, code HTS. Taux sur les lots publiables.
-- Destiné à la notation du fournisseur quand elle saura en tenir compte : aujourd'hui, aucun effet sur le classement.
create or replace function public.supplier_data_quality(p_org text, p_now timestamptz default now())
returns jsonb language sql stable security definer set search_path = '' as $$
  with l as (
    select (app.manufacturer_id(l.manufacturer) is not null) as mfr, coalesce(btrim(l.description), '') <> '' as descr,
           coalesce(btrim(l.datasheet_url), '') <> '' as ds, l.package_case is not null as pc, l.lifecycle is not null as lc,
           l.eccn is not null as ec, l.hts_code is not null as hs
      from public.lots l join public.organizations o on o.id = l.seller_id
     where l.seller_id = p_org and l.qty > 0 and (o.sandbox or l.confirmed_at > p_now - app.offer_ttl())),
  r as (
    select count(*) as n,
           round(avg(mfr::int), 3) as mfr, round(avg(descr::int), 3) as descr, round(avg(ds::int), 3) as ds,
           round(avg(pc::int), 3) as pc, round(avg(lc::int), 3) as lc, round(avg(ec::int), 3) as ec, round(avg(hs::int), 3) as hs
      from l)
  select jsonb_strip_nulls(jsonb_build_object('org', p_org, 'lots', r.n,
    'rates', case when r.n > 0 then jsonb_build_object('manufacturer', r.mfr, 'description', r.descr, 'datasheet', r.ds,
              'package_case', r.pc, 'lifecycle', r.lc, 'eccn', r.ec, 'hts_code', r.hs) end,
    -- Moyenne des sept taux, de 0 à 1.
    'completeness', case when r.n > 0 then round((r.mfr + r.descr + r.ds + r.pc + r.lc + r.ec + r.hs) / 7, 3) end,
    'counts_for_ranking', false))
    from r
$$;

create or replace function public.admin_supplier_data_quality(p_org text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin perform app.require_admin(); return public.supplier_data_quality(upper(p_org)); end $$;

-- Qualité des fiches de la société d'un contact (page /depot/) : la sienne seulement.
create or replace function public.supplier_own_data_quality(p_openid text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select public.supplier_data_quality(w.org_id) - 'org' from public.wechat_identities w where w.openid = p_openid and w.revoked_at is null
$$;
revoke execute on function public.supplier_data_quality(text, timestamptz), public.supplier_own_data_quality(text) from public, anon, authenticated;
grant execute on function public.supplier_data_quality(text, timestamptz), public.supplier_own_data_quality(text) to service_role;
revoke execute on function public.admin_supplier_data_quality(text) from public, anon;
grant execute on function public.admin_supplier_data_quality(text) to authenticated, service_role;

-- ------------------------------------------------------------ limite d'appels par clé
-- Un connecteur « une référence par appel » (format DigiKey ou TI) dépasse vite 60 appels par minute sur une
-- nomenclature : la limite se règle par clé (null : valeur par défaut, app.api_calls_per_minute()).
alter table public.api_keys add column if not exists calls_per_minute integer check (calls_per_minute between 1 and 6000);

-- Reprend rfq_auth (20261102000020) avec la limite propre à la clé.
create or replace function public.rfq_auth(p_key_hash text, p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare k public.api_keys; o public.organizations; v_hits int; v_min timestamptz := date_trunc('minute', p_now); v_limit int;
begin
  select * into k from public.api_keys where key_hash = p_key_hash and revoked_at is null;
  if k.id is null then raise exception 'Clé absente ou révoquée' using errcode = 'CP401'; end if;
  select * into o from public.organizations where id = k.org_id;
  if o.type <> 'buyer' then raise exception 'Clé non autorisée' using errcode = 'CP403'; end if;
  v_limit := coalesce(k.calls_per_minute, app.api_calls_per_minute());
  insert into app.api_hits (key_id, minute) values (k.id, v_min)
  on conflict (key_id, minute) do update set hits = app.api_hits.hits + 1 returning hits into v_hits;
  delete from app.api_hits where minute < p_now - interval '1 hour';
  update public.api_keys set last_used_at = p_now where id = k.id;
  if v_hits > v_limit then
    raise exception 'Limite d''appels atteinte' using errcode = 'CP429', detail = (60 - extract(second from p_now)::int)::text;
  end if;
  return jsonb_build_object('key_id', k.id, 'org_id', o.id, 'org_name', o.name,
    'sandbox', k.environment = 'sandbox' or o.sandbox, 'environment', k.environment, 'scopes', to_jsonb(k.scopes),
    'limit', v_limit, 'remaining', greatest(v_limit - v_hits, 0),
    'reset', extract(epoch from v_min + interval '1 minute')::bigint);
end $$;
revoke execute on function public.rfq_auth(text, timestamptz) from public, anon, authenticated;
grant execute on function public.rfq_auth(text, timestamptz) to service_role;

-- ------------------------------------------------------------ droits
revoke execute on function public.catalog_offers(text, text, text, int, text, text[], boolean, timestamptz),
  public.catalog_search(text, jsonb, boolean, timestamptz), public.catalog_offer(text, text, int, text, boolean, timestamptz),
  public.catalog_manufacturers(text, boolean, timestamptz), public.supplier_offer_views(text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.catalog_offers(text, text, text, int, text, text[], boolean, timestamptz),
  public.catalog_search(text, jsonb, boolean, timestamptz), public.catalog_offer(text, text, int, text, boolean, timestamptz),
  public.catalog_manufacturers(text, boolean, timestamptz), public.supplier_offer_views(text, timestamptz)
  to service_role;
revoke execute on function public.admin_offer_views(text) from public, anon;
grant execute on function public.admin_offer_views(text) to authenticated, service_role;
revoke execute on all functions in schema app from public, anon;
grant execute on all functions in schema app to service_role;
