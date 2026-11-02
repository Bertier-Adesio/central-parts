-- Devise des fichiers de stock : choisie au dépôt, et rapportée avec sa provenance (ADR 0022, complément).
--
-- Ordre de priorité pour chaque ligne, inchangé sur le fond et désormais tracé :
--   1. la devise écrite dans le fichier (colonne currency / 币种, ou en-tête de prix price-usd-N) ;
--   2. sinon la devise choisie au dépôt (nouveau : obligatoire dans les pages /depot/ et /depot/lien/), transmise par
--      le suffixe « -devise-USD » du nom de fichier, comme « -complet » ;
--   3. sinon la devise de la société (réglage à l'inscription), pour les dépôts faits autrement (tableau de bord).
-- stock_imports.currency : devise choisie au dépôt ; stock_imports.currency_used : nombre de lignes par devise et
-- provenance, par exemple {"USD|file": 7885} ou {"USD|upload": 1812}, affiché dans les rapports d'import.
--
-- Remplace app.on_stock_file (20261030000005), apply_stock_import_batch (20261102000016, mêmes règles par ailleurs)
-- et admin_supplier (20261102000014 : le dernier import porte la devise). Rejouable. Ne modifie aucune donnée.

alter table public.stock_imports add column if not exists currency text references public.currencies;
alter table public.stock_imports add column if not exists currency_used jsonb not null default '{}';

-- ------------------------------------------------------------ dépôt d'un fichier (remplace 20261030000005)
create or replace function app.on_stock_file() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_org text := (storage.foldername(new.name))[1];
  v_file text := regexp_replace(new.name, '^.*/', '');
  v_ext text := lower(substring(v_file from '\.([A-Za-z0-9]+)$'));
  -- Devise choisie au dépôt : suffixe « -devise-USD » ajouté au nom par les fonctions depot et listes.
  v_cur text := upper(substring(v_file from '-devise-([A-Za-z]{3})\.[A-Za-z0-9]+$'));
  v_ok boolean;
begin
  if new.bucket_id <> 'stock-imports' or v_file like '.%' then return new; end if;
  select exists (select 1 from public.organizations o where o.id = v_org and o.type = 'seller') into v_ok;
  if v_cur is not null and not exists (select 1 from public.currencies c where c.code = v_cur) then v_cur := null; end if;
  insert into public.stock_imports (org_id, storage_path, file_name, format, replace_all, currency, status, error)
  values (case when v_ok then v_org end, new.name, v_file,
          case when v_ext in ('csv', 'xls', 'xlsx') then v_ext end,
          v_file ~* 'complet|full',
          v_cur,
          case when v_ok and v_ext in ('csv', 'xls', 'xlsx') then 'received' else 'failed' end,
          case when not v_ok then 'Dossier inconnu : le premier dossier doit être l''identifiant d''un vendeur'
               when v_ext is null or v_ext not in ('csv', 'xls', 'xlsx') then 'Format non pris en charge : CSV, XLS ou XLSX' end)
  on conflict (storage_path) do update
    set status = excluded.status, error = excluded.error, received_at = now(), processed_at = null,
        rows_total = 0, created = 0, updated = 0, rejected = 0, duplicates = 0, missing_date_code = 0, withdrawn = 0,
        report = '{"rejected": [], "duplicates": []}', currency = excluded.currency, currency_used = '{}';
  return new;
end $$;
revoke execute on function app.on_stock_file() from public, anon, authenticated;

-- ------------------------------------------------------------ transformation des lignes (remplace 20261102000016)
create or replace function public.apply_stock_import_batch(p_import text, p_rows jsonb, p_rejected jsonb default '[]')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  imp public.stock_imports;
  r jsonb;
  v_cur text; v_mpn text; v_sku text; v_dc text; v_qty integer; v_moq integer; v_lot text; v_other text; v_lead smallint; v_src text; curs jsonb := '{}';
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
        unit_price = case when imp.replace_all then (r->>'price')::numeric else coalesce((r->>'price')::numeric, unit_price) end,
        currency = v_cur,
        confirmed_at = now(),
        import_id = p_import
      where id = v_lot;
      n_updated := n_updated + 1;
    else
      insert into public.lots (seller_id, source, sku, product_url, datasheet_url, description, lead_days, mpn, manufacturer,
                               qty, moq, date_code, pack, unit_price, currency, import_id, confirmed_at)
      values (imp.org_id, 'file', v_sku, nullif(r->>'url', ''), nullif(r->>'datasheet', ''), nullif(left(r->>'desc', 500), ''),
              v_lead, v_mpn, coalesce(r->>'mfr', ''), v_qty, v_moq, v_dc, nullif(r->>'pack', ''), (r->>'price')::numeric,
              v_cur, p_import, now())
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
      'duplicates', (select coalesce(jsonb_agg(x), '[]') from (select x from jsonb_array_elements(report->'duplicates' || dupes) x limit 1000) s))
  where id = p_import;

  return jsonb_build_object('created', n_created, 'updated', n_updated, 'rejected', jsonb_array_length(rej), 'duplicates', n_dupes);
end $$;
revoke execute on function public.apply_stock_import_batch(text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.apply_stock_import_batch(text, jsonb, jsonb) to service_role;

-- ------------------------------------------------------------ back office : fiche (remplace 20261102000014)
-- Fiche d'une société : identité, contacts WeChat, stock, journal des décisions.
create or replace function public.admin_supplier(p_org text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare o public.organizations;
begin
  perform app.require_admin();
  select * into o from public.organizations where id = p_org and type = 'seller';
  if o.id is null then raise exception 'Société inconnue : %', p_org using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'org_id', o.id, 'name', o.name, 'alias', o.alias, 'region', app.region_of(o), 'code', o.registration_number,
    'city', o.city, 'country', o.country, 'profile', o.profile, 'currency', o.currency, 'lang', o.lang,
    'status', o.kyb, 'rejected_reason', o.rejected_reason, 'requested_at', o.created_at, 'decided_at', o.kyb_decided_at,
    'has_license', o.license_path is not null, 'registered_by', o.registered_by,
    'contacts', (select coalesce(jsonb_agg(jsonb_build_object('label', w.label, 'role', w.role, 'openid', w.openid,
                   'bound_at', w.bound_at, 'last_login_at', w.last_login_at) order by w.role, w.bound_at), '[]'::jsonb)
                   from public.wechat_identities w where w.org_id = o.id and w.revoked_at is null),
    'stock', (select jsonb_build_object('lines', count(*) filter (where l.qty > 0), 'lines_total', count(*),
                'sources', coalesce(jsonb_agg(distinct l.source) filter (where l.source is not null), '[]'::jsonb))
                from public.lots l where l.seller_id = o.id),
    'last_import', (select jsonb_build_object('file_name', i.file_name, 'status', i.status, 'received_at', i.received_at,
                      'rows_total', i.rows_total, 'rejected', i.rejected,
                      'currency', i.currency, 'currency_used', i.currency_used)
                      from public.stock_imports i where i.org_id = o.id order by i.received_at desc limit 1),
    'decisions', (select coalesce(jsonb_agg(jsonb_build_object('action', d.action, 'from_status', d.from_status,
                    'reason', d.reason, 'at', d.at,
                    'by', case when d.decided_by like 'admin:%' then substring(d.decided_by from 7)
                               when op.openid is not null then 'WeChat · ' || coalesce(op.label, op.openid)
                               else d.decided_by end) order by d.at desc, d.id desc), '[]'::jsonb)
                    from public.supplier_decisions d left join public.operators op on op.openid = d.decided_by
                   where d.org_id = o.id));
end $$;

revoke execute on function public.admin_supplier(text) from public, anon;
grant execute on function public.admin_supplier(text) to authenticated, service_role;
