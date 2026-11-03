# 0025 — Validité des offres par vendeur, reconfirmation en un geste et rappels avant expiration

- Date : 2026-11-03
- Statut : acceptée (Bertier, 3 novembre 2026) ; migration `20261103000023_validite_vendeurs.sql` à appliquer à la main

## Contexte

Depuis l'ADR 0021, une offre non rechargée depuis 7 jours n'est plus montrée aux acheteurs. La règle garde l'affichage honnête, mais elle a deux défauts :
- un fabricant dont le stock bouge peu doit recharger chaque semaine. Le premier fabricant approuvé (1 812 références, chargées le 3 novembre) aurait disparu le 10 novembre, premier jour d'electronica ;
- rien ne prévient le vendeur, et un stock inchangé demande quand même de rechercher et recharger un fichier.

## Décision

### Durée de validité
- **14 jours pour un fabricant, 7 jours pour un broker, un revendeur ou un distributeur** (type déclaré à l'inscription, `organizations.profile`).
- Réglable **vendeur par vendeur** : `organizations.offer_ttl_days`, de 1 à 90 jours. Vide, la durée suit le type.
- Les deux valeurs par défaut sont dans `app.settings` (`offer_ttl_days`, `offer_ttl_days_manufacturer`), modifiables sans code.
- La même durée s'applique partout où une offre est montrée ou vendue : recherche publique, `/offres/`, API d'offres des plateformes (y compris l'échéance du prix, `price_valid_until`), espace fournisseur. Les fonctions concernées sont recopiées depuis leur dernière migration ; seule l'expression de la durée change.

### Reconfirmation sans fichier
- Le vendeur peut reconfirmer **toutes ses offres en stock d'un geste** : bouton « 库存无变化，一键确认 / Stock unchanged: confirm » dans `/depot/` et `/depot/lien/`, ou réponse « 确认库存 » (« confirm stock ») au robot WeChat.
- Il atteste ainsi que son stock n'a pas changé. Chaque reconfirmation est journalisée (`stock_reconfirmations` : société, auteur, canal, nombre d'offres, date) et inscrite au journal des événements.
- Un stock qui change se met à jour comme avant, en chargeant un fichier.

### Rappels
- Fonction Edge `rappels`, appelée toutes les heures par une tâche planifiée (même secret que la tâche de la route RFQ).
- Rappel **« bientôt »** dans les 48 heures avant l'échéance, et **« expiré »** dans les 24 heures après. Chacun est envoyé une fois par échéance aux administrateurs WeChat du vendeur, en chinois puis en anglais, avec un lien de connexion personnel et la consigne « 确认库存 ».
- Les opérateurs reçoivent un résumé en anglais, qui signale les rappels que WeChat n'a pas délivrés.
- **Limite connue** : WeChat ne délivre un message libre (客服消息) qu'à un abonné qui a écrit au compte ou touché le menu dans les 48 dernières heures. Pour les autres, l'opérateur relance à la main. Un message modèle (模板消息), à activer dans la console WeChat, lèvera cette limite plus tard.

## Conséquences

- Les offres d'un fabricant déjà en ligne gagnent 7 jours dès l'application de la migration.
- Pour régler la durée d'un vendeur : `update public.organizations set offer_ttl_days = 30 where id = 'ORG-…';` (`null` pour revenir à la règle par type).
- Remplace, dans l'ADR 0021, « seuil de 7 jours pour tous ».
- À faire plus tard : message modèle WeChat ; durée et dernière reconfirmation visibles dans le back office ; relecture automatique d'un flux de stock (adresse du fichier du vendeur), pour supprimer tout geste.
