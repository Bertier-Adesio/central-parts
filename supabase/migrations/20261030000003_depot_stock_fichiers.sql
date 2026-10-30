-- Dépôt des fichiers de stock (CSV, XLS, XLSX) par les fournisseurs, transformation en lots, et API de recherche.
-- Voir supabase/README.md (« Dépôt des fichiers de stock ») et data/formats.md.
--
-- Chemin d'un fichier : stock-imports/<id de l'organisation>/<nom du fichier>, par exemple S2/stock-2026-10-30.xlsx.
-- 1. Le dépôt crée une ligne dans stock_imports (déclencheur sur storage.objects).
-- 2. La fonction Edge import-stock lit le fichier, en déduit les lignes (format broker, Octopart, ECIA)
--    et les envoie par lots de quelques milliers à apply_stock_import_batch ; finish_stock_import clôt l'import.
-- 3. Le stock des vendeurs vérifiés est interrogeable par l'API REST : POST /rest/v1/rpc/search_stock.

create sequence app.imp_seq start 100;

-- ------------------------------------------------------------ suivi des imports
create table public.stock_imports (
  id            text primary key default app.ref('IMP', 'app.imp_seq'),
  org_id        text references public.organizations,     -- null si le dossier ne correspond à aucun vendeur
  storage_path  text not null unique,                     -- chemin dans le compartiment stock-imports
  file_name     text not null,
  format        text check (format in ('csv', 'xls', 'xlsx')),
  replace_all   boolean not null default false,           -- fichier complet : les lots absents passent à quantité 0
  status        text not null default 'received' check (status in ('received', 'processing', 'done', 'failed')),
  rows_total    integer not null default 0,
  created       integer not null default 0,
  updated       integer not null default 0,
  rejected      integer not null default 0,
  duplicates    integer not null default 0,              -- même référence, date code et quantité chez un autre vendeur
  missing_date_code integer not null default 0,
  withdrawn     integer not null default 0,              -- lots absents d'un fichier complet, remis à 0
  report        jsonb not null default '{"rejected": [], "duplicates": []}',
  error         text,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz
);
create index on public.stock_imports (org_id, received_at desc);

-- Dernier import qui a touché un lot (sert au remplacement d'un fichier complet).
alter table public.lots add column import_id text references public.stock_imports on delete set null;

alter table public.stock_imports enable row level security;
revoke all on public.stock_imports from anon;
revoke insert, update, delete, truncate on public.stock_imports from authenticated;
create policy own_or_ops on public.stock_imports for select to authenticated using (org_id = app.my_org() or app.is_ops());

-- ------------------------------------------------------------ compartiment privé
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('stock-imports', 'stock-imports', false, 52428800, array[
  'text/csv', 'text/plain', 'application/csv', 'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/octet-stream'])
on conflict (id) do nothing;

-- Un vendeur connecté dépose et relit ses seuls fichiers, dans le dossier de son organisation.
-- Les liens de dépôt signés (sans compte) et le tableau de bord passent outre ces règles.
create policy stock_imports_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'stock-imports' and (storage.foldername(name))[1] = app.my_org() and app.my_type() = 'seller');
create policy stock_imports_read on storage.objects for select to authenticated
  using (bucket_id = 'stock-imports' and ((storage.foldername(name))[1] = app.my_org() or app.is_ops()));

-- Chaque fichier déposé ouvre un import.
create or replace function app.on_stock_file() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_org text := (storage.foldername(new.name))[1];
  v_file text := regexp_replace(new.name, '^.*/', '');
  v_ext text := lower(substring(v_file from '\.([A-Za-z0-9]+)$'));
  v_ok boolean;
begin
  if new.bucket_id <> 'stock-imports' then return new; end if;
  select exists (select 1 from public.organizations o where o.id = v_org and o.type = 'seller') into v_ok;
  insert into public.stock_imports (org_id, storage_path, file_name, format, replace_all, status, error)
  values (case when v_ok then v_org end, new.name, v_file,
          case when v_ext in ('csv', 'xls', 'xlsx') then v_ext end,
          v_file ~* 'complet|full',   -- « stock-complet.xlsx » : le fichier remplace le stock précédent
          case when v_ok and v_ext in ('csv', 'xls', 'xlsx') then 'received' else 'failed' end,
          case when not v_ok then 'Dossier inconnu : le premier dossier doit être l''identifiant d''un vendeur'
               when v_ext is null or v_ext not in ('csv', 'xls', 'xlsx') then 'Format non pris en charge : CSV, XLS ou XLSX' end)
  on conflict (storage_path) do update
    set status = excluded.status, error = excluded.error, received_at = now(), processed_at = null,
        rows_total = 0, created = 0, updated = 0, rejected = 0, duplicates = 0, missing_date_code = 0, withdrawn = 0,
        report = '{"rejected": [], "duplicates": []}';
  return new;
end $$;

-- Sur insertion seulement : le stockage met aussi à jour la ligne (lecture, métadonnées), ce qui relancerait l'import.
-- Un nouveau dépôt porte donc un nouveau nom (date dans le nom) ; un fichier supprimé puis redéposé relance l'import.
create trigger stock_file_received after insert on storage.objects
  for each row execute function app.on_stock_file();

-- ------------------------------------------------------------ transformation en lots
-- p_rows : lignes déjà lues et normalisées par la fonction Edge, par exemple
--   {"line": 2, "mpn": "XC2S50-5TQ144C", "mfr": "AMD Xilinx", "sku": "HB-1", "url": "", "qty": 400,
--    "dc": "2011", "pack": "", "price": 38.5, "currency": "USD", "tiers": {"10": 40, "100": 39}}
-- p_rejected : lignes rejetées à la lecture ({"line": 5, "reason": "MPN manquant"}).
create or replace function public.apply_stock_import_batch(p_import text, p_rows jsonb, p_rejected jsonb default '[]')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  imp public.stock_imports;
  r jsonb;
  v_cur text; v_mpn text; v_sku text; v_dc text; v_qty integer; v_lot text; v_other text;
  n_created int := 0; n_updated int := 0; n_dupes int := 0; n_nodc int := 0;
  rej jsonb := coalesce(p_rejected, '[]'); dupes jsonb := '[]';
begin
  select * into imp from public.stock_imports where id = p_import for update;
  if imp.id is null then raise exception 'Import inconnu : %', p_import; end if;
  if imp.org_id is null or imp.status in ('done', 'failed') then raise exception 'Import % non modifiable (%)', p_import, imp.status; end if;
  if imp.status = 'received' then update public.stock_imports set status = 'processing' where id = p_import; end if;

  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]')) loop
    v_mpn := upper(btrim(coalesce(r->>'mpn', '')));
    v_sku := nullif(btrim(coalesce(r->>'sku', '')), '');
    v_dc := btrim(coalesce(r->>'dc', ''));
    v_qty := case when (r->>'qty') ~ '^\d+$' then (r->>'qty')::int end;
    v_cur := upper(btrim(coalesce(nullif(r->>'currency', ''),
               (select o.currency from public.organizations o where o.id = imp.org_id), 'USD')));
    if v_cur in ('RMB', 'CNY') then v_cur := 'CNH'; end if;

    if v_mpn = '' then rej := rej || jsonb_build_object('line', r->'line', 'reason', 'MPN manquant'); continue; end if;
    if v_qty is null or v_qty <= 0 then rej := rej || jsonb_build_object('line', r->'line', 'reason', 'Quantité invalide'); continue; end if;
    if not exists (select 1 from public.currencies c where c.code = v_cur) then
      rej := rej || jsonb_build_object('line', r->'line', 'reason', 'Devise non prise en charge : ' || v_cur); continue;
    end if;
    if v_dc = '' then n_nodc := n_nodc + 1; end if;

    -- Même lot chez le même vendeur : même SKU s'il existe, sinon même référence et même date code.
    select l.id into v_lot from public.lots l
     where l.seller_id = imp.org_id
       and (case when v_sku is not null then l.sku = v_sku else l.sku is null and upper(l.mpn) = v_mpn and l.date_code = v_dc end)
     limit 1;

    if v_lot is not null then
      update public.lots set
        mpn = v_mpn,
        manufacturer = coalesce(nullif(r->>'mfr', ''), manufacturer),
        product_url = coalesce(nullif(r->>'url', ''), product_url),
        qty = v_qty,
        date_code = coalesce(nullif(v_dc, ''), date_code),
        pack = coalesce(nullif(r->>'pack', ''), pack),
        unit_price = coalesce((r->>'price')::numeric, unit_price),
        currency = v_cur,
        import_id = p_import
      where id = v_lot;
      n_updated := n_updated + 1;
    else
      insert into public.lots (seller_id, source, sku, product_url, mpn, manufacturer, qty, date_code, pack, unit_price, currency, import_id)
      values (imp.org_id, 'file', v_sku, nullif(r->>'url', ''), v_mpn, coalesce(r->>'mfr', ''), v_qty, v_dc,
              nullif(r->>'pack', ''), (r->>'price')::numeric, v_cur, p_import)
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

    -- Paliers : remplacés quand la ligne en fournit.
    if jsonb_typeof(r->'tiers') = 'object' and r->'tiers' <> '{}'::jsonb then
      delete from public.lot_price_breaks where lot_id = v_lot;
      insert into public.lot_price_breaks (lot_id, min_qty, unit_price)
        select v_lot, t.key::int, t.value::numeric from jsonb_each_text(r->'tiers') t
         where t.key ~ '^\d+$' and t.value ~ '^\d+(\.\d+)?$' and t.value::numeric >= 0;
    end if;
  end loop;

  update public.stock_imports set
    rows_total = rows_total + jsonb_array_length(coalesce(p_rows, '[]')) + jsonb_array_length(coalesce(p_rejected, '[]')),
    created = created + n_created, updated = updated + n_updated,
    rejected = rejected + jsonb_array_length(rej), duplicates = duplicates + n_dupes,
    missing_date_code = missing_date_code + n_nodc,
    -- le rapport garde au plus 1 000 lignes rejetées et 1 000 doublons ; les compteurs restent exacts
    report = jsonb_build_object(
      'rejected', (select coalesce(jsonb_agg(x), '[]') from (select x from jsonb_array_elements(report->'rejected' || rej) x limit 1000) s),
      'duplicates', (select coalesce(jsonb_agg(x), '[]') from (select x from jsonb_array_elements(report->'duplicates' || dupes) x limit 1000) s))
  where id = p_import;

  return jsonb_build_object('created', n_created, 'updated', n_updated, 'rejected', jsonb_array_length(rej), 'duplicates', n_dupes);
end $$;

-- Clôt l'import : un fichier complet remet à 0 les lots du vendeur venus d'un fichier et absents de celui-ci.
create or replace function public.finish_stock_import(p_import text, p_error text default null)
returns public.stock_imports language plpgsql security definer set search_path = '' as $$
declare imp public.stock_imports; n int := 0;
begin
  select * into imp from public.stock_imports where id = p_import for update;
  if imp.id is null then raise exception 'Import inconnu : %', p_import; end if;
  if p_error is null and imp.replace_all and imp.org_id is not null then
    update public.lots set qty = 0
     where seller_id = imp.org_id and source in ('file', 'sftp') and qty > 0 and import_id is distinct from p_import;
    get diagnostics n = row_count;
  end if;
  update public.stock_imports
     set status = case when p_error is null then 'done' else 'failed' end,
         error = p_error, withdrawn = n, processed_at = now()
   where id = p_import
  returning * into imp;
  insert into public.events (actor, text, ref) values ('import-stock',
    format('Import %s (%s) : %s lot(s) créé(s), %s mis à jour, %s ligne(s) rejetée(s), %s retiré(s)%s',
           imp.id, imp.file_name, imp.created, imp.updated, imp.rejected, imp.withdrawn,
           case when p_error is not null then ' ; échec : ' || p_error else '' end), imp.org_id);
  return imp;
end $$;

-- ------------------------------------------------------------ API de recherche
-- POST /rest/v1/rpc/search_stock {"q": "XC2S50"} : offre Inventory et disponibilités Opportunity des vendeurs
-- vérifiés, agrégées par référence, sans identité ni prix du vendeur (le prix se forme par l'enchère).
create or replace function public.search_stock(q text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare k text := upper(btrim(coalesce(q, '')));
begin
  if length(k) < 2 then raise exception 'Saisir au moins 2 caractères' using errcode = '22023'; end if;
  return jsonb_build_object(
    'query', k,
    'inventory', (select coalesce(jsonb_agg(jsonb_build_object('mpn', i.mpn, 'manufacturer', i.manufacturer, 'source', i.source,
                    'stock', i.stock, 'lead_days', i.lead_days, 'unit_price', i.unit_price, 'currency', i.currency) order by i.mpn), '[]')
                  from public.inventory_offers i where upper(i.mpn) like '%' || k || '%'),
    'opportunity', (select coalesce(jsonb_agg(g order by g->>'mpn'), '[]') from (
                    select jsonb_build_object('mpn', upper(l.mpn), 'manufacturer', max(l.manufacturer), 'lots', count(*),
                             'quantity', sum(l.qty), 'date_codes', jsonb_agg(distinct l.date_code) filter (where l.date_code <> ''),
                             'verified', true) as g
                      from public.lots l
                     where upper(l.mpn) like '%' || k || '%' and l.qty > 0 and app.is_verified(l.seller_id)
                     group by upper(l.mpn)) s));
end $$;

-- Droits : la transformation est réservée au service serveur ; la recherche aux utilisateurs connectés.
revoke execute on function public.apply_stock_import_batch(text, jsonb, jsonb), public.finish_stock_import(text, text) from public, anon, authenticated;
grant execute on function public.apply_stock_import_batch(text, jsonb, jsonb), public.finish_stock_import(text, text) to service_role;
revoke execute on function public.search_stock(text) from public, anon;
grant execute on function public.search_stock(text) to authenticated, service_role;
revoke execute on function app.on_stock_file() from public, anon, authenticated;
grant usage on sequence app.imp_seq to service_role;
