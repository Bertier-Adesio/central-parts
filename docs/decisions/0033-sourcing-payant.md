# 0033 — Recherche payante de composants rares ou introuvables

- Date : 2026-11-06
- Statut : acceptée (Bertier, 6 novembre 2026). Paiement par GoCardless, pas Stripe.

## Contexte

Des acheteurs écrivent à contact@central.parts pour des références introuvables sur le site : pièces obsolètes, en pénurie, rares. Chercher prend du temps, et une partie des demandes ne mène à rien. Bertier : « une page de recherches de composants rares ou introuvables sur central.parts, avec un tarif par recherche, une recherche payante pour filtrer les gogos ».

## Décision

- **Page `/sourcing/`** (FR, EN, 中文) : l'acheteur professionnel décrit sa référence (fabricant, quantité, date souhaitée, prix cible, état accepté, précisions) et sa société. Il paie ensuite les frais de recherche. La page est accessible depuis le menu « Composants rares » des pages acheteur, et depuis `/offres/` quand une recherche ne donne aucune offre (référence pré-remplie).
- **Tarif : 49 € HT par référence**, déduits de la commande qui suit. Les frais ne sont pas remboursés sans commande, y compris si la pièce reste introuvable. Le montant se règle dans `app.settings` (clé `sourcing_fee_ht`, en centimes).
- **TVA**, règle à faire valider par le comptable :
  - acheteur en France : 20 % ;
  - autre pays de l'Union : autoliquidation, numéro de TVA obligatoire, vérifié dans VIES ;
  - hors Union : sans TVA.
- **Paiement, selon le pays de l'acheteur** :
  - **Virement en ligne avec GoCardless Pay By Bank** pour les pays couverts en EUR : France, Allemagne et Irlande d'après la documentation de GoCardless. La liste est réglable par le secret `GOCARDLESS_COUNTRIES`.
    - La fonction Edge `sourcing` crée une demande de paiement (`POST /billing_requests`, montant TTC en centimes, clé d'idempotence `sourcing-SRC-…`), puis un parcours hébergé (`POST /billing_request_flows`). Elle renvoie `authorisation_url` (pay.gocardless.com), vers lequel le navigateur est redirigé.
    - Le schéma est celui par défaut (`sepa_credit_transfer`). SEPA Instant peut coûter des frais à l'acheteur, c'est pourquoi la page parle de « virement bancaire » et non de virement instantané.
    - Le paiement n'est tenu pour acquis qu'à réception du webhook signé `billing_requests` / `fulfilled`. La signature (`Webhook-Signature`, HMAC-SHA256 du corps brut) est vérifiée sans bibliothèque, et une signature invalide reçoit la réponse 498.
    - Le montant ne figure pas dans l'événement : la fonction relit le paiement (`links.payment_request_payment`, `GET /payments/PM…`), compare son montant à la demande et ignore un paiement échoué ou annulé.
    - Un événement `payments` / `failed` ou `cancelled` prévient les opérateurs dans WeChat.
    - La page de retour ne décide de rien.
  - **Proforma** pour les autres pays, et pour tous tant que GoCardless n'est pas activé (secret `GOCARDLESS_ACCESS_TOKEN` absent) :
    - la demande est enregistrée et les opérateurs sont prévenus dans WeChat ;
    - Central.Parts envoie une proforma par e-mail ;
    - à réception du virement, l'administrateur marque la demande « payée » dans le back office.
- **Exception à la règle d'accès depuis la Chine** (ADR 0006) : le parcours en ligne redirige vers la page de paiement de GoCardless. Les pages du site ne chargent aucune ressource de GoCardless, sans script, image ni appel réseau, et l'en-tête CSP est inchangé. Seuls les acheteurs, en Europe, sont concernés ; les pages des fournisseurs ne le sont pas.
- **Traitement** :
  - les opérateurs sont prévenus dans WeChat au paiement, ou à la demande s'il s'agit d'une proforma ;
  - la demande apparaît dans le back office, onglet Demandes, « Composants rares · recherches de sourcing ». Le filtre « À valider » montre les demandes payées et les proformas en attente de virement. Pour chaque demande : état, mode de paiement, message à l'acheteur, note interne, demande d'achat sur laquelle les frais sont déduits ;
  - les sources sont celles du rail Opportunity : surplus, brokers, réseau.
- **Suivi** : l'acheteur reçoit un lien personnel `/sourcing/suivi/#JETON`, avec l'état (« En attente de votre virement » pour une proforma) et le message de Central.Parts. Le jeton est dans le fragment : il n'est jamais envoyé au serveur web, et la base n'en garde que l'empreinte.
- **Conditions commerciales** : la page `/conditions/` reçoit une section « Recherche de composants rares ». La mise en ligne a lieu avant les conditions générales de vente, à la demande de Bertier.

## Mise en service

Sans GoCardless, la page fonctionne dès la fusion : toutes les demandes passent par la proforma.

1. Appliquer la migration `20261106000040_sourcing_payant.sql` (SQL Editor).
2. Fusionner : la fonction `sourcing` est déployée sans vérification de jeton (`tools/deploy-functions.sh`).
3. Demander l'accès à Pay By Bank par l'API Billing Requests à api@gocardless.com : il est réservé à « certains marchands ». Faire confirmer par écrit les pays couverts en EUR, le tarif par transaction et l'événement de confirmation d'un paiement en EUR.
4. Essayer d'abord en bac à sable (manage-sandbox.gocardless.com) :
   - Developers → Create → Access token, en lecture et écriture ;
   - Developers → Create → Webhook endpoint, URL `https://tuhbzziqyisdnqzfvtkh.supabase.co/functions/v1/sourcing/webhook` ; copier le secret de l'endpoint ;
   - dans Supabase, Edge Functions → Secrets : `GOCARDLESS_ACCESS_TOKEN` et `GOCARDLESS_WEBHOOK_SECRET`, sans `GOCARDLESS_ENV`. Ces secrets ne vont jamais dans le dépôt ;
   - faire une demande depuis la France, payer avec la banque de test, puis vérifier que la demande passe « payée » dans le back office et qu'un avis arrive dans WeChat.
5. En production : refaire l'étape 4 dans manage.gocardless.com, remplacer les deux secrets et ajouter `GOCARDLESS_ENV=live`. Ajuster `GOCARDLESS_COUNTRIES` si GoCardless confirme d'autres pays.

## Conséquences

- Les frais payés sont déduits à la main sur la proforma de la commande. La demande d'achat concernée s'enregistre dans le back office.
- Les conditions générales de vente devront reprendre la règle des frais et la règle de TVA (revue juridique après le 16 novembre 2026).
- Les factures des frais de recherche sont à émettre par Central.Parts : GoCardless est un prestataire de paiement, pas le vendeur.
- Frais GoCardless, d'après sa grille générale (non confirmée pour Pay By Bank) : de 1 % + 0,20 € à 1,4 % + 0,20 € selon l'offre, soit de 0,79 € à 1,02 € environ sur 58,80 €.
