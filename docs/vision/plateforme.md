# La plateforme Central.Parts

*Version 0.1 · 10 octobre 2026 · Document de travail.*

## Principe

Central.Parts est un **Supply Network Operator (SNO)** de composants électroniques. Comme un opérateur mobile virtuel (MVNO) vend du service télécom sans posséder d'antennes, Central.Parts distribue des composants **sans stock, sans entrepôt et sans camion** : la valeur est dans l'orchestration des données et des transactions entre ceux qui ont les pièces et ceux qui en ont besoin.

Une seule plateforme porte **deux offres complémentaires**. L'acheteur exprime un besoin une fois ; la plateforme le sert par l'offre qui convient à chaque ligne.

| | **Inventory** | **Opportunity** |
|---|---|---|
| Fiche | [`inventory.md`](inventory.md) | [`opportunity.md`](opportunity.md) |
| Sources | Fabricants (Chine, Asie-Pacifique), distributeurs | Brokers, détenteurs de surplus (OEM, EMS, excédents de programmes des distributeurs) |
| Pièces | Courantes : stock, paliers de prix, délais | Rares, obsolètes, en fin de vie, surplus au lot |
| Formation du prix | Catalogue ou cotation | Enchère inversée anonyme sur la demande |
| Preuve de conformité | Traçabilité et certificat de conformité du fabricant ou du distributeur | Questionnaire d'état engageant le vendeur, documents, test en laboratoire partenaire |
| Paiement | Classique, éventuellement à terme | Escrow : l'acheteur ne paie le vendeur qu'après réception, test éventuel et acceptation |

Exemple : une nomenclature de 200 lignes arrive. Inventory couvre les références courantes ; les lignes introuvables dans le canal agréé partent en demande Opportunity. L'acheteur garde un seul dossier, un seul tableau de bord, un seul interlocuteur.

## Règle de protection : selon la source, pas selon l'offre

Le niveau de protection d'une transaction dépend de **l'origine du stock**, quelle que soit la page où la pièce apparaît :

- **Fabricant ou distributeur agréé** : rails Inventory, paiement classique, certificat de conformité d'origine.
- **Broker ou détenteur de surplus** : rails Opportunity, **questionnaire d'état et escrow obligatoires**, même si la référence n'est pas obsolète.

L'origine du stock est affichée sur chaque offre. Une offre broker n'est jamais présentée comme une offre agréée.

## Ce qui est commun aux deux offres

- **Demande acheteur** : référence seule, liste ou nomenclature complète ; quantité, date code minimum, conditionnement, adresse de livraison (éventuellement distincte de la facturation : intégrateur, sous-traitant, filiale).
- **Adesio**, moteur de la plateforme : lecture des demandes et des stocks, matching des références, conseil de prix au vendeur.
- **KYB** des acheteurs et des vendeurs avant toute transaction ; remboursements uniquement vers l'IBAN autorisé.
- **Anonymat** entre acheteur et vendeur ; Central.Parts présente une offre consolidée.
- **Fiche transaction** signée électroniquement à chaque commande, puis **tableau de bord** : étape en cours, minuteur, documents, historique, relances automatiques.
- **Conformité** : contrôle des sanctions et des biens à double usage, RGPD.
- **Points de contact** (API first) : site central.parts, API, ERP des clients, plateformes de cotation et d'achat (Adesio, Luminovo, CalcuQuote), sites des distributeurs partenaires.

## Où intervient l'IA

- Normalisation des descriptions produit (attributs, équivalences, classification).
- Lecture des nomenclatures et matching avec les stocks des deux offres.
- Mesure de la rareté d'une référence et conseil de prix au vendeur.
- Automatisation des échanges et des relances tout au long de la transaction.

## Contrainte sur les données tierces

Les données de prix et de stock d'agrégateurs comme Nexar, Octopart, TrustedParts ou netCOMPONENTS ne servent jamais à alimenter ou valoriser le stock de Central.Parts : leurs conditions d'utilisation l'interdisent à un acteur de la distribution. Tout partenariat données fait l'objet d'un accord écrit.

## Points ouverts

La qualification juridique de Central.Parts dans l'offre Opportunity, l'entité qui porte l'activité, l'établissement financier et la préservation de l'anonymat à la livraison restent à arbitrer, avec un avocat et l'expert-comptable. Ces travaux ne sont pas versionnés dans ce dépôt public.

## Correspondance avec le dépôt

| Brique | Dossier |
|---|---|
| Collecte et normalisation des données fournisseurs | `data/` |
| Exposition aux canaux acheteurs | `api/` |
| Vitrine et point d'entrée direct | `site/` |
| Identité | `brand/` |
| Gabarits contractuels | `legal/` |
