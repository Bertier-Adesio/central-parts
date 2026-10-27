# 0009 — Deux parcours de livraison, prix détaillé, yuan offshore et vocabulaire public

- Date : 2026-10-11
- Statut : acceptée (montage juridique et contrats soumis à un avocat)

## Contexte

L'offre Opportunity reposait sur un parcours unique : livraison, éventuellement via un laboratoire, puis inspection de l'acheteur pendant 10 jours ouvrés. Le modèle économique présentait un prix tout compris. Les décisions du 11 octobre 2026 changent ce parcours, l'affichage du prix, la liste des devises et le vocabulaire du site public. La version publique détaillée est dans [`docs/vision/opportunity.md`](../vision/opportunity.md).

## Décision

- **Achat pour le compte de l'acheteur.** Central.Parts conclut l'achat pour le compte de l'acheteur. Les contrats acheteur et vendeur sont dos à dos : mêmes motifs de rejet, mêmes délais, même procédure de litige. Le vendeur n'est payé qu'à l'acceptation.
- **Deux parcours, au choix de l'acheteur à la demande :**
  - avec test : vendeur vers laboratoire ; l'acceptation du rapport (5 jours ouvrés, silence = accepté) vaut acceptation de la vente et déclenche le paiement ; l'anonymat est préservé de bout en bout ;
  - sans test : vendeur vers l'adresse de livraison, l'identité de l'acheteur étant communiquée au vendeur à l'expédition ; rejet possible dans les 5 jours ouvrés qui suivent la livraison confirmée, pour des motifs fermés (contrefaçon documentée, non-conformité à la description, écart de quantité, dommage de transport) ; sans rejet, la vente est acquise et le vendeur payé.
- **Prix détaillé** à l'acheteur, dans sa devise : prix d'achat du vendeur converti, taux de référence (BCE) et marge de change sur des lignes distinctes, frais, commission. Le vendeur n'est pas nommé. Chaque offre indique que Central.Parts perçoit aussi des frais de plateforme auprès des vendeurs ; le classement Opportunity ne dépend jamais d'un paiement du vendeur.
- **Change** : taux figé à l'offre pendant 2 jours ouvrés, conversion dans la devise du vendeur au dépôt de l'acheteur, remboursement du montant déposé en cas de rejet justifié.
- **Yuan offshore (CNH)** à la place du CNY dans la liste des devises : EUR, USD, CNH, HKD, GBP, JPY. `CNY` et `RMB` restent acceptés en entrée et sont enregistrés en `CNH`. Les vendeurs asiatiques sont payés en USD par défaut.
- **Notes des vendeurs** par les acheteurs d'une transaction réelle, et **suspension conservatoire** du compte du vendeur dès un signalement de contrefaçon documenté (perte du statut « vérifié », offres retirées, transactions du lot gelées, droit de réponse et revue sous délai).
- **Vocabulaire public** : le mot « escrow » n'apparaît ni sur le site, ni dans la maquette, ni dans l'API tant que le montage juridique n'est pas validé ; on écrit « payé seulement à l'acceptation » et « compte dédié ». L'endpoint `GET /v1/escrow` devient `GET /v1/funds` ; la table `escrow_movements` devient `funds_movements` (migration `20261011000002`).

## Conséquences

- Fait dans ce changement : devise CNH dans la maquette (état local `v7`), la landing, les documents et le schéma ; endpoint et table renommés ; documents publics mis à jour.
- Reste à faire dans la maquette et le schéma (chantier suivant) :
  - machine d'états à deux chemins, avec les délais de 5 jours ouvrés ;
  - structure de prix détaillé et journal des taux ;
  - événement de levée d'anonymat avec consentement et trace d'audit ;
  - notes, signalements et suspensions ;
  - plafonds de cantonnement.
- La BCE publie le CNY, pas le CNH : la source du taux de référence CNH reste à définir avec l'établissement financier.
