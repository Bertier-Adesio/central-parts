# 0028 — Panier des acheteurs : une demande pour plusieurs références

- Date : 2026-11-03
- Statut : acceptée (Bertier, 3 novembre 2026) ; migration `20261103000026_panier.sql` à appliquer à la main avant la fusion

## Contexte

Sur `/offres/`, le bouton « Demander » ouvrait un e-mail (`mailto:`) : rien ne se passe sur un ordinateur sans messagerie configurée, et la demande n'arrive pas dans le back office. Sur `/recherche/`, la demande d'achat (ADR 0014) ne portait que sur une référence, et son bouton est masqué (`BUY_OPEN`). Un acheteur EMS ou OEM demande en général plusieurs références à la fois.

## Décision

- **« Ajouter au panier »** remplace « Demander » sur `/offres/`, et s'ajoute sur `/recherche/`. Un lien « Panier (n) » est présent en haut des deux pages.
- **Le panier est gardé dans le navigateur** (`localStorage`, 30 références au plus), sans compte acheteur. Il sera rattaché au compte acheteur quand celui-ci existera (ADR 0017).
- **Page `/panier/`** (FR, EN, 中文, non indexée) :
  - chaque ligne est chiffrée en euros pour sa quantité, par le même devis que la demande seule ;
  - la quantité de départ est le MOQ de l'offre ;
  - une offre disparue est signalée et doit être retirée avant l'envoi ;
  - l'acheteur saisit ses coordonnées une fois (TVA vérifiée par VIES) et envoie une seule demande.
- **En base**, un panier CART-… regroupe des demandes d'achat ordinaires (PR-…), une par ligne. Chaque ligne garde son lot, son fournisseur, son prix figé et son statut. L'envoi est tout ou rien : une ligne invalide annule le panier. La limite reste de 5 envois par heure et par adresse, un panier comptant pour un envoi.
- **Validation** : chaque ligne passe par la validation de l'administrateur (ADR 0026) avant tout envoi au fournisseur. Le back office montre le panier sur chaque ligne et propose « Valider tout le panier ». Chaque fournisseur ne voit que sa ligne, jamais l'acheteur ni les autres lignes.
- **Avis aux opérateurs** : un seul avis WeChat pour le panier, une ligne par demande.
- **Suivi** : l'acheteur reçoit une référence CART-… et un lien de suivi qui montre le statut de chaque ligne (`/recherche/commande/`). Le même jeton sert pour toutes les lignes.

### Quantités compatibles avec le MOQ et le SPQ (complément du 3 novembre 2026, migration `20261103000027`)
- Une quantité est valide si elle **atteint le MOQ** du lot et si elle est **un multiple du SPQ**, la quantité du conditionnement standard (bobine, plateau). La quantité minimale est le plus petit multiple du SPQ qui atteint le MOQ : avec un MOQ de 100 et un SPQ de 2 500, on commande 2 500, 5 000, 7 500…
- `/offres/` affiche le SPQ sous le MOQ. L'ajout au panier part de la quantité minimale.
- Dans le panier, la saisie avance par pas du SPQ. Une quantité saisie est arrondie au multiple valide supérieur, et la page affiche « quantité ajustée ». Le devis donne le MOQ et le SPQ du lot retenu, ce qui couvre aussi les références ajoutées depuis `/recherche/`.
- Le serveur refuse une ligne invalide (`CP422`, réponse `qty_invalid` avec la référence, le minimum et le SPQ). La page ajuste alors la ligne et demande de renvoyer.

### Prix hors transport
- Tous les prix affichés aux acheteurs sont **hors transport, droits et TVA à l'import** (`/offres/`, `/recherche/`, `/panier/`, suivi ; FR, EN, 中文). Le transport est chiffré avec la facture proforma.

## Conséquences

- Plus aucun lien `mailto:` dans les offres : toute demande arrive dans l'onglet « Demandes ».
- La demande seule (`POST /order`) reste servie pour les liens et les clients existants ; le panier passe par `POST /order/cart`.
- Le texte d'engagement (« sans engagement… la vente est conclue à réception du virement ») est celui de la demande d'achat. Sa relecture juridique reste prévue après le 16 novembre 2026.
- Textes chinois nouveaux : à faire relire.
- À faire plus tard : panier rattaché au compte acheteur, e-mails de confirmation (service d'envoi, ADR 0017), devis consolidé et proforma unique pour un panier.
