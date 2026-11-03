# 0027 — Prix publics en euros, au taux de référence de la BCE

- Date : 2026-11-03
- Statut : acceptée (Bertier, 3 novembre 2026) ; migration `20261103000025_prix_euros.sql` à appliquer à la main avant la fusion

## Contexte

Depuis le 2 novembre (ADR 0013, migration `20261102000019`), `/recherche/` et `/offres/` affichaient les prix dans la devise du fournisseur (USD, CNH…), faute de taux de change tenus à jour : `public.currencies` n'était alimentée qu'à la main. Les acheteurs européens comparent en euros. Bertier : « les offres devraient être en € ».

## Décision

- **Prix publics en euros** sur `/recherche/` et `/offres/`, marge comprise, convertis au **taux de référence de la Banque centrale européenne**. La page indique la date du taux.
- Le devis et la demande d'achat suivent la même devise : l'acheteur voit et demande un prix en euros, figé à la demande (ADR 0014).
- **Mise à jour automatique** : la fonction `rappels`, déjà appelée toutes les heures, relit le fichier quotidien public de la BCE (`eurofxref-daily.xml`, sans clé) quand les taux en base ont plus de 20 heures, et les enregistre (`set_eur_rates`).
  - Le yuan offshore (CNH) prend le taux du yuan (CNY), que publie la BCE.
  - Un taux qui s'écarte de plus de 30 % du précédent est ignoré (donnée aberrante).
  - Si la BCE ne répond pas, les derniers taux connus restent utilisés ; au-delà de 4 jours, les opérateurs sont prévenus dans WeChat une fois par jour.
- La recherche ne regroupe plus les offres par devise : une ligne par référence, source et pays d'expédition, au prix le plus bas converti.
- **API des plateformes** : inchangée. Elle garde la devise du lot, sauf si le réglage `api_convert_currency` est activé (ADR 0024), à décider avec Adesio.
- Le fournisseur voit toujours son prix net dans sa devise (`/depot/`, WeChat).

## Conséquences

- Remplace, dans l'ADR 0013, l'affichage dans la devise du fournisseur (2 novembre 2026).
- L'appel à la BCE se fait côté serveur (fonction Edge) : aucune ressource externe sur le site, accessible depuis la Chine (ADR 0006).
- Le prix affiché dépend du taux du jour : il peut bouger d'un jour à l'autre sans que le fournisseur change son prix. Le prix de la demande d'achat est figé à l'envoi.
- À décider plus tard : marge de change (couverture du risque entre la demande et le paiement du fournisseur), affichage du prix dans une autre devise pour un acheteur hors zone euro.
