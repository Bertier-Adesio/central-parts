# 0023 — Route RFQ des plateformes, validation par un administrateur, diffusion WeChat

- Date : 2026-11-02
- Statut : proposée (migration 20261102000020 à appliquer après accord ; fonction Edge `rfq` déployée à la fusion)
- Numéro : 0019 et 0020 sont peut-être réservés par des ADR non encore poussés ; 0023 évite le conflit.

## Contexte

Une plateforme de chiffrage (Adesio d'abord, puis Luminovo, CalcuQuote) veut demander un prix à Central.Parts par API pour les références de ses nomenclatures. Les fournisseurs, surtout en Chine, n'ont pas d'API : ils travaillent dans WeChat. L'ADR 0011 fait de Central.Parts une API fournisseur unique : la plateforme ne voit jamais le fournisseur, et le fournisseur ne voit jamais la plateforme ni l'acheteur. Décision de Bertier (2 novembre 2026) : **aucune RFQ n'est envoyée à un fournisseur sans la validation d'un administrateur**. Spécification détaillée : note « Route RFQ, d'Adesio jusqu'au compte WeChat du fournisseur », 2 novembre 2026.

## Décision

### Une fonction Edge « rfq », même contrat que le futur service Node
- L'API plateforme (`POST /v1/demands`, `GET /v1/demands[/{id}]`, `POST /v1/demands/{id}/cancel`, `GET /v1/demands/{id}/offers`, `POST/GET/DELETE /v1/webhooks`) est servie par une fonction Edge Supabase `rfq`, à l'adresse `https://<projet>.supabase.co/functions/v1/rfq/v1/…`.
- Ses chemins, corps, codes d'erreur et en-têtes sont ceux du service API métier prévu par l'ADR 0008 : il pourra la remplacer sans changer l'API, seule l'adresse de base changera (`https://api.central.parts/v1`, prévue).
- La logique métier est dans la base (fonctions SQL de la migration 20261102000020, exécution réservée à `service_role`) : la même fonction sert l'API, le robot WeChat et le back office, comme pour l'approbation des fournisseurs (ADR 0018).
- Authentification : `Authorization: Bearer cp_live_…` ou `cp_test_…`, comparée à l'empreinte `api_keys.key_hash` (le secret n'est jamais en base). La création de RFQ exige la portée `demands:write` de la clé. 60 appels par minute et par clé (en-têtes `X-RateLimit-*`, `Retry-After`).
- Une RFQ de l'API est une **demande** (`demands`, DEM-…), une par ligne ; les lignes d'un même appel partagent un `rfq_id` (RFQ-…). Idempotence obligatoire sur la création (`Idempotency-Key`, 24 h).

### Validation manuelle obligatoire
- Une RFQ arrive en `pending_validation`. Rien ne part chez un fournisseur avant qu'un administrateur ne la valide : robot WeChat (`approve DEM-…`, `approve DEM-… only ORG-…`, `reject DEM-… motif`, en anglais) ou back office. Chaque décision est inscrite dans `demand_decisions`, en ajout seul.
- Sans décision au bout de 24 h, l'administrateur reçoit un rappel ; la demande n'est jamais diffusée toute seule.
- Plafond : 50 demandes en attente par plateforme.

### Diffusion WeChat et règle des 48 heures
- À la validation, les fournisseurs approuvés dont un lot correspond (même fabricant si fourni, date code suffisant si connu) et qui ont un compte WeChat à prévenir sont inscrits dans `demand_sellers`, puis prévenus par le compte de service (`sendText`). Les mieux notés passent d'abord, au-delà de 10 demandes reçues seulement.
- Le fournisseur répond dans WeChat : `报价 DEM-… prix devise délai date code [lot LOT-…]` ou `无货 DEM-…`.
- **Délai de réponse : 48 heures réelles à partir de l'envoi réussi**, par fournisseur. Après l'échéance, la réponse est refusée sans période de grâce. Un envoi échoué ne démarre pas le délai et n'est jamais compté contre le fournisseur ; l'administrateur peut le renvoyer (`resend`). Rappel au fournisseur à 36 h, une fois.
- Ce délai est distinct de la fenêtre WeChat de 48 h (texte libre possible seulement vers un contact actif dans les 48 dernières heures) : deux constantes séparées. Aucun message modèle WeChat n'est créé (sujet ouvert, ADR 0005).
- Drapeau `RFQ_WECHAT_OPEN` (variable de la fonction), faux par défaut : tant qu'il l'est, rien n'est envoyé aux fournisseurs réels et l'administrateur est prévenu « diffusion fermée ».

### Anonymat dans les deux sens
- Le fournisseur reçoit la référence, la quantité, le date code minimum, le pays de livraison et l'échéance. Jamais : la plateforme, l'acheteur, `customer_reference`, ni le prix cible (non transmis au départ).
- La plateforme reçoit des offres consolidées : prix tout compris dans sa devise, délai, date code, fabricant, catégorie de source, pays d'expédition, `offer_id`. Jamais : le fournisseur, son pseudonyme, son SKU, son lot, son prix net. Les noms de fabricants sont montrés, les fournisseurs masqués (Bertier, 2 novembre).

### Clôture et notation
- Quand tous les fournisseurs prévenus ont répondu ou expiré, la demande est close : prix net converti dans la devise demandée, plus la marge du vendeur (`app.seller_margins`) ou de sa catégorie, classement sur l'équivalent en euros. Webhook `demand.offers_ready` ou `demand.no_offer`.
- Notation : comptage seulement (`supplier_scores`). L'administrateur voit tout ; le fournisseur voit son propre taux sur /depot/ ; la plateforme ne voit aucune note. Aucune exclusion ni suspension automatique.

### Fréquence de mise à jour des offres (complément du 9 novembre 2026)
- Décision de Bertier (9 novembre 2026) : la note d'un fournisseur compte aussi **la fréquence à laquelle il met son stock à jour**, et pas seulement sa réponse aux RFQ. Contexte : le 9 novembre, les 7 881 offres d'un distributeur ont expiré la veille d'electronica, faute de reconfirmation (ADR 0025). Le message d'accueil des fournisseurs approuvés annonce désormais que « la fréquence de mise à jour comptera dans la note » et invite les brokers et revendeurs, dont le stock bouge vite, à mettre leur stock à jour chaque jour. Le principe est décidé ; le détail ci-dessous (ce qui compte, la mesure, l'affichage) est proposé le même jour et à confirmer à la relecture.
- Ce qui compte comme une mise à jour, **un par jour au plus** (heure de Pékin, celle du fournisseur) :
  - un fichier de stock importé avec succès (`stock_imports`, statut `done`) ;
  - une reconfirmation sans fichier (`stock_reconfirmations`, ADR 0025) : « 确认库存 » dans WeChat, bouton de `/depot/` ou du dépôt par lien.
- Ne comptent pas : un fichier rejeté ou en échec, une reconfirmation sans offre en stock (`lots = 0`), et toute action d'un opérateur de Central.Parts pour le compte du fournisseur (accès au dépôt depuis le back office, canal `admin`). Aujourd'hui, une reconfirmation faite par l'accès opérateur est journalisée comme celle du fournisseur (`by_who = 'link'`, canal `lien`) : l'implémentation doit d'abord l'enregistrer à part (adresse de l'administrateur dans `by_who`).
- Mesure, par mois comme le reste de la note (`supplier_scores.period`) : **jours avec une mise à jour** (`update_days`) et date de la dernière mise à jour. On ne fixe pas d'objectif chiffré dans la note : un fabricant valide 14 jours, un broker 7, et le fournisseur choisit sa fréquence.
- Même règle de visibilité que la notation existante : comptage seulement ; l'administrateur voit tout ; le fournisseur voit ses propres chiffres sur `/depot/` (« Mises à jour ce mois-ci : N jours ; dernière le … ») ; la plateforme ne voit aucune note. **Aucune exclusion, suspension ni pénalité automatique**, et aucun effet sur l'ordre de diffusion des RFQ tant que ce n'est pas tranché (voir « À trancher »).
- Mise en œuvre à venir : migration (colonnes `update_days` et `last_update_at` de `supplier_scores`, calculées depuis `stock_imports` et `stock_reconfirmations`), affichage sur `/depot/` et dans la fiche fournisseur du back office, journalisation à part des actions d'opérateur. Rien n'est calculé tant que cette migration n'est pas appliquée.

### Bac à sable
- Une clé `cp_test_` crée des demandes `sandbox` : elles ne sont appariées qu'aux fournisseurs de test (`organizations.sandbox`), et aucun message ne part : l'envoi est simulé. Deux endpoints réservés aux clés de test simulent l'administrateur et le fournisseur, pour qu'une plateforme recette tout le cycle seule.

### Lecture agrégée (complément du 3 novembre 2026)
- Leçon du premier connecteur (Adesio) : une RFQ de N lignes donne N demandes, et la plateforme devait recalculer elle-même le statut du devis puis lire les offres demande par demande. `GET /v1/rfqs/{rfq_id}` rend la RFQ entière en un appel : statut d'ensemble (`in_progress`, `offers_ready`, `no_offer`, `cancelled`), décompte par statut, offres de chaque ligne, validité la plus proche. `GET /v1/rfqs` les liste. Lecture seule, migration 20261103000022.
- Le statut d'ensemble est calculé par Central.Parts (`app.rfq_aggregate_status`), pour que chaque plateforme n'ait pas à le réécrire ; un statut de ligne inconnu compte comme « en cours ».

### Hors périmètre
- La commande (PO) : même route en sens inverse, à décrire dans un ADR séparé.
- Tout sujet juridique (reprise le 16 novembre 2026).

## Conséquences

- Migration 20261102000020, à appliquer à la main avant la fusion. Fonction `rfq` (sans vérification de jeton Supabase, elle vérifie ses clés), et fonctions `wechat-events` et `admin` mises à jour, redéployées à la fusion.
- Tâche planifiée : `POST …/functions/v1/rfq/jobs/tick` toutes les 5 minutes (expirations, rappels, clôtures, livraison des webhooks), protégée par `RFQ_JOBS_SECRET`.
- Secrets de la fonction : `RFQ_WEBHOOK_KEY` (dérivation des secrets de signature des webhooks), `RFQ_JOBS_SECRET`, `RFQ_WECHAT_OPEN`.
- L'organisation de la plateforme est de type `buyer` ; sa clé est créée par Bertier (`tools/create-api-key.mjs`, empreinte seule en base).
- À trancher : prix cible transmis ou non au fournisseur ; questionnaire d'état avant visibilité des offres broker et surplus ; clé par plateforme ou par société acheteuse ; message modèle WeChat ; validation automatique pour une plateforme de confiance ; seuil de 10 demandes pour la notation ; poids de la fréquence de mise à jour dans l'ordre de diffusion des RFQ (« les mieux notés passent d'abord »), aujourd'hui nul.
