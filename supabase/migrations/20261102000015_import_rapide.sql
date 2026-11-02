-- Import des fichiers de stock : corrige la lenteur des gros fichiers (« canceling statement due to statement
-- timeout » sur un fichier de 7 885 lignes, 2 novembre 2026).
--
-- Cause : pour retrouver le lot existant d'une ligne, apply_stock_import_batch (20261102000012) filtrait avec
-- « case when sku … » : PostgreSQL ne pouvait utiliser aucun index et relisait tout le stock du vendeur pour
-- chaque ligne. Le temps d'un paquet croissait avec la taille du stock, jusqu'à dépasser le délai de Supabase.
-- Correction : deux requêtes distinctes, chacune servie par un index ; la devise du vendeur est lue une fois.
-- Aucun changement de comportement : mêmes règles de rapprochement, de rejet, de doublon et de paliers.
--
-- Corrige aussi app.ref (schéma initial) : lpad() TRONQUE un texte plus long que la largeur demandée. Au-delà
-- du numéro 9999, app.ref('LOT', …) renvoyait « LOT-1000 » pour 10000, 10001, 10002… : identifiants déjà pris,
-- donc tout nouveau lot refusé (duplicate key value violates unique constraint "lots_pkey"). Les numéros
-- au-delà de la largeur sont désormais écrits en entier (LOT-10000). Aucun identifiant existant ne change.
--
-- Rejouable. Ne modifie aucune donnée.

create or replace function app.ref(prefix text, seq regclass, width int default 4)
returns text language sql volatile security definer set search_path = '' as $$
  select prefix || '-' || lpad(n, greatest(width, length(n)), '0') from (select nextval(seq)::text as n) s
$$;

-- Lots sans SKU : rapprochés par vendeur, référence et date code.
create index if not exists lots_seller_mpn_dc on public.lots (seller_id, upper(mpn), date_code) where sku is null;

-- ------------------------------------------------------------ transformation des lignes (remplace 20261102000012)
create or replace function public.apply_stock_import_batch(p_import text, p_rows jsonb, p_rejected jsonb default '[]')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  imp public.stock_imports;
  r jsonb;
  v_cur text; v_mpn text; v_sku text; v_dc text; v_qty integer; v_moq integer; v_lot text; v_other text;
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
      insert into public.lots (seller_id, source, sku, product_url, mpn, manufacturer, qty, moq, date_code, pack, unit_price, currency, import_id, confirmed_at)
      values (imp.org_id, 'file', v_sku, nullif(r->>'url', ''), v_mpn, coalesce(r->>'mfr', ''), v_qty, v_moq, v_dc,
              nullif(r->>'pack', ''), (r->>'price')::numeric, v_cur, p_import, now())
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
