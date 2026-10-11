-- Yuan offshore (CNH) à la place du CNY, et registre du compte dédié renommé (plus de mot « escrow »).
-- Voir docs/decisions/0008-parcours-prix-detaille-vocabulaire.md.

-- ------------------------------------------------------------ CNY → CNH
-- Sans effet sur une base vide (les devises arrivent par seed.sql) ; sur une base déjà remplie,
-- crée CNH à partir de CNY, reporte toutes les références, puis supprime CNY.
do $$
declare r record;
begin
  if exists (select 1 from public.currencies where code = 'CNY') then
    insert into public.currencies (code, name, eur_rate, rate_at, account_label)
      select 'CNH', 'Yuan offshore (CNH)', eur_rate, rate_at, account_label from public.currencies where code = 'CNY'
      on conflict (code) do nothing;
    for r in
      select c.conrelid::regclass as tbl, a.attname as col
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
      where c.contype = 'f' and c.confrelid = 'public.currencies'::regclass
    loop
      execute format('update %s set %I = %L where %I = %L', r.tbl, r.col, 'CNH', r.col, 'CNY');
    end loop;
    delete from public.currencies where code = 'CNY';
  end if;
end $$;

-- ------------------------------------------------------------ registre du compte dédié
-- Le registre des mouvements reste en ajout seul ; politiques, droits et déclencheur suivent le renommage.
alter table public.escrow_movements rename to funds_movements;
alter trigger escrow_movements_append_only on public.funds_movements rename to funds_movements_append_only;
alter view public.escrow_balances rename to funds_balances;
