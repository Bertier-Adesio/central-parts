# Types de fournisseurs et règles appliquées

Cartographie au 10 novembre 2026 : qui vend sur Central.Parts, et quelles règles s'appliquent à chacun. Ce document sert à **moduler les règles** : chaque ligne du tableau dit ce qui se fait aujourd'hui, où cela se règle, et si c'est en place, décidé sans être codé, ou encore à trancher.

Pour modifier une règle : changer la cellule, puis le réglage indiqué (paramètre, migration ou texte), et l'ADR cité si la décision change. Une règle sans ADR est signalée « à trancher ».

État :
- **en place** : appliqué par le code ou la base aujourd'hui ;
- **décidé** : décision écrite (ADR ou vision), pas encore codée ;
- **à trancher** : question ouverte.

## 1. Les vendeurs

### 1.1 Types (profil choisi à l'inscription)

Le profil est choisi par le fournisseur à l'inscription sur `/depot/` (ADR 0012), puis contrôlé par l'administrateur à l'approbation. Il détermine la **catégorie de source** (`app.source_category`), qui porte presque toutes les règles.

| Type | Profil en base | Libellé `/depot/` | Catégorie de source | Rail | Qualités attendues | Garantie pour l'acheteur |
|---|---|---|---|---|---|---|
| **Fabricant** | `Manufacturer` | 原厂 | `manufacturer` | Inventory | Produit lui-même ses composants ; marque propre ; stock stable ; prix de liste ; fiches produit complètes (fiche technique, cycle de vie, ECCN, HTS) | Certificat de conformité du fabricant ; traçabilité d'origine |
| **Distributeur** | `Distributor` | 分销商 | `distributor` | Inventory | Distribue une ou plusieurs marques ; « agréé » seulement s'il est rattaché à un fabricant dans le back office ; stock courant, renouvelé souvent | Certificat de conformité d'origine si agréé ; sinon fournisseur partenaire |
| **Revendeur** | `Reseller` | 贸易商 | `broker` (voir écart n° 1) | Opportunity | Négociant sans lien avec le fabricant ; stock de seconde main ou acheté sur le marché ; capacité d'export à vérifier | Celle des brokers |
| **Broker** | `Broker` | 现货经纪商（Broker） | `broker` | Opportunity | Trouve des pièces rares, obsolètes ou en pénurie sur le marché ; stock qui bouge vite ; peut travailler avec des laboratoires de test | Questionnaire d'état, laboratoire sur demande, paiement à l'acceptation |
| **Surplus** | `Surplus EMS`, `Surplus OEM`… (tout profil qui commence par « Surplus ») | aucun (voir écart n° 2) | `surplus` | Opportunity | Excédent de stock d'un EMS ou d'un OEM ; lots fermés, date code ancien possible ; vend rarement | Celle des brokers |

Règle de fond (vision, `docs/vision/plateforme.md`) : **la protection dépend de la source, pas de l'offre**. Une offre de broker ou de surplus passe toujours par les rails Opportunity, même pour une référence courante, et n'est jamais présentée comme agréée.

### 1.2 Qualités transverses (s'ajoutent au type)

| Qualité | Valeurs | Effet | Réglage | État |
|---|---|---|---|---|
| Statut d'approbation (KYB) | en attente · approuvé · refusé | En attente : peut déposer son stock, rien n'est publié. Approuvé : offres publiées, RFQ et recherches reçues. Refusé : dépôt masqué, motif affiché | Back office, onglet Fournisseurs (ADR 0018) | en place |
| « Vérifié » | KYB approuvé et abonnement en cours | Condition pour être présenté « vérifié » (Opportunity) et pour être interrogé par API (ADR 0007). L'abonnement est créé gratuitement à l'approbation | `public.subscriptions` (ADR 0013) | en place (abonnement gratuit) ; facturation à trancher |
| Région d'immatriculation | Chine continentale · Hong Kong · autre | Format du numéro d'immatriculation contrôlé (18 caractères en Chine, 15 à Hong Kong) | Inscription (ADR 0012, 0017) | en place |
| Canal de dépôt | WeChat (`/depot/`) · lien personnel (`/depot/lien/`) · accès opérateur | Le lien personnel sert aux fournisseurs sans WeChat. Un dépôt par l'opérateur ne compte pas dans la note | ADR 0010, 0021, 0023 | en place |
| Rattachement à un fabricant | direct fabricant · distributeur agréé · aucun | « Direct fabricant » ou « Distributeur agréé » sur les offres de ses marques, mention « Distribué en Europe par Central.Parts ». Réservé aux fabricants et distributeurs (refusé par la base pour les autres types) | Back office, onglet Fabricants (ADR 0032) | en place |
| Fédérateur / sous-fournisseur | fédérateur · sous-fournisseur · aucun | Un broker établi recrute et répond de petits brokers ; le fédérateur valide ses sous-fournisseurs | ADR 0012 | décidé ; rémunération à trancher |
| Volontaire des recherches payantes | inscrit · retiré · non inscrit | Reçoit chaque recherche payée, s'engage à répondre sous 48 h, déclare ses laboratoires | `/depot/` et back office (ADR 0033) | en place (brokers et surplus seulement) |
| Bac à sable | oui · non | Fournisseur de test pour les plateformes : rien n'est envoyé | `organizations.sandbox` (ADR 0023) | en place |
| Durée de validité propre | nombre de jours ou vide | Remplace la durée par type | `organizations.offer_ttl_days` (ADR 0025) | en place |
| Marge propre | pourcentage ou vide | Remplace la marge de la catégorie | `app.seller_margins` (ADR 0011, 0013) | en place |

## 2. Les règles par type

| Règle | Fabricant | Distributeur | Revendeur | Broker | Surplus | Où se règle | État |
|---|---|---|---|---|---|---|---|
| **Rail** | Inventory | Inventory | Opportunity | Opportunity | Opportunity | `app.source_category` (migration 20261031000008) | en place |
| **Libellé public de la source** | « Direct fabricant » s'il est rattaché à sa marque, sinon « Fabricant » | « Distributeur agréé » s'il est rattaché, sinon « Distributeur » ; sur `/offres/`, « Fournisseur partenaire » | « Broker vérifié » | « Broker vérifié » | « Surplus vérifié » | `site/recherche/`, `site/offres/`, ADR 0032 | en place |
| **Catégorie dans l'API d'offres** | `manufacturer` | `authorized_distributor` | `broker_surplus` | `broker_surplus` | `broker_surplus` | `app.api_source_category` (ADR 0023, 0024) | en place |
| **Nom du vendeur montré à l'acheteur** | Non. Sa marque figure dans les offres ; une page publique est possible | Non | Non | Non | Non | ADR 0011, 0013, 0032 | en place |
| **Page publique** | Oui, `/fabricants/?b=MARQUE`, avec accord et publication par un administrateur | Non (compté dans le canal du fabricant) | Non | Non | Non | ADR 0032 | en place |
| **Durée de validité des offres** | 14 jours | 7 jours | 7 jours | 7 jours (mise à jour quotidienne conseillée) | 7 jours | `app.settings` : `offer_ttl_days_manufacturer`, `offer_ttl_days` ; par vendeur : `offer_ttl_days` (ADR 0025) | en place |
| **Rappels avant expiration** | WeChat 48 h avant, et à l'expiration ; reconfirmation par 确认库存 | idem | idem | idem | idem | Fonction `rappels` (ADR 0025) | en place |
| **Marge de Central.Parts** | Par catégorie, ou négociée avec le vendeur | idem | Catégorie `broker` | Par catégorie, ou négociée | Par catégorie, ou négociée | `app.price_rules`, `app.seller_margins`. Sans marge, prix sur demande (catalogue) ou offre non montrée (recherche payante) | en place ; **valeurs à saisir et à trancher** |
| **Prix affiché** | Tout compris en euros dès l'unité | idem | Tout compris ; détail donné à la commande | idem | idem | ADR 0013, 0027 | en place |
| **Abonnement (statut « vérifié »)** | Aucun | Aucun | Gratuit jusqu'à la première vente | Gratuit jusqu'à la première vente | Gratuit jusqu'à la première vente | ADR 0013 | en place (gratuit) ; tarif après la première vente à trancher |
| **Questionnaire d'état** | Non | Non | Obligatoire | Obligatoire | Obligatoire | Vision ; `lots.questionnaire` (13 réponses) | décidé ; maquette seulement (`site/app/`) |
| **Paiement de l'acheteur** | Classique (proforma, virement) | Classique | À l'acceptation (fonds sur un compte dédié jusqu'à l'acceptation) | À l'acceptation | À l'acceptation | Vision ; ADR 0014 | classique en place pour tous ; paiement à l'acceptation décidé, montage juridique en cours |
| **Test en laboratoire partenaire** | Non (certificat du fabricant) | Non | Sur demande | Sur demande ; le volontaire déclare ses laboratoires | Sur demande | Vision ; ADR 0033 | laboratoires déclarés en place ; commande de tests décidée, non codée |
| **Validation d'une demande d'achat avant envoi au vendeur** | Oui, par un administrateur | Oui | Oui | Oui | Oui | ADR 0026 | en place |
| **RFQ des plateformes (Adesio…)** | Reçues si un lot correspond, après validation | idem | idem | idem | idem | ADR 0023 | en place ; diffusion réelle fermée (`RFQ_WECHAT_OPEN`) |
| **Délai de réponse aux RFQ** | 48 h, refusé après | idem | idem | idem | idem | `app.rfq_response_hours` (ADR 0023) | en place |
| **Recherches payantes (volontaires)** | Non | Non | Oui, comme broker (voir écart n° 1) | Oui, inscription sur `/depot/` | Oui | `app.sourcing_eligible` (ADR 0033) | en place |
| **Engagement de réponse aux recherches** | — | — | 48 h | 48 h | 48 h | `app.rfq_response_hours` (ADR 0033) | en place |
| **Note du vendeur** | Taux de réponse (RFQ, recherches), fréquence de mise à jour ; comptage seulement, sans pénalité | idem | idem | idem | idem | `supplier_scores`, `seller_updates` (ADR 0023) | en place ; poids dans l'ordre de diffusion à trancher |
| **Interrogation directe de l'API produit du vendeur** | Non prévu | Non prévu | Non prévu | Prioritaire, si broker vérifié avec une API | Non prévu | ADR 0007 | décidé, non codé |
| **Incoterm et lieu de remise** | FCA, ville du fournisseur | FCA | FCA ; capacité d'export à vérifier | FCA ; lieu exact moins sûr, export à vérifier | FCA ; lieu exact moins sûr | `default_terms`, `/conditions/` (ADR 0029, 0030) | en place ; vérification pour revendeurs et brokers à trancher |
| **Fiche produit recommandée** | Complète : fiche technique, description, boîtier, cycle de vie, ECCN, HTS | Complète | Minimale | Minimale | Minimale | Modèles de `/depot/modeles/` (ADR 0022, 0024) | en place (recommandation, comptée plus tard dans la note) |
| **Date code** | Facultatif | Facultatif | Recommandé | Recommandé | Recommandé (souvent ancien) | Import des fichiers | en place (facultatif pour tous) ; obligation pour Opportunity à trancher |

## 3. Écarts constatés entre les décisions et le code

1. **Revendeur traité comme broker.** `app.source_category` range tout profil autre que fabricant, distributeur et surplus dans `broker`. Un revendeur (贸易商) est donc affiché « Broker vérifié » et peut s'inscrire aux recherches payantes. Or l'ADR 0032 le cite à part, et l'ADR 0029 doute de sa capacité d'export. **À trancher** : une catégorie `reseller` à part, ou confirmer qu'il suit les règles des brokers.
2. **Pas de profil « Surplus » à l'inscription.** `/depot/` propose fabricant, distributeur, revendeur et broker. La catégorie `surplus` n'existe que pour un profil saisi à la main en base (« Surplus EMS », « Surplus OEM »). **À trancher** : ajouter « 库存积压 / Surplus » à l'inscription, ou laisser l'administrateur requalifier.
3. **Distributeur non rattaché.** Un distributeur sans rattachement à un fabricant est présenté « Distributeur » sur `/recherche/`, mais « Fournisseur partenaire » sur `/offres/`. Sa catégorie d'API reste `authorized_distributor`, ce qui en dit plus que ce qui est vérifié. **À trancher** : réserver `authorized_distributor` aux comptes rattachés.
4. **Rails Opportunity incomplets.** Le questionnaire d'état et le paiement à l'acceptation sont décidés, mais pas encore codés (montage juridique en cours). Aujourd'hui, une offre de broker se commande comme une offre de distributeur, avec validation par l'administrateur.

## 4. Pour moduler les règles plus tard

Aujourd'hui, les règles sont réparties entre les paramètres (`app.settings`), les tables de marges (`app.price_rules`, `app.seller_margins`), des colonnes par vendeur (`offer_ttl_days`) et des fonctions SQL (`app.source_category`, `app.sourcing_eligible`).

Proposition, **à trancher** : une table unique `app.seller_rules (catégorie, règle, valeur)`, lue par ces fonctions et modifiable dans le back office. Par exemple : validité, marge, éligibilité aux recherches payantes, questionnaire obligatoire, date code obligatoire. Elle demanderait un ADR (modèle de données).
