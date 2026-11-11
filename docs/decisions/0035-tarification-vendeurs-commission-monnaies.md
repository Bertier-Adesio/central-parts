# 0035 — Tarification des vendeurs : abonnement, commission incluse dans le prix, deux monnaies, ventes portées par Adesio

- Date : 2026-11-11 (pendant electronica)
- Statut : acceptée (Bertier, 11 novembre 2026) ; cadre à revoir après le 16 novembre 2026. Rien n'est encore mis en œuvre : aucune migration, aucun changement du site ni de l'API dans cette ADR.
- Modifie les ADR 0009 (prix détaillé), 0011 (détail remis à la commande), 0013 (ce que paient les fournisseurs) et 0027 (prix publics en euros), ainsi que `docs/vision/opportunity.md`.

## Contexte

Jusqu'ici, les règles de rémunération étaient posées en principe, sans barème : commission et marge de change sur des lignes distinctes payées par l'acheteur (ADR 0009), abonnement vendeur gratuit jusqu'à la première vente (ADR 0013), prix publics en euros seulement (ADR 0027), et aucune vente réelle avant la création d'une société dédiée.

Le 11 novembre 2026, Bertier a arrêté la tarification des vendeurs. Cette ADR en acte le **cadre**. Elle ne contient **aucun montant**.

## Décision

### Aucun montant dans le dépôt

Le dépôt est public. Les prix d'abonnement, les taux et seuils de commission, le minimum par commande, les frais de rejet, le nombre de places et les seuils de la garantie ne figurent ni dans la documentation, ni dans le code, ni dans les migrations, ni dans les données fictives. Ils se saisissent **en base, comme réglages** (comme les marges de `app.price_rules`) ; le code ne porte que le mécanisme. La fiche tarifaire interne et sa version destinée aux vendeurs restent hors dépôt. Cela confirme et étend la règle de l'ADR 0013.

### Abonnement annuel

- L'abonnement est annuel, **payable d'avance pour 12 mois**, facturé en euros par Adesio SAS. Les frais bancaires du virement sont à la charge du vendeur : Adesio reçoit le montant facturé en entier.
- Trois formules :
  - **tarif public** ;
  - **Pionnier** : tarif réduit la première année, puis tarif public ; nombre de places limité, après quoi le tarif public s'applique aux nouveaux vendeurs ;
  - **Fournisseur fondateur** : tarif propre la première année, puis tarif public garanti plusieurs années ; nombre de places payantes limité.
- **Garantie de flux des pionniers** : si le vendeur reçoit, en 12 mois, moins de demandes qualifiées que le seuil fixé, des mois d'abonnement lui sont offerts. Une **demande qualifiée** est une demande validée par un administrateur de Central.Parts et notifiée au vendeur pour une référence qu'il a en stock.
- **Contreparties des fournisseurs fondateurs** :
  - intégration faite pour eux (structuration du catalogue, branchement de l'API ou du fichier de stock) ;
  - cercle des fondateurs : un échange par trimestre, accès en avant-première aux nouvelles fonctions ;
  - page « Fournisseurs fondateurs » sur le site et article WeChat, seulement avec l'accord écrit du vendeur.
- **Le statut de fondateur ne change rien pour l'acheteur** : la mention n'apparaît pas sur les offres, et n'a aucun effet sur la note ni sur l'ordre de notification. L'anonymat du vendeur sur les offres (ADR 0021) n'est pas modifié.

### Commission sur les ventes

- **La commission est incluse dans le prix du vendeur.** L'acheteur voit le prix fixé par le vendeur ; Central.Parts retient sa commission sur ce prix, puis verse le net au vendeur.
- **Base** : le prix de la marchandise seulement. Test en laboratoire, transport, douane et autres frais sont des lignes à part, sans commission.
- **Barème dégressif** par tranches selon le montant de la commande, avec un **minimum par commande**. Le taux de la tranche s'applique à toute la commande. Pour une offre dans une autre monnaie, la tranche se détermine sur la contre-valeur en euros au cours du jour de la commande.
- Le même barème s'applique à **tous les vendeurs**, pionniers et fondateurs compris, dès la première vente.
- **Rejet justifié par l'acheteur** (vente annulée) : pas de commission ; des **frais fixes de traitement** par commande sont facturés au vendeur.
- **Relevé vendeur** : à chaque vente, le vendeur reçoit dans WeChat le prix de vente, la commission retenue et le net versé.

### Monnaies

- **Vendeur** : il choisit la monnaie dans laquelle il est payé, parmi **EUR, USD et CNH**. Elle peut être différente de la monnaie du prix de son offre.
- **Acheteur** : il **paie en euros**.
- **Affichage en deux monnaies** : le site et l'API donnent le prix dans la monnaie de l'offre **et** sa contre-valeur en euros.
  - Le prix dans la monnaie de l'offre est le prix ferme du vendeur.
  - La contre-valeur en euros est indicative, puis figée à la commande. Mention à afficher, en français, anglais et chinois : « Contre-valeur indicative au cours du jour, figée à la commande ».
  - Le **coût de conversion est inclus dans le cours affiché** à l'acheteur : il n'y a pas de ligne « marge de change ».
  - API : la réponse renvoie les deux montants, les deux codes de monnaie et la date du cours.
- **Après la commande** :
  - le prix en euros est ferme 5 jours ouvrés ; sans paiement dans ce délai, il est recalculé au cours du jour ;
  - dès réception des fonds de l'acheteur, Central.Parts les convertit dans la monnaie de l'offre ;
  - si la monnaie de paiement du vendeur diffère de celle de l'offre, la conversion a lieu le jour du versement, au cours obtenu de la banque, risque et frais à la charge du vendeur.
- **Traçabilité** : le relevé vendeur et le back office enregistrent chaque cours appliqué et sa date.

### Portage

- Les **premières ventes réelles sont portées par Adesio SAS**, dès maintenant, sans attendre la société dédiée. Central.Parts reste porté dans Adesio, avant un établissement indépendant puis une société.
- Les services (abonnements, frais) sont facturés en euros par Adesio SAS.

## Ce que cette ADR remplace

| Règle antérieure | Où | Devient |
|---|---|---|
| Commission sur une ligne distincte, payée par l'acheteur | ADR 0009 ; tableau des postes de `docs/vision/opportunity.md` | Commission incluse dans le prix du vendeur, retenue sur le net |
| Détail « prix d'achat converti, commission, frais » remis à l'acheteur à la commande | ADR 0011 ; `api/plateformes.md` ; `site/api/` | L'acheteur voit le prix du vendeur ; le détail de la commission va au vendeur (relevé) |
| Marge de change sur une ligne distincte | ADR 0009 ; `docs/vision/opportunity.md` ; « à décider plus tard » dans l'ADR 0027 | Coût de conversion inclus dans le cours affiché |
| « La commission rémunère le service, y compris le traitement du rejet » | `docs/vision/opportunity.md`, résolution des rejets | Pas de commission en cas de rejet justifié ; frais fixes de traitement facturés au vendeur |
| Prix publics en euros seulement ; API dans la monnaie de l'offre seulement | ADR 0027 ; `api/plateformes.md` | Les deux montants partout, avec la date du cours |
| Six monnaies acceptées (EUR, USD, CNH, HKD, GBP, JPY) ; l'acheteur « voit et paie dans la devise de son pays » | `api/fournisseurs.md`, section « Devises » | Trois monnaies de paiement pour le vendeur ; l'acheteur paie en euros |
| Pas de transactions réelles avant la société dédiée (décision d'octobre, non écrite dans le dépôt) | — | Ventes portées par Adesio |

## Conséquences

- **Documents à mettre à jour** (non fait dans cette ADR) : `docs/vision/opportunity.md`, `docs/fournisseurs-types-et-regles.md`, `api/fournisseurs.md`, `api/plateformes.md`, la page publique `site/api/` (trois langues) et `site/conditions/`. Tant qu'ils ne le sont pas, cette ADR prévaut.
- **Trois chantiers de mise en œuvre**, chacun avec sa migration (manuelle, à appliquer avant la fusion, ADR 0016) :
  1. affichage en deux monnaies sur `/recherche/`, `/offres/`, le panier et dans l'API d'offres, avec la mention trilingue et la date du cours ; le cours affiché doit inclure le coût de conversion, alors que le site applique aujourd'hui le taux de référence brut de la BCE (ADR 0027) ;
  2. calcul de la commission, du minimum et des frais de rejet dans le back office, relevé vendeur dans WeChat, enregistrement des cours ;
  3. formules d'abonnement (tarif public, Pionnier, Fournisseur fondateur) sur la fiche fournisseur du back office, suivi des places et de la garantie de flux.
- Le taux de la tranche s'appliquant à toute la commande, la commission baisse au franchissement d'un seuil. C'est accepté en l'état ; à réexaminer lors de la revue du cadre.
- Les engagements pris envers les vendeurs (tarifs garantis, garantie de flux) le sont par Adesio SAS ; leur transfert vers la future structure est à prévoir.

## Points à préciser

- **Qui paie l'abonnement** : l'ADR 0013 distingue les brokers et vendeurs de surplus (abonnement « gratuit jusqu'à la première vente ») des fabricants et distributeurs (aucun abonnement). La décision du 11 novembre parle des « vendeurs » sans distinction. À confirmer : les types de vendeurs concernés, le sort de la règle « gratuit jusqu'à la première vente » et celui des abonnements gratuits déjà ouverts.
- **Bornes du barème** : dans quelle tranche tombe une commande dont le montant est exactement égal à un seuil.
- **Monnaies des offres** : la liste EUR, USD, CNH vaut pour le paiement du vendeur. À confirmer : le maintien de HKD, GBP et JPY comme monnaies de prix d'une offre.
- **Banque** : ce qu'elle permet en USD et en CNH n'est pas vérifié.
- **Comptabilité d'Adesio** : modèle de facture, suivi séparé des encaissements de Central.Parts.
- **Validation juridique et fiscale** de l'achat-revente porté par Adesio, déjà demandée par l'ADR 0014 avant la première vente réelle.
- **Revue après le 16 novembre 2026** : commission côté vendeur, ventes portées par Adesio, transfert des engagements vers la future structure.
