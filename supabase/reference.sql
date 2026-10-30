-- Données de référence, à charger une fois après les migrations, sur tout projet (y compris avec de vraies données).
-- Contrairement à seed.sql, aucune société ni aucun lot fictif.
-- Les taux de change sont indicatifs : ils seront remplacés par le taux de référence (BCE) et ceux de la banque.

insert into public.currencies (code, name, eur_rate, account_label) values
  ('EUR', 'Euro', 1, 'Compte EUR (à ouvrir)'),
  ('USD', 'Dollar américain', 0.92, 'Compte USD (à ouvrir)'),
  ('CNH', 'Yuan offshore (CNH)', 0.128, 'Compte CNH (à ouvrir)'),
  ('HKD', 'Dollar de Hong Kong', 0.118, 'Compte HKD (à ouvrir)'),
  ('GBP', 'Livre sterling', 1.17, 'Compte GBP (à ouvrir)'),
  ('JPY', 'Yen', 0.0062, 'Compte JPY (à ouvrir)')
on conflict (code) do nothing;

insert into public.lab_levels (id, name, price, days, tests) values
  (0, 'Pas de test', 0, 0, '{}'),
  (1, 'Contrôle visuel et marquage', 180, 2, '{visual,marking}'),
  (2, 'Visuel, marquage et rayons X', 420, 3, '{visual,marking,xray}'),
  (3, 'Niveau 2 et XRF', 560, 3, '{visual,marking,xray,xrf}'),
  (4, 'Niveau 3 et décapsulation', 950, 5, '{visual,marking,xray,xrf,decap}')
on conflict (id) do nothing;

-- Central.Parts, opérateur de la plateforme.
insert into public.organizations (id, type, name, alias, city, country, currency, lang, kyb)
values ('CP', 'ops', 'Central.Parts', 'Central.Parts', 'Paris', 'FR', 'EUR', 'fr', 'validated')
on conflict (id) do nothing;
