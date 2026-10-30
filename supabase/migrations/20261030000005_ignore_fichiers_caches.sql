-- Le tableau de bord Supabase crée un fichier caché (.emptyFolderPlaceholder) quand on crée un dossier :
-- le dépôt de stock ignore désormais tout fichier dont le nom commence par un point, et retire les imports
-- en échec qu'il avait ouverts pour ces fichiers.

create or replace function app.on_stock_file() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_org text := (storage.foldername(new.name))[1];
  v_file text := regexp_replace(new.name, '^.*/', '');
  v_ext text := lower(substring(v_file from '\.([A-Za-z0-9]+)$'));
  v_ok boolean;
begin
  if new.bucket_id <> 'stock-imports' or v_file like '.%' then return new; end if;
  select exists (select 1 from public.organizations o where o.id = v_org and o.type = 'seller') into v_ok;
  insert into public.stock_imports (org_id, storage_path, file_name, format, replace_all, status, error)
  values (case when v_ok then v_org end, new.name, v_file,
          case when v_ext in ('csv', 'xls', 'xlsx') then v_ext end,
          v_file ~* 'complet|full',
          case when v_ok and v_ext in ('csv', 'xls', 'xlsx') then 'received' else 'failed' end,
          case when not v_ok then 'Dossier inconnu : le premier dossier doit être l''identifiant d''un vendeur'
               when v_ext is null or v_ext not in ('csv', 'xls', 'xlsx') then 'Format non pris en charge : CSV, XLS ou XLSX' end)
  on conflict (storage_path) do update
    set status = excluded.status, error = excluded.error, received_at = now(), processed_at = null,
        rows_total = 0, created = 0, updated = 0, rejected = 0, duplicates = 0, missing_date_code = 0, withdrawn = 0,
        report = '{"rejected": [], "duplicates": []}';
  return new;
end $$;

revoke execute on function app.on_stock_file() from public, anon, authenticated;

delete from public.stock_imports where status = 'failed' and file_name like '.%';
