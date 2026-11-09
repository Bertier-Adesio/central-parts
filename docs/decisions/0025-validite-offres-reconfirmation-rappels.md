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
- La fréquence des mises à jour (fichiers et reconfirmations) compte dans la note du fournisseur : ADR 0023, complément du 9 novembre 2026.
- À faire plus tard : message modèle WeChat ; relecture automatique d'un flux de stock (adresse du fichier du vendeur), pour supprimer tout geste. La durée et la dernière reconfirmation sont visibles dans le back office depuis le complément du 10 novembre 2026.

## Mémoire des offres et validité dans le back office (complément du 10 novembre 2026)

Contexte : le 9 novembre, les 7 881 offres d'un distributeur ont expiré la veille d'electronica. Bertier les a remises en ligne depuis l'accès opérateur à son dépôt, sans que le back office montre ni l'expiration ni la remise en ligne. Décision de Bertier (10 novembre 2026) : « il faut garder la mémoire des offres qui ont expiré, afficher l'âge d'une offre, par exemple “import du 10/11/2026” ».

- **Mémoire** : une offre expirée n'est jamais effacée. Elle reste en base, cachée aux acheteurs. La table `lot_history` (ajout seul) garde l'état précédent d'une offre à chaque changement :
  - prix, quantité ou devise modifiés (`changed`) ;
  - retrait par un fichier complet (`withdrawn`) ;
  - remise en ligne d'une offre expirée (`renewed`), avec sa date d'expiration et le canal (fichier, dépôt, lien, WeChat, Central.Parts) ;
  - suppression (`deleted`).

  Une simple reconfirmation d'une offre encore en ligne n'écrit rien, pour ne pas multiplier les lignes.
- **Âge d'une offre** (back office, onglet Stocks et offres) : « Import du 30/10/2026 », date de confirmation si elle diffère, état « En ligne jusqu'au … », « Expirée le … » ou « Retirée », et l'historique de la ligne. Un filtre par état permet de lister les offres en ligne, expirées ou retirées.
- **Validité par fournisseur** : nombre d'offres en ligne et expirées, prochaine échéance ou date d'expiration, dernier import et dernière reconfirmation, avec son canal et son motif, fréquence de mise à jour, et nombre d'expirations sur 90 jours.
  - « Relancer » envoie dans WeChat le même texte que les rappels automatiques.
  - « Remettre en ligne » renouvelle toutes les offres en stock d'un fournisseur. Le motif est obligatoire et inscrit dans `stock_reconfirmations.reason`. Le canal `admin` ne compte pas dans la fréquence de mise à jour du fournisseur (ADR 0023).
- **Accueil du back office** : ce qui attend une décision (fournisseurs, demandes d'achat, RFQ, recherches payantes), les offres sans marge et les envois WeChat non remis, les offres en ligne et expirées, les fournisseurs dont toutes les offres ont expiré ou dont l'échéance tombe dans les 48 heures, et la date des taux de la BCE.
- **Fiche fournisseur** : validité, dernière expiration et sa remise en ligne, note (RFQ et recherches payantes), marge appliquée et son origine, inscription aux recherches payantes, journal des reconfirmations.
- **Mise en œuvre** :
  - migration `20261110000043_memoire_offres.sql` ;
  - `seller_reconfirm` prend un motif facultatif et pose le canal pour l'historique ;
  - fonction `admin` : routes `/dashboard`, `/validity`, `/validity/reconfirm`, `/validity/remind` et `/lot-history` ;
  - contrôles : `supabase/checks/37_memoire_offres.sql`.
- **À trancher** : faut-il afficher l'âge d'une offre aux acheteurs ? Aujourd'hui, `/offres/` montre la date de mise à jour, mais pas la date d'import.
