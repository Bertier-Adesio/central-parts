# 0032 — Fiche fournisseur complète et page publique du fabricant

- Date : 2026-11-05
- Statut : acceptée (Bertier, 5 novembre 2026 : « back office + page publique sous ma direction »)

## Contexte

Les annuaires de composants (NetComponents) montrent pour chaque fournisseur une fiche détaillée : année de création, description, sites, heure locale, langues parlées, contacts, moyens de paiement, commande minimum, note des acheteurs. Central.Parts doit connaître ses fournisseurs aussi bien, mais le vendeur reste anonyme pour l'acheteur (ADR 0021) : une fiche publique avec des contacts permettrait de contourner la plateforme.

Un fabricant est un cas à part : sa marque figure déjà dans la colonne « fabricant » de ses offres, l'anonymat ne le protège pas, et une page de présentation est un argument de vente pour lui comme pour l'acheteur.

## Décision

- **Fiche société dans le back office** (`/admin/`, fiche du fournisseur) :
  - présentation et positionnement en FR, EN et 中文 ;
  - année de création, siège, site de production, surface, effectif, pièces livrées par an ;
  - chiffre d'affaires et site web, internes ;
  - certifications, langues parlées, moyens et conditions de paiement, commande minimum ;
  - marques fabriquées et logo.

  Ce sont des colonnes de `organizations`, toutes modifiables depuis la fiche. Les données réelles sont saisies là, jamais dans le dépôt.
- **Contacts par société** (`seller_contacts`), rattachables à un site d'expédition : nom, fonction, e-mail, téléphone, WeChat, langues, et adresse préférée pour les demandes de prix ou pour les bons de commande. Lus par les administrateurs seulement, jamais montrés aux acheteurs.
- **Logo** : compartiment de stockage public `seller-logos`, dans le dossier de la société. Formats PNG, JPEG ou WebP, 1 Mo au plus. Le SVG est exclu, car il peut porter un script.
- **Page publique `/fabricants/?b=MARQUE`** :
  - **Conditions :** seulement pour un fournisseur approuvé, avec au moins une marque et une présentation, et seulement quand un administrateur la publie (`admin_supplier_publish`, au journal, avec l'accord du fabricant).
  - **Contenu :** la présentation, le logo, les chiffres, les certifications, les langues et le nombre d'offres en ligne.
  - **Jamais affichés :** contact, adresse, site web, chiffre d'affaires, conditions de paiement, identifiant interne ou pseudonyme.
  - Vider la présentation ou les marques retire la page.
- **Offres** (`/offres/`) :
  - la marque d'un fabricant qui a une page publiée renvoie vers cette page ;
  - les offres du fabricant lui-même portent « Direct fabricant » ;
  - toutes les autres offres restent « Fournisseur partenaire ».
- **CSP** (ADR 0031) : les images peuvent venir du domaine Supabase (logos).

## Conséquences

- Avant de publier une page, vérifier l'accord écrit du fabricant sur les textes et les chiffres.
- Les adresses e-mail « RFQ » et « Commandes » sont enregistrées, mais rien n'est encore envoyé par e-mail. L'envoi viendra avec le service d'e-mail des comptes acheteurs (ADR 0017). Les avis restent dans WeChat.
- La page fabricant n'est pas indexée (`noindex`), comme les offres, tant que le lancement public n'est pas décidé.
- La notation en cinq critères (réactivité, cotation, expédition, conformité, retours) viendra après les premières commandes, à partir des flux de la plateforme.

## Complément du 5 novembre 2026 : fabricants et distributeurs

Décisions de Bertier :
- « dans le back office un (ou plusieurs) fabricant peut être attaché à un distributeur ; un fabricant peut se distribuer soi-même » ;
- « on peut dire que les fabricants concernés sont distribués par Central.Parts en Europe ; ça ne s'applique pas aux revendeurs, brokers, excès d'inventaire ».

Mise en œuvre : migration `20261105000033_fabricants_distributeurs.sql`.

- **Le fabricant devient une fiche à part** (`manufacturers`, onglet « Fabricants » du back office). Elle porte :
  - le nom affiché sur la page publique ;
  - les marques (une marque appartient à un seul fabricant) ;
  - la présentation, les chiffres et le logo ;
  - la page publique.

  Les champs de page publique de la fiche société (marques, logo, publication) passent sur la fiche du fabricant. La fiche société garde la présentation, les chiffres, le paiement et les contacts du compte, à usage interne. La migration reprend les fiches déjà saisies et remet leur page à « non publiée ».
- **Rattachements** (`manufacturer_distributors`) :
  - un compte fournisseur est rattaché à un fabricant comme **fabricant lui-même** (un seul compte par fabricant) ou comme **distributeur agréé** ;
  - un distributeur peut porter plusieurs fabricants, et un fabricant peut avoir plusieurs distributeurs ;
  - seul un compte de type fabricant ou distributeur peut être rattaché, jamais un revendeur, un broker ni un excédent de stock (refusé par la base).
- **Distribution en Europe par Central.Parts.**
  - Ce sont les offres d'un compte rattaché, pour les marques du fabricant, qui portent « Direct fabricant » ou « Distributeur agréé », avec la mention « Distribué en Europe par Central.Parts ».
  - Les offres de la même marque venant d'autres sources restent « Fournisseur partenaire », et la page fabricant le précise.
  - La page compte les offres par canal. Elle n'affiche jamais le nom ni le pseudonyme des distributeurs.

## Complément du 5 novembre 2026 : direct fabricant ou distributeur agréé, au choix

Décision de Bertier : « il faut que je puisse moduler direct fabricant et direct distributeur agréé ». La société de distribution propre à un fabricant, en contact direct avec lui, est « direct fabricant » (migration `20261105000034_role_direct_fabricant.sql`).

- Le rôle de chaque compte rattaché se choisit et se change dans la fiche du fabricant, sans le détacher.
- Un fabricant peut avoir plusieurs comptes « direct fabricant » : lui-même et sa société de distribution.

## Complément du 6 novembre 2026 : espace fournisseur et accord

Décisions de Bertier :
- « le fournisseur devrait avoir accès à un back office fournisseur » ;
- « s'il y a plusieurs utilisateurs connectés, il y a seulement un admin autorisé à modifier la description, et Central.Parts ».

Mise en œuvre : migration `20261106000035_espace_societe.sql`.

- **Dans `/depot/`, sections « Fiche société » et « Pages fabricant »** :
  - le fournisseur complète la fiche de sa société et ses contacts (adresses préférées RFQ et commandes), à usage interne ;
  - il relit la page de chaque fabricant rattaché et propose des corrections. Elles ne sont appliquées qu'après validation dans le back office : Central.Parts garde la main sur la page publique ;
  - il donne ou retire son accord sur la mention « distribué en Europe par Central.Parts » et sur le badge de ses offres.
- **Un seul responsable de la fiche par société** : par défaut, le premier administrateur WeChat rattaché ; un administrateur Central.Parts peut en désigner un autre depuis la fiche du fournisseur. Les autres comptes de la société ont la fiche en lecture seule. Le chiffre d'affaires et les champs saisis par Central.Parts ne sont pas modifiables par le fournisseur.
- **Publication** : la page d'un fabricant exige au moins un accord, donné dans `/depot/` ou enregistré par un administrateur qui l'a reçu hors plateforme (WeChat, e-mail). Le retrait du dernier accord retire la page.

## Complément du 6 novembre 2026 : totaux des offres et annuaire des fabricants

- `/offres/` affiche le nombre de références en ligne et la taille de l'inventaire (pièces en stock), sur la recherche en cours ou sur tout le catalogue, au-delà des 50 offres affichées (migration `20261106000036_offres_totaux.sql`).
- `/fabricants/`, sans marque dans l'adresse, liste les fabricants en direct dont la page est publiée : logo, nom, positionnement, marques, siège et offres en ligne de leur canal officiel. Chaque carte mène à la page du fabricant (migration `20261106000037_annuaire_fabricants.sql`). `/offres/` renvoie vers cet annuaire.
- Back office : la section « Canal de vente » d'un fabricant présente une ligne par compte ; le rôle, l'accord et le détachement sont repliés sous « Modifier », et le rattachement d'un autre compte sous « Rattacher un autre compte ».
- `/offres/` propose une recherche rapide par fabricant : une rangée de boutons (« Tous » et les fabricants les plus présents dans les offres de la recherche, avec leur nombre d'offres), combinée avec la recherche par référence, et partageable par l'adresse (`?mfr=`) (migration `20261106000038_offres_par_fabricant.sql`, nouveau paramètre `p_mfr` de `partner_offers`).
