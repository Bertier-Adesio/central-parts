-- Bac à sable de la route RFQ (ADR 0023) : un fournisseur de test, entièrement fictif, pour qu'une plateforme
-- (clé cp_test_) recette tout le cycle seule : création, validation simulée, réponse simulée, offres, webhooks.
-- À appliquer à la main dans le SQL Editor, après la migration 20261102000020. Rejouable.
--
-- Sans risque pour la production : une société « sandbox » n'apparaît dans aucune recherche ni offre publique
-- (filtre « not o.sandbox »), n'est appariée qu'aux demandes du bac à sable, et aucun message WeChat ne part
-- pour une demande du bac à sable (envoi simulé par la fonction rfq). L'openid ci-dessous n'existe pas dans WeChat.

insert into public.organizations (id, type, name, alias, city, country, currency, lang, profile, kyb, sandbox)
values ('SBX-RFQ', 'seller', 'Fournisseur partenaire du bac à sable (fictif)', 'V-SBX', 'Bac à sable', 'HK', 'USD', 'en',
        'Broker', 'validated', true)
on conflict (id) do nothing;

insert into public.wechat_identities (openid, org_id, role, label)
values ('sandbox-rfq-supplier', 'SBX-RFQ', 'admin', 'Contact fictif du bac à sable')
on conflict (openid) do nothing;

-- Références génériques, quantités et prix inventés (USD, prix net du fournisseur fictif).
insert into public.lots (id, seller_id, source, sku, mpn, manufacturer, qty, date_code, pack, unit_price, currency, lead_days)
values
  ('LOT-SBX-1', 'SBX-RFQ', 'manual', 'SBX-0001', 'NE555DR', 'Texas Instruments', 25000, '2430', 'Bande et bobine', 0.11, 'USD', 3),
  ('LOT-SBX-2', 'SBX-RFQ', 'manual', 'SBX-0002', 'LM358DR', 'Texas Instruments', 12000, '2418', 'Bande et bobine', 0.09, 'USD', 3),
  ('LOT-SBX-3', 'SBX-RFQ', 'manual', 'SBX-0003', 'STM32F103C8T6', 'STMicroelectronics', 3000, '2422', 'Plateau', 1.85, 'USD', 5),
  ('LOT-SBX-4', 'SBX-RFQ', 'manual', 'SBX-0004', 'GRM188R71H104KA93D', 'Murata', 400000, '2436', 'Bande et bobine', 0.004, 'USD', 2)
on conflict (id) do nothing;

-- Marge du fournisseur de test (valeur de démonstration, pas une marge réelle).
insert into app.seller_margins (org_id, margin_pct) values ('SBX-RFQ', 10)
on conflict (org_id) do nothing;
