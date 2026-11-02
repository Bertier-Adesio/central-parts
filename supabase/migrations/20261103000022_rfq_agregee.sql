-- Lecture agrégée d'une RFQ par la plateforme (ADR 0023, complément du 3 novembre 2026) : GET /v1/rfqs/{rfq_id}.
-- Une RFQ de N lignes donne N demandes DEM-… ; la plateforme devait recalculer elle-même le statut du devis et
-- lire les offres demande par demande. Ces fonctions rendent en un appel le statut d'ensemble, le décompte par
-- statut et, ligne par ligne, les offres consolidées (mêmes champs que GET /v1/demands/{id}/offers).
-- Lecture seule ; rien n'est modifié. Rejouable. À appliquer après 20261102000021.

-- ------------------------------------------------------------ statut d'ensemble
-- Statuts de l'API des lignes → statut de la RFQ, dans cet ordre :
--   in_progress   au moins une ligne pending_validation ou open (le devis peut encore évoluer) ;
--   offers_ready  sinon, au moins une ligne offers_ready ou ordered ;
--   cancelled     sinon, toutes les lignes annulées ;
--   no_offer      sinon (lignes refusées, sans offre ou annulées).
-- Un statut inconnu compte comme en cours : la RFQ ne passe jamais à tort pour terminée.
create or replace function app.rfq_aggregate_status(p_statuses text[]) returns text
language sql immutable set search_path = '' as $$
  select case
    when coalesce(cardinality(p_statuses), 0) = 0 then null
    when exists (select 1 from unnest(p_statuses) s
                  where s not in ('offers_ready', 'ordered', 'no_offer', 'rejected', 'cancelled')) then 'in_progress'
    when 'offers_ready' = any(p_statuses) or 'ordered' = any(p_statuses) then 'offers_ready'
    when 'cancelled' = all(p_statuses) then 'cancelled'
    else 'no_offer' end
$$;

-- ------------------------------------------------------------ une RFQ
-- null si la RFQ n'existe pas ou appartient à une autre plateforme (la fonction Edge répond 404).
-- Jamais : fournisseur, pseudonyme, nombre de fournisseurs consultés, SKU, lot, prix net.
create or replace function public.rfq_for_client(p_org text, p_rfq text, p_now timestamptz default now())
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_ref text := upper(btrim(coalesce(p_rfq, '')));
  v_first public.demands;
  v_lines jsonb;
  v_statuses text[];
begin
  select * into v_first from public.demands
   where batch_ref = v_ref and client_org_id = p_org order by id limit 1;
  if v_first.id is null then return null; end if;

  select coalesce(jsonb_agg(
           (app.rfq_demand_json(d) - 'rfq_id' - 'customer_reference' - 'currency' - 'ship_to_country' - 'sandbox')
           || jsonb_build_object('offers', case when d.status in ('offers', 'ordered')
                then public.rfq_offers_for_client(p_org, d.id, p_now)->'offers' else '[]'::jsonb end)
           order by d.id), '[]'),
         array_agg(app.rfq_api_status(d.status) order by d.id)
    into v_lines, v_statuses
    from public.demands d
   where d.batch_ref = v_ref and d.client_org_id = p_org;

  return jsonb_strip_nulls(jsonb_build_object(
    'rfq_id', v_ref,
    'customer_reference', v_first.customer_reference,
    'status', app.rfq_aggregate_status(v_statuses),
    'currency', v_first.currency,
    'ship_to_country', v_first.zone,
    'created_at', v_first.created_at,
    'sandbox', case when v_first.sandbox then true end,
    'lines_count', cardinality(v_statuses),
    'status_counts', (select jsonb_object_agg(s, n) from
                        (select s, count(*) as n from unnest(v_statuses) s group by s) c),
    'offers_count', (select coalesce(sum(jsonb_array_length(l->'offers')), 0) from jsonb_array_elements(v_lines) l),
    -- Validité la plus proche parmi les offres rendues : au-delà, une partie du devis n'est plus valable.
    'price_valid_until', (select min((o->>'price_valid_until')::timestamptz)
                            from jsonb_array_elements(v_lines) l, jsonb_array_elements(l->'offers') o),
    'lines', v_lines));
end $$;

-- ------------------------------------------------------------ liste des RFQ
-- Résumé sans les offres : 100 RFQ au plus, les plus récentes d'abord. Filtres : statut d'ensemble,
-- customer_reference, created_since.
create or replace function public.rfqs_for_client(p_org text, p_status text default null,
  p_customer_reference text default null, p_created_since timestamptz default null)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(j order by created_at desc, rfq_id desc), '[]') from (
    select jsonb_strip_nulls(jsonb_build_object(
             'rfq_id', g.batch_ref, 'customer_reference', g.customer_reference,
             'status', app.rfq_aggregate_status(g.statuses), 'currency', g.currency,
             'created_at', g.created_at, 'lines_count', cardinality(g.statuses),
             'sandbox', case when g.sandbox then true end)) as j,
           g.created_at, g.batch_ref as rfq_id
      from (select d.batch_ref, min(d.customer_reference) as customer_reference, min(d.currency::text) as currency,
                   min(d.created_at) as created_at, bool_or(d.sandbox) as sandbox,
                   array_agg(app.rfq_api_status(d.status) order by d.id) as statuses
              from public.demands d
             where d.client_org_id = p_org and d.batch_ref is not null
               and (p_customer_reference is null or d.customer_reference = p_customer_reference)
             group by d.batch_ref) g
     where (p_created_since is null or g.created_at >= p_created_since)
       and (p_status is null or app.rfq_aggregate_status(g.statuses) = p_status)
     order by g.created_at desc, g.batch_ref desc
     limit 100) s
$$;

revoke execute on function app.rfq_aggregate_status(text[]) from public, anon, authenticated;
revoke execute on function public.rfq_for_client(text, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.rfqs_for_client(text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.rfq_for_client(text, text, timestamptz) to service_role;
grant execute on function public.rfqs_for_client(text, text, text, timestamptz) to service_role;
