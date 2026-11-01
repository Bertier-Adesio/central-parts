# 0021 — Listes des vendeurs : lien personnel, contrôle ligne par ligne, expiration des offres

- Date : 2026-11-02
- Statut : acceptée pour la démonstration du 9 novembre 2026 (« nos offres », electronica) ; seuil, axes et ordre d'affichage à préciser

## Contexte

Les vendeurs approuvés doivent charger leurs listes de composants simplement, à grande échelle, avant electronica. La page `/depot/` (ADR 0010, 0012) exige une connexion WeChat ; or des contacts de Hong Kong et des visiteurs européens ont déjà été bloqués par des outils liés à un compte (questionnaire Tencent). Les offres affichées aux acheteurs doivent être honnêtes sur leur fraîcheur : une liste chargée il y a un mois n'est plus « à jour ». Le vendeur reste anonyme pour l'acheteur, et Central.Parts reste entre les deux.

## Décision

### Accès par lien personnel
- Chaque vendeur approuvé (`approve_supplier`) reçoit un **lien personnel** `https://central.parts/depot/lien/#k=<jeton>`, créé par l'opérateur (`create_depot_link`). Pas de connexion WeChat, QQ ni Google.
- Le jeton (48 caractères hexadécimaux, 192 bits) est dans le fragment de l'adresse : il n'est envoyé ni au serveur de la page ni dans l'en-tête Referer. La base n'en garde que l'empreinte SHA-256. Un lien se révoque (`revoke_depot_links`) ; il cesse de fonctionner si le vendeur n'est plus approuvé.
- Le vendeur ne voit que ses propres dépôts et offres.
- `/depot/` (WeChat) reste inchangée et utilisable en parallèle.

### Format et contrôle
- Format recommandé : flux Octopart (`manufacturer;mpn;sku;quantity;price-break-1..5;price-usd-1..5;moq`), CSV à point-virgule et virgule décimale, ou `.xlsx` aux mêmes en-têtes ; UTF-8 ou GBK/GB18030. Modèle : `/depot/lien/modele.csv`. La colonne `distributor-url` est ignorée et jamais gardée.
- Chaque ligne est acceptée ou « à corriger », avec un **code de raison** traduit par la page (中文, EN, FR) : MPN vide, quantité non entière ou non positive, MOQ inférieur à 1, prix nul ou illisible, palier incomplet, quantités des paliers non croissantes, prix en hausse avec la quantité, devise non prise en charge. Ces contrôles s'appliquent aussi aux dépôts par `/depot/`.
- Le rapport s'affiche quelques secondes après le dépôt (traitement par la fonction `import-stock`, par paquets de 2 000 lignes) ; le vendeur corrige et recharge.

### Remplacement et historique
- Un dépôt par le lien **remplace** la liste précédente du vendeur : les références absentes passent à quantité 0, les paliers et le MOQ absents d'une ligne sont effacés. Chaque dépôt reste dans `stock_imports` avec son rapport.

### Date et expiration
- Chaque ligne porte la date de son dernier chargement (`lots.confirmed_at`). Au-delà du **seuil** (`app.settings.offer_ttl_days`, **7 jours** par défaut, modifiable sans code), l'offre passe « à reconfirmer » : le vendeur la voit comme telle, l'acheteur ne la voit plus, ni sur `/offres/` ni sur `/recherche/`.
- Chaque offre affichée porte « mis à jour le … ».

### API acheteur et vendeur anonyme
- Fonction Edge `offers` (`public.partner_offers`) : une ligne par offre, vendeur affiché « Fournisseur partenaire / Partner Supplier / 合作供应商 », sans nom, pseudonyme, SKU ni lien. Disponibilité par tranche et prix « à partir de » tout compris, comme la recherche publique (ADR 0013). Sans recherche : les 50 offres confirmées le plus récemment. 30 requêtes par minute et par adresse IP.
- Le champ `seller_category` est réservé au modèle à deux axes (ci-dessous) ; il vaut `null` tant que ce modèle n'est pas défini.
- Page de démonstration `/offres/`, non indexée.

### Données
- La base reste Supabase (ADR 0008). Les tables existantes tiennent lieu de `vendors` (`organizations`), `uploads` (`stock_imports`), `offers` (`lots`) et `offer_price_breaks` (`lot_price_breaks`) ; migration `20261102000012_listes_vendeurs.sql`.
- Les listes réelles des vendeurs ne vont jamais dans ce dépôt public : les fichiers de test (`tools/fixtures/`) sont fictifs.

## Reste à décider avec Bertier

- Seuil d'expiration définitif, et éventuel délai de grâce entre « à reconfirmer » et le retrait.
- Modèle à deux axes : axe 1, relation du vendeur avec le fabricant (fabricant, distributeur autorisé, stockiste non autorisé, courtier), déclarée puis vérifiée, avec les preuves demandées ; axe 2, relation avec Central.Parts (référencé, partenaire, privilégié) et ce qu'elle coûte au vendeur. Le profil actuel (`organizations.profile`) couvre en partie l'axe 1 ; les champs ne seront créés qu'après décision.
- Règle d'ordre d'affichage des offres (aujourd'hui : par référence, puis la plus récente).
- Hébergement de la base en production (Supabase aujourd'hui).

## Conséquences

- L'opérateur crée les liens depuis l'éditeur SQL de Supabase (`supabase/README.md`) et les transmet au vendeur par le canal de son choix.
- Toute offre non rechargée disparaît après le seuil : prévenir les vendeurs qu'il faut recharger leur liste régulièrement.
- Si la migration 20261101000010 (marges par vendeur) est appliquée après celle-ci, rejouer `20261102000012_listes_vendeurs.sql` (rejouable) pour rétablir l'expiration dans la recherche publique.
