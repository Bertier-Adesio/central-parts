-- Liens, fiches techniques, descriptions et délais des références ; fichiers de prix des fabricants (ADR 0022).
--
-- 1. lots.product_url (déjà présente) reçoit désormais le lien de la page du produit chez le vendeur (flux Octopart :
--    « distributor-url »), sans paramètres de suivi. Usage interne : visible des administrateurs (back office) et du
--    vendeur lui-même, jamais des acheteurs. Aucune fonction publique (recherche, offres, demandes d'achat) ne le
--    renvoie ; c'est vérifié par checks/12_liens_descriptions.sql.
-- 2. lots.datasheet_url (nouvelle) : fiche technique ou page du produit chez le fabricant, gardée à part pour pouvoir
--    être publiée plus tard sans jamais publier le lien du vendeur. Interne pour l'instant comme le lien du vendeur.
-- 3. lots.description (nouvelle) : description courte donnée par le vendeur, 500 caractères au plus. Interne pour
--    l'instant : elle pourrait contenir le nom ou les coordonnées du vendeur.
-- 4. lots.lead_days (déjà présente) est désormais remplie depuis la colonne de délai du fichier (« 1-3day » → 3).
-- Les quatre champs sont facultatifs : une ligne qui ne les donne pas garde les valeurs déjà connues.
--
-- Remplace apply_stock_import_batch (20261102000015, mêmes règles par ailleurs) et admin_lots (20261102000014 :
-- renvoie aussi lien, fiche technique et description ; la recherche porte aussi sur la description).
-- Rejouable. Ne modifie aucune donnée existante.

alter table public.lots add column if not exists datasheet_url text;
alter table public.lots add column if not exists description text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'lots_description_len') then
    alter table public.lots add constraint lots_description_len check (length(description) <= 500);
  end if;
end $$;

-- ------------------------------------------------------------ transformation des lignes (remplace 20261102000015)
create or replace function public.apply_stock_import_batch(p_import text, p_rows jsonb, p_rejected jsonb default '[]')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  imp public.stock_imports;
  r jsonb;
  v_cur text; v_mpn text; v_sku text; v_dc text; v_qty integer; v_moq integer; v_lot text; v_other text; v_lead smallint;
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
    v_cur := upper(btrim(coalesce(nullif(r->>'currency', ''), v_org_cur, 'USD')));
    if v_cur in ('RMB', 'CNY') then v_cur := 'CNH'; end if;

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
    -- le rapport garde au plus 1 000 lignes rejetées et 1 000 doublons ; les compteurs restent exacts
    report = jsonb_build_object(
      'rejected', (select coalesce(jsonb_agg(x), '[]') from (select x from jsonb_array_elements(report->'rejected' || rej) x limit 1000) s),
      'duplicates', (select coalesce(jsonb_agg(x), '[]') from (select x from jsonb_array_elements(report->'duplicates' || dupes) x limit 1000) s))
  where id = p_import;

  return jsonb_build_object('created', n_created, 'updated', n_updated, 'rejected', jsonb_array_length(rej), 'duplicates', n_dupes);
end $$;
revoke execute on function public.apply_stock_import_batch(text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.apply_stock_import_batch(text, jsonb, jsonb) to service_role;

-- ------------------------------------------------------------ back office : références (remplace 20261102000014)
-- Références, avec recherche (référence, marque, boîtier / emballage) et paliers de prix « de … à … ».
-- p_org null : tous les fournisseurs. 200 lignes au plus par page.
create or replace function public.admin_lots(p_org text default null, p_q text default '', p_limit int default 50, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_q text := '%' || replace(replace(replace(btrim(coalesce(p_q, '')), '\', '\\'), '%', '\%'), '_', '\_') || '%';
begin
  perform app.require_admin();
  return (with m as (
      select l.*, o.name as seller_name from public.lots l join public.organizations o on o.id = l.seller_id
       where (p_org is null or l.seller_id = p_org)
         and (l.mpn ilike v_q or l.manufacturer ilike v_q or coalesce(l.pack, '') ilike v_q
              or coalesce(l.description, '') ilike v_q))
    select jsonb_build_object('total', (select count(*) from m),
      'rows', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'org_id', p.seller_id, 'seller', p.seller_name,
          'mpn', p.mpn, 'manufacturer', p.manufacturer, 'pack', p.pack, 'qty', p.qty, 'unit_price', p.unit_price,
          'currency', p.currency, 'lead_days', p.lead_days, 'date_code', p.date_code, 'source', p.source,
          'updated_at', p.updated_at, 'description', p.description,
          'product_url', p.product_url, 'datasheet_url', p.datasheet_url,
          'breaks', (select coalesce(jsonb_agg(jsonb_build_object('from', b.min_qty, 'to', b.next_qty - 1, 'price', b.unit_price)
                       order by b.min_qty), '[]'::jsonb)
                       from (select pb.min_qty, pb.unit_price, lead(pb.min_qty) over (order by pb.min_qty) as next_qty
                               from public.lot_price_breaks pb where pb.lot_id = p.id) b))
          order by p.seller_name, upper(p.mpn), p.id), '[]'::jsonb)
        from (select * from m order by seller_name, upper(mpn), id
               limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0)) p)));
end $$;

revoke execute on function public.admin_lots(text, text, int, int) from public, anon;
grant execute on function public.admin_lots(text, text, int, int) to authenticated, service_role;
