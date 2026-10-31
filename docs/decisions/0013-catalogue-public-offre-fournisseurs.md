# 0013 — Catalogue public et offre faite aux fournisseurs au lancement

- Date : 2026-10-31
- Statut : acceptée

## Contexte

Les fournisseurs chinois rencontrés à electronica 2026 (10-13 novembre) doivent voir ce que l'inscription leur apporte. Leur argument décisif, c'est que leur stock devienne visible des acheteurs européens. Or l'API d'offres vers les logiciels d'achat (ADR 0011) et la commande ne sont pas encore construites. Il faut aussi fixer ce que les fournisseurs paient et qui importe les pièces en Europe.

## Décision

### Deux portes d'entrée sur la même offre

L'offre agrégée de Central.Parts est consultable par les **visiteurs du site** (recherche publique sur central.parts) et par les **services connectés par API** (Adesio, Luminovo, CalcuQuote, ERP ; ADR 0011). Le fournisseur n'est jamais nommé.

| Sans compte (site public) | Avec un compte ou une clé d'API |
|---|---|
| Référence, fabricant, disponibilité par tranche (« 10 000+ »), prix tout compris « à partir de », catégorie de source, pays d'expédition | Quantités exactes, tous les paliers, délai, demande de prix, commande |

- Le prix affiché est **tout compris**, partout : prix du fournisseur, marge de Central.Parts et conversion inclus (ADR 0011). Pour une offre broker ou surplus, le détail est donné à la commande.
- La marge est fixée **par catégorie de source et par vendeur** (complété le 1er novembre 2026) : la marge propre à un vendeur, si elle existe, remplace celle de sa catégorie. Migration `20261101000010_marges_par_vendeur.sql`.
- Seules les offres des fournisseurs validés (`app.is_verified`) apparaissent.
- La recherche publique passe par une fonction Edge avec une limite de requêtes par visiteur. Les deux niveaux freinent l'aspiration du catalogue par d'autres brokers.
- Elle est construite **avant electronica**, pour montrer sur le stand qu'un stock validé est en ligne.
- Tant que les promesses de la landing et l'avis du juriste ne sont pas arrêtés, la page n'est **pas indexée** (`noindex`, décision du 1er novembre 2026) et la landing ne la relie pas : elle reste accessible par lien direct.

### Ce qu'on promet aux fournisseurs

« Votre stock est visible des acheteurs européens dès la validation de votre société. Les demandes de prix des acheteurs vous arriveront dans WeChat à partir du début de 2027. » Aucune date de commande n'est annoncée.

### Ce que paient les fournisseurs au lancement

- **Brokers et vendeurs de surplus (Opportunity)** : l'abonnement, condition du statut « vérifié », est **gratuit jusqu'à la première vente**. La société validée reçoit un abonnement gratuit ; le premier abonnement payant commence après sa première transaction réussie. Les frais de plateforme s'appliquent aux ventes. Cela remplace « abonnement au lancement » dans `docs/vision/opportunity.md`.
- **Fabricants et distributeurs (Inventory)** : rien. Central.Parts republie leur prix avec sa marge incluse.
- Les taux (commission, frais de plateforme, marge, abonnement) restent à fixer. Ils ne figurent pas dans ce dépôt public.

### Import en Europe (Inventory)

**L'acheteur importe** : le fournisseur expédie depuis la Chine et l'acheteur dédouane (droits, TVA à l'import). Central.Parts reste intermédiaire et n'est pas importateur. Sur le stand, on ne présente donc pas Central.Parts comme « votre distributeur en Europe » au sens d'un importateur.

## Points ouverts

- La fédération des petits brokers (ADR 0012) : qui vend, et comment le fédérateur est rémunéré. On en parlera d'abord avec le premier fédérateur pressenti, après le salon.
- Le message en chinois des supports (kakémono, compte WeChat) n'est pas encore fixé.

## Conséquences

- Construit le 31 octobre 2026 : page `site/recherche/` (FR, EN, 中文), fonction Edge `search`, migration `20261031000008_recherche_publique.sql`. La recherche porte sur le début de la référence (3 caractères au moins), 50 lignes au plus, une par référence, catégorie de source et pays d'expédition. Tranches de disponibilité : 1+, 100+, 1 000+, 10 000+, 100 000+. Limite : 30 recherches par minute et par adresse IP, gardée sous forme d'empreinte. Marges par catégorie dans `app.price_rules`, saisies par l'opérateur ; sans règle, prix sur demande. Contrôles : `checks/05_recherche.sql`, `tools/test-search-ui.mjs`.
- L'incoterm des offres Inventory est à préciser (DAP ou équivalent, l'acheteur importateur). Les mentions sur les droits et la TVA à l'import doivent figurer sur l'offre détaillée.
