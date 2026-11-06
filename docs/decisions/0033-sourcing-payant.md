# 0033 — Recherche payante de composants rares ou introuvables

- Date : 2026-11-06
- Statut : acceptée (Bertier, 6 novembre 2026)

## Contexte

Des acheteurs écrivent à contact@central.parts pour des références introuvables sur le site : pièces obsolètes, en pénurie, rares. Chercher prend du temps, et une partie des demandes ne mène à rien. Bertier : « une page de recherches de composants rares ou introuvables sur central.parts, avec un tarif par recherche, une recherche payante pour filtrer les gogos ».

## Décision

- **Page `/sourcing/`** (FR, EN, 中文) : l'acheteur professionnel décrit sa référence (fabricant, quantité, date souhaitée, prix cible, état accepté, précisions) et sa société. Il paie ensuite les frais de recherche. La page est accessible depuis le menu « Composants rares » des pages acheteur, et depuis `/offres/` quand une recherche ne donne aucune offre (référence pré-remplie).
- **Tarif : 49 € HT par référence**, déduits de la commande qui suit. Les frais ne sont pas remboursés sans commande, y compris si la pièce reste introuvable. Le montant se règle dans `app.settings` (clé `sourcing_fee_ht`, en centimes).
- **TVA**, règle à faire valider par le comptable :
  - acheteur en France : 20 % ;
  - autre pays de l'Union : autoliquidation, numéro de TVA obligatoire, vérifié dans VIES ;
  - hors Union : sans TVA.
- **Paiement par carte avec Stripe Checkout.**
  - La fonction Edge `sourcing` crée la demande et une session de paiement, puis renvoie l'adresse de la page Stripe : le navigateur y est redirigé.
  - Le paiement n'est tenu pour acquis qu'à réception du webhook signé `checkout.session.completed`. La signature est vérifiée sans bibliothèque, l'événement est refusé au-delà de 5 minutes, et le montant est contrôlé.
  - La page de retour ne décide de rien.
- **Exception à la règle d'accès depuis la Chine** (ADR 0006) : le parcours de paiement redirige vers un service tiers. Les pages du site ne chargent aucune ressource de Stripe, sans script, image ni appel réseau, et l'en-tête CSP est inchangé. Seuls les acheteurs, en Europe, sont concernés ; les pages des fournisseurs ne le sont pas.
- **Traitement** :
  - les opérateurs sont prévenus dans WeChat au paiement ;
  - la demande apparaît dans le back office, onglet Demandes, « Composants rares · recherches payées » : état, message à l'acheteur, note interne, demande d'achat sur laquelle les frais sont déduits ;
  - les sources sont celles du rail Opportunity : surplus, brokers, réseau.
- **Suivi** : l'acheteur reçoit un lien personnel `/sourcing/suivi/#JETON`, avec l'état et le message de Central.Parts. Le jeton est dans le fragment : il n'est jamais envoyé au serveur web, et la base n'en garde que l'empreinte.
- **Conditions commerciales** : la page `/conditions/` reçoit une section « Recherche de composants rares ». La mise en ligne a lieu avant les conditions générales de vente, à la demande de Bertier.

## Mise en service

1. Appliquer la migration `20261106000040_sourcing_payant.sql` (SQL Editor).
2. Dans Stripe, Developers → API keys : copier la clé secrète. En test, `sk_test_…`.
3. Dans Stripe, Developers → Webhooks → Add endpoint :
   - URL `https://tuhbzziqyisdnqzfvtkh.supabase.co/functions/v1/sourcing/webhook` ;
   - événement `checkout.session.completed` ;
   - copier le « Signing secret » (`whsec_…`).
4. Dans Supabase, Edge Functions → Secrets : ajouter `STRIPE_SECRET_KEY` et `STRIPE_WEBHOOK_SECRET`. Ces secrets ne vont jamais dans le dépôt.
5. Fusionner : la fonction `sourcing` est déployée sans vérification de jeton (`tools/deploy-functions.sh`).

Tant que `STRIPE_SECRET_KEY` n'est pas défini, la page répond que le paiement n'est pas encore ouvert.

## Conséquences

- Les frais payés sont déduits à la main sur la proforma de la commande. La demande d'achat concernée s'enregistre dans le back office.
- Les conditions générales de vente devront reprendre la règle des frais et la règle de TVA (revue juridique après le 16 novembre 2026).
- Les factures des frais de recherche sont à émettre. Stripe envoie un reçu, qui ne vaut pas facture.
