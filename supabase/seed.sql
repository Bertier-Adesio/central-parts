-- Données de démonstration, toutes fictives, pour le projet dev (et le bac à sable des brokers).
-- Reprend la maquette (site/app/js/core.js). Ne jamais charger ce fichier en production.
-- Les IBAN sont des valeurs de test, pas des comptes réels.

insert into public.currencies (code, name, eur_rate, account_label) values
  ('EUR', 'Euro', 1, 'FR76 ···· 0001 (fictif)'),
  ('USD', 'Dollar américain', 0.92, 'US ···· 0002 (fictif)'),
  ('CNY', 'Yuan renminbi', 0.128, 'CN ···· 0003 (fictif)'),
  ('HKD', 'Dollar de Hong Kong', 0.118, 'HK ···· 0004 (fictif)'),
  ('GBP', 'Livre sterling', 1.17, 'GB ···· 0005 (fictif)'),
  ('JPY', 'Yen', 0.0062, 'JP ···· 0006 (fictif)');

insert into public.lab_levels (id, name, price, days, tests) values
  (0, 'Pas de test', 0, 0, '{}'),
  (1, 'Contrôle visuel et marquage', 180, 2, '{visual,marking}'),
  (2, 'Visuel, marquage et rayons X', 420, 3, '{visual,marking,xray}'),
  (3, 'Niveau 2 et XRF', 560, 3, '{visual,marking,xray,xrf}'),
  (4, 'Niveau 3 et décapsulation', 950, 5, '{visual,marking,xray,xrf,decap}');

insert into public.organizations (id, type, name, alias, city, country, currency, lang, profile, kyb, sandbox) values
  ('B1',  'buyer',  'Atelier Lumen (fictif)', 'A-7Q2', 'Lyon', 'FR', 'EUR', 'fr', null, 'validated', false),
  ('B2',  'buyer',  'Novatech EMS (fictif)', 'A-3K9', 'Grenoble', 'FR', 'EUR', 'fr', null, 'pending', false),
  ('B3',  'buyer',  'Rocky Mountain Devices (fictif)', 'A-5R8', 'Denver', 'US', 'USD', 'en', null, 'validated', false),
  ('SBX', 'buyer',  'Acheteur du bac à sable', 'A-TEST', 'Bac à sable', 'FR', 'EUR', 'en', null, 'validated', true),
  ('S1',  'seller', 'Surplus Rhénanie GmbH (fictif)', 'V-1', 'Cologne', 'DE', 'EUR', 'en', 'Surplus EMS', 'validated', false),
  ('S2',  'seller', 'Harbour Components Ltd (fictif)', 'V-2', 'Hong Kong', 'HK', 'USD', 'en', 'Broker', 'validated', false),
  ('S3',  'seller', 'Nord Électronique (fictif)', 'V-3', 'Lille', 'FR', 'EUR', 'fr', 'Surplus OEM', 'validated', false),
  ('S4',  'seller', '深圳华强盈余电子 Huaqiang Surplus (fictif)', 'V-4', 'Shenzhen', 'CN', 'CNY', 'zh', 'Surplus EMS', 'validated', false),
  ('L1',  'lab',    'Laboratoire partenaire Europe (fictif)', 'LAB-EU', 'Eindhoven', 'NL', null, 'en', null, 'validated', false),
  ('BK',  'bank',   'Établissement teneur du compte dédié (à désigner)', 'BANQUE', 'Paris', 'FR', null, 'fr', null, 'validated', false),
  ('CP',  'ops',    'Central.Parts', 'Central.Parts', 'Paris', 'FR', 'EUR', 'fr', null, 'validated', false);

insert into public.org_bank_accounts (org_id, iban, holder) values
  ('B1', 'FR76 0000 0000 0000 0000 0000 001', 'Atelier Lumen (fictif)'),
  ('S1', 'DE00 0000 0000 0000 0000 01', 'Surplus Rhénanie GmbH (fictif)'),
  ('S3', 'FR76 0000 0000 0000 0000 0000 003', 'Nord Électronique (fictif)'),
  ('L1', 'NL00 TEST 0000 0000 01', 'Laboratoire partenaire Europe (fictif)');

-- S1 arrive à échéance dans quelques jours : il perd le statut « vérifié » s'il ne renouvelle pas.
insert into public.subscriptions (org_id, plan, starts_on, until) values
  ('S1', 'Vendeur Opportunity', current_date - 360, current_date + 5),
  ('S2', 'Vendeur Opportunity', current_date - 20, current_date + 340),
  ('S3', 'Vendeur Opportunity', current_date - 100, current_date + 250),
  ('S4', 'Vendeur Opportunity', current_date - 80, current_date + 280);

insert into public.inventory_offers (mpn, manufacturer, source, stock, lead_days, unit_price, currency) values
  ('STM32G071RBT6', 'STMicroelectronics', 'Distributeur agréé', 4800, 3, 2.41, 'EUR'),
  ('TPS62130RGTR', 'Texas Instruments', 'Distributeur agréé', 12000, 3, 1.12, 'EUR'),
  ('GRM188R71H104KA93D', 'Murata', 'Distributeur agréé', 900000, 3, 0.004, 'EUR'),
  ('CH340C', 'WCH', 'Fabricant, Chine', 80000, 7, 0.38, 'EUR'),
  ('ESP32-C3-MINI-1-N4', 'Espressif', 'Fabricant, Chine', 25000, 7, 1.95, 'EUR'),
  ('LM358DR', 'Texas Instruments', 'Distributeur agréé', 60000, 3, 0.09, 'EUR'),
  ('AMS1117-3.3', 'Advanced Monolithic Systems', 'Fabricant, Chine', 150000, 7, 0.05, 'EUR'),
  ('NE555DR', 'Texas Instruments', 'Distributeur agréé', 30000, 3, 0.11, 'EUR');

insert into public.connectors (id, org_id, name, base_url, search_path, auth_type, secret_ref, status, latency_ms) values
  ('CON-0001', 'S2', 'API produit Harbour v2', 'https://api.harbour.example/v2', '/products?mpn={mpn}', 'api_key', 'vault:connectors/CON-0001', 'ok', 420);

insert into public.channels (id, org_id, type, target, secret_ref, lang, events, status, label) values
  ('CH-0001', 'S4', 'wecom', null, 'vault:channels/CH-0001', 'zh', '{demand.created,offer.accepted,transaction.updated}', 'active', '企业微信群 · 销售报价'),
  ('CH-0002', 'S4', 'wechat_oa', 'openid-fictif-0002', null, 'zh', '{demand.created,offer.accepted}', 'active', '王经理 · 微信服务号');

insert into public.lots (id, seller_id, source, mpn, manufacturer, qty, date_code, pack, unit_price, currency, questionnaire, docs) values
  ('LOT-101', 'S1', 'manual', 'XC2S50-5TQ144C', 'AMD Xilinx', 1200, '2011', 'Plateau', 40, 'EUR',
   '{"origin":"Surplus OEM/EMS","resold":"Non","returns":"Non","new":"Neuf","visual":"Bon","tested":"Non","functional":"Non testé","dcHomogeneous":"Oui","oem":"Oui","opened":"Oui","pack":"Plateau","storage":"Oui","other":"Non"}',
   '{"photos":true,"coc":false,"proof":true,"datasheet":true,"inspection":false}'),
  ('LOT-102', 'S2', 'api', 'XC2S50-5TQ144C', 'AMD Xilinx', 400, '2009/2012', 'Plateau', 38, 'USD',
   '{"origin":"Autre broker","resold":"Refuse de répondre","returns":"Non","new":"Neuf","visual":"Bon","tested":"Non","functional":"Non testé","dcHomogeneous":"Non","oem":"Oui","opened":"Oui","pack":"Plateau","storage":"Inconnu","other":"Non"}',
   '{"photos":true,"coc":false,"proof":false,"datasheet":true,"inspection":false}'),
  ('LOT-103', 'S3', 'manual', 'MC68HC11E1CFNE2', 'NXP', 300, '2014', 'Tube', 21, 'EUR',
   '{"origin":"Stock propre","resold":"Non","returns":"Non","new":"Neuf","visual":"Bon","tested":"Non","functional":"Non testé","dcHomogeneous":"Oui","oem":"Oui","opened":"Non","pack":"Tube","storage":"Oui","other":"Non"}',
   '{"photos":true,"coc":true,"proof":true,"datasheet":true,"inspection":false}'),
  ('LOT-104', 'S1', 'manual', 'MC68HC11E1CFNE2', 'NXP', 90, '2012', 'Tube', 19, 'EUR', '{}',
   '{"photos":false,"coc":false,"proof":false,"datasheet":true,"inspection":false}'),
  ('LOT-105', 'S2', 'api', 'STM32F103C8T6', 'STMicroelectronics', 5000, '2023', 'Plateau', 2.1, 'USD', '{"origin":"Autre broker"}',
   '{"photos":true,"coc":false,"proof":false,"datasheet":true,"inspection":false}'),
  ('LOT-106', 'S3', 'manual', 'LT1086CM#PBF', 'Analog Devices', 800, '2016', 'Tube', 3.4, 'EUR',
   '{"origin":"Stock propre","resold":"Non","returns":"Non","new":"Neuf","visual":"Bon","tested":"Non","functional":"Non testé","dcHomogeneous":"Oui","oem":"Oui","opened":"Oui","pack":"Tube","storage":"Oui","other":"Non"}',
   '{"photos":true,"coc":true,"proof":true,"datasheet":true,"inspection":true}'),
  ('LOT-107', 'S4', 'file', 'XC2S50-5TQ144C', 'AMD Xilinx', 500, '', 'Plateau', 300, 'CNY', '{}',
   '{"photos":true,"coc":false,"proof":false,"datasheet":true,"inspection":false}');

insert into public.boms (id, buyer_id, name) values ('BOM-0012', 'B1', 'carte-capteur-v2.csv');

insert into public.inventory_orders (id, buyer_id, bom_id, currency, status) values ('INV-0018', 'B1', 'BOM-0012', 'EUR', 'shipped');
insert into public.inventory_order_lines (order_id, line_no, mpn, qty, unit_price, source) values
  ('INV-0018', 1, 'STM32G071RBT6', 100, 2.41, 'Distributeur agréé'),
  ('INV-0018', 2, 'TPS62130RGTR', 100, 1.12, 'Distributeur agréé');

insert into public.demands (id, buyer_id, bom_id, mpn, manufacturer, qty, dc_min, pack, zone, delivery, lead_days, target_price, currency, status, closes_at) values
  ('DEM-0427', 'B1', 'BOM-0012', 'XC2S50-5TQ144C', 'AMD Xilinx', 250, '2010', 'Plateau', 'Chine, Guangdong', 'Intégrateur, Shenzhen (Chine)', 10, 45, 'EUR', 'auction', now() + interval '2 days'),
  ('DEM-0428', 'B1', null, 'MC68HC11E1CFNE2', 'NXP', 250, '2010', 'Indifférent', 'France', 'Atelier, Lyon (France)', 10, null, 'EUR', 'auction', now() + interval '2 days');

insert into public.bom_lines (bom_id, line_no, mpn, qty, offer, demand_id) values
  ('BOM-0012', 1, 'STM32G071RBT6', 100, 'inventory', null),
  ('BOM-0012', 2, 'TPS62130RGTR', 100, 'inventory', null),
  ('BOM-0012', 3, 'XC2S50-5TQ144C', 250, 'opportunity', 'DEM-0427');

insert into public.demand_sellers (demand_id, seller_id, via) values
  ('DEM-0427', 'S1', 'catalog'), ('DEM-0427', 'S2', 'connector'),
  ('DEM-0428', 'S3', 'catalog'), ('DEM-0428', 'S1', 'catalog');

insert into public.bids (id, demand_id, seller_id, lot_id, net, currency, net_eur, date_code, lead_days) values
  ('BID-0899', 'DEM-0427', 'S1', 'LOT-101', 41.2, 'EUR', 41.2, '2011', 5),
  ('BID-0900', 'DEM-0427', 'S2', 'LOT-102', 43.25, 'USD', 39.79, '2009/2012', 4);

-- Transaction déjà engagée : fonds reçus, pièces au laboratoire.
insert into public.transactions (id, buyer_id, seller_id, lot_id, lot_snapshot, mpn, manufacturer, qty, net, net_currency, net_eur,
  currency, unit_price, lab_level, lab_id, lab_fee, total, delivery, incoterm, status, signed_buyer_at, signed_seller_at)
select 'TX-0041', 'B1', 'S3', 'LOT-106',
       jsonb_build_object('id', l.id, 'seller_id', l.seller_id, 'mpn', l.mpn, 'manufacturer', l.manufacturer, 'qty', l.qty,
                          'date_code', l.date_code, 'pack', l.pack, 'unit_price', l.unit_price, 'currency', l.currency,
                          'questionnaire', l.questionnaire, 'docs', l.docs),
       'LT1086CM#PBF', 'Analog Devices', 200, 3.4, 'EUR', 3.4, 'EUR', 3.81, 1, 'L1', 180, 3.81 * 200 + 180,
       'Atelier, Lyon (France)', 'DAP Lyon', 'at_lab', now() - interval '3 days', now() - interval '3 days'
from public.lots l where l.id = 'LOT-106';

insert into public.transaction_history (tx_id, at, text) values
  ('TX-0041', now() - interval '3 days', 'Fiche signée par les deux parties.'),
  ('TX-0041', now() - interval '2 days', 'Fonds reçus sur le compte dédié.'),
  ('TX-0041', now() - interval '2 days', 'Expédié au laboratoire, suivi DHL 1Z-FICTIF-0041.'),
  ('TX-0041', now() - interval '1 day', 'Pièces reçues au laboratoire : 200 unités, emballage intact.');

insert into public.lab_cases (id, tx_id, lab_id, level, status, received_qty) values ('LAB-0020', 'TX-0041', 'L1', 1, 'received', 200);

insert into public.escrow_movements (at, label, amount, currency, tx_id) values
  (now() - interval '2 days', 'Virement reçu · Atelier Lumen (fictif) · réf. TX-0041', 942, 'EUR', 'TX-0041');

-- Rattacher les comptes de test après les avoir créés dans Authentication > Users, par exemple :
-- insert into public.members (user_id, org_id, display_name) values
--   ((select id from auth.users where email = 'acheteur@example.test'), 'B1', 'Acheteur de test');
