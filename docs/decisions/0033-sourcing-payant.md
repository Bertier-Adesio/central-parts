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

## Brokers volontaires (complément du 9 novembre 2026)

Décisions de Bertier (9 novembre 2026) : « la recherche gratuite se fait dans la barre de recherche de Central.Parts ; si la pièce n'est pas trouvée, ou si les résultats sont insuffisants → recherche payante » ; la recherche payante est faite par les brokers qui se portent volontaires, « c'est un signup ; ils s'engagent à répondre, toutes les offres sont présentées au client ». Mécanique arrêtée le même jour :

- **Inscription** par le vendeur lui-même, sur `/depot/` : réservée aux sociétés approuvées dont le profil est broker ou surplus (rails Opportunity). En s'inscrivant, le vendeur s'engage à répondre à chaque recherche **sous 48 heures** : 报价 (une offre) ou 无货 (pas trouvé). Il peut se retirer à tout moment. L'administrateur voit la liste et peut inscrire, retirer ou corriger un volontaire dans le back office.
- **Laboratoires partenaires** : saisis par le vendeur à l'inscription, modifiables par l'administrateur, visibles de l'administrateur seulement. L'acheteur voit seulement « test en laboratoire possible ».
- **Diffusion automatique au paiement** : webhook GoCardless, ou proforma marquée payée dans le back office. Chaque volontaire actif reçoit la recherche dans WeChat : référence, fabricant, quantité, état accepté, pays de livraison, date souhaitée. Il ne reçoit jamais la société de l'acheteur, son contact, son prix cible ni ses précisions. Aucune validation préalable ni drapeau : les volontaires se sont inscrits eux-mêmes. Sans volontaire actif, l'opérateur est prévenu et traite la demande à la main.
- **Durée** : la recherche reste ouverte **7 jours** après le paiement. L'acheteur peut la prolonger une fois de 7 jours depuis son lien de suivi, sans frais.
- **Réponses** : par WeChat (`报价 SRC-… prix devise délai date code [数量 N]`, `无货 SRC-…`) ou sur `/depot/`. Un vendeur peut proposer jusqu'à 5 offres par recherche, y compris une quantité partielle, et il peut encore proposer une offre après avoir répondu 无货 s'il trouve la pièce. Une offre est acceptée tant que la recherche est ouverte, même après 48 heures.
- **Plusieurs vendeurs** : toutes les offres sont présentées à l'acheteur **dès leur arrivée**, sur son lien de suivi, triées par prix. Pour chaque offre, l'acheteur voit le prix unitaire et le total en euros, la quantité, le délai, le date code, « broker vérifié » ou « surplus vérifié », le pays d'expédition et le test en laboratoire possible. Le vendeur reste anonyme. Le prix est **tout compris** : prix net du vendeur converti en euros, plus la marge négociée à l'avance avec ce vendeur (`app.seller_margins`) ou celle de sa catégorie. Sans marge applicable, l'offre n'est pas montrée et l'opérateur est prévenu. L'administrateur peut retirer une offre, avec un motif.
- **Arrêt** : l'acheteur arrête la recherche avec le bouton « Arrêter la recherche », ou en commandant une offre. Dans ce cas, la recherche s'arrête sauf s'il coche « garder la recherche ouverte ». Les offres reçues restent visibles et commandables après l'arrêt. À l'échéance, la recherche se ferme toute seule. Les volontaires qui n'ont pas encore répondu sont prévenus de la clôture.
- **Commande** : l'opérateur est prévenu dans WeChat avec l'offre, le vendeur et son prix net. Il envoie la proforma par e-mail, déduction faite des frais de recherche, et la suite passe par les rails Opportunity (paiement à l'acceptation, laboratoire sur demande).
- **Notation** : les réponses comptent dans la note du vendeur (`supplier_scores`), avec celles des RFQ des plateformes (ADR 0023). Un vendeur prévenu qui répond 报价 ou 无货 dans les 48 heures est compté comme traité. S'il ne répond pas, il est compté comme expiré, et une offre arrivée plus tard ne change pas ce compte. Si la recherche s'arrête avant l'échéance, le vendeur est compté « clos », sans effet sur sa note. Un envoi WeChat échoué ne compte jamais contre le vendeur. Comme dans l'ADR 0023, il n'y a ni exclusion ni pénalité automatique. Le vendeur voit ses propres chiffres sur `/depot/`.
- **Mise en œuvre** :
  - migration `20261109000042_volontaires_sourcing.sql`, avec les tables `sourcing_volunteers`, `sourcing_sellers` et `sourcing_offers` ;
  - module `_shared/sourcing-dispatch.ts`, utilisé par les fonctions `sourcing`, `admin`, `depot` et `wechat-events` ;
  - rappel à 36 heures, échéances et clôtures dans la tâche planifiée existante `rfq/jobs/tick`, toutes les 5 minutes ;
  - contrôles : `supabase/checks/36_volontaires_sourcing.sql`.
- **À trancher** :
  - un volontaire qui manque souvent l'échéance doit-il être retiré, et par qui ? Aujourd'hui, ce n'est jamais automatique ;
  - faut-il transmettre le prix cible aux volontaires ? Aujourd'hui, non, comme pour les RFQ ;
  - faut-il prévenir l'acheteur par e-mail à chaque nouvelle offre ? Aujourd'hui, l'acheteur consulte son lien de suivi ;
  - ADR 0023 : la note doit-elle peser dans l'ordre de diffusion ? Aujourd'hui, tous les volontaires sont prévenus en même temps.

## Mise en service

Sans GoCardless, la page fonctionne dès la fusion : toutes les demandes passent par la proforma.

1. Appliquer la migration `20261106000040_sourcing_payant.sql` (SQL Editor).
   Brokers volontaires : appliquer ensuite `20261109000042_volontaires_sourcing.sql`, avant la fusion qui l'apporte ; les marges des volontaires (`app.seller_margins`) doivent être saisies, sinon leurs offres ne sont pas montrées.
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
