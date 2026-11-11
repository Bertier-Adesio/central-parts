# 0034 — Inscription des fournisseurs par profil, vérification par l'une des deux pièces

- Date : 2026-11-11 (pendant electronica)
- Statut : proposée (migration `20261111000044_inscription_par_profil.sql`, à appliquer avant la fusion)
- Complète l'ADR 0012 (inscription des fournisseurs chinois) et l'ADR 0018 (approbation dans le back office).

## Contexte

Des fournisseurs chinois abandonnent l'inscription sur `/depot/` : formulaire long, quatre profils dont deux se recouvrent (revendeur et broker suivent déjà les mêmes règles), et numéro d'immatriculation et licence tous deux exigés. Décisions de Bertier du 11 novembre 2026 : 3 profils, vérification par l'une des deux pièces, une question propre à chaque profil, un message d'accueil par profil.

## Décision

**Principe** (note mise à jour du 11 novembre) : on **demande** tout, on ne **bloque** presque sur rien. Seuls cinq champs bloquent l'envoi, marqués « 必填 » : nom de la société, profil, une pièce (photo ou numéro), nom du contact principal, devise. Tout le reste se complète plus tard, par le fournisseur depuis `/depot/` ou par l'administrateur.

- **Trois profils à l'inscription** :
  - 原厂 Fabricant (`Manufacturer`) ;
  - 授权分销商 Distributeur agréé (`Distributor`) ;
  - 现货 / 库存 Stock disponible (`Spot`), qui réunit revendeur, broker et surplus.

  Sous chaque choix, une phrase dit au fournisseur ce que ce choix change pour lui : durée de validité de ses offres, et façon dont les acheteurs le voient.
- **`Spot` est une valeur provisoire.** `app.source_category` la range déjà avec les brokers (rail Opportunity, 7 jours). L'administrateur la remplace à l'approbation par `Broker` ou `Surplus`, et ce choix est **obligatoire** pour approuver, dans le back office comme avec le robot (`approve ORG-… broker|surplus`). Les valeurs existantes (`Reseller`, `Broker`, `Surplus …`) ne changent pas.
- **Vérification : photo de la licence OU numéro d'immatriculation**, l'un des deux suffit. La règle est contrôlée par la page, par la fonction `depot` et par la base (CP008).
  - La photo peut être déposée avant l'inscription, dans un dossier propre au compte (`pending/<empreinte de l'openid>/`, compartiment privé `supplier-docs`).
  - Le contrôle du numéro selon la région ne change pas.
  - La région n'est demandée qu'avec un numéro.
- **Formulaire en trois blocs** : société (nom, profil, champ propre au profil, site web, WeChat professionnel ou compte de service), vérification (photo de la licence, numéro, région, ville), contacts (contact principal, puis jusqu'à 3 contacts supplémentaires derrière « + 添加联系人 »). La région n'est exigée qu'avec un numéro ; la ville jamais.
- **Contacts** : la table existante `seller_contacts` est étendue (`duty` : principal, ventes, logistique, finance, autre ; `openid` du contact principal). Une ligne vide est ignorée. Un téléphone, un e-mail ou un site web mal formé affiche un avertissement, jamais un refus : la contrainte de format de l'e-mail est retirée. Un site saisi sans « https:// » est complété.
- **Contact relié ou non au robot** : seul le contact principal (son WeChat a servi à s'inscrire) est relié d'office. Un contact supplémentaire ne reçoit rien tant qu'il n'a pas ouvert une invitation du mécanisme existant (`/depot/invite`, lien de 14 jours) ; `/depot/` propose ce lien à côté de chaque contact non relié, et le back office montre qui est relié.
- **Compléter sa fiche** : après l'envoi, `/depot/` liste ce qui manque et permet de compléter tout de suite ou plus tard (`supplier_signup_save`). Après l'approbation, le nom, le profil, la licence et le numéro ne changent plus que par l'administrateur ; la ville, le site, le WeChat professionnel, les marques et les contacts restent modifiables.
- **Administrateur** : la région, la ville et le profil se complètent ou se corrigent avant l'approbation (`admin_supplier_complete`, changement de profil inscrit au journal). La fiche montre ce qui manque, et la liste des fournisseurs en attente indique « fiche complète » ou « fiche incomplète » ; une fiche incomplète reste approuvable dès qu'une pièce est fournie.
- **Devise obligatoire, sans valeur présélectionnée.**
- **Question propre au profil**, jamais bloquante :
  - fabricant : ses marques ;
  - distributeur : ses marques, et sa lettre d'agrément en option (stockée comme la licence) ;
  - stock disponible : aucune question, seulement l'information sur l'anonymat et la réponse sous 48 heures.

  Les marques déclarées sont une indication pour l'administrateur : elles ne créent aucun rattachement et ne changent aucun libellé montré aux acheteurs.
- **Jamais « agréé » ni « direct » pour un stock disponible.** Le rattachement à un fabricant est déjà refusé par la base pour un compte qui n'est ni fabricant ni distributeur. Un compte reclassé en stock disponible perd ses rattachements.
- **Pièce manquante** : le bouton « Demander la photo de la licence » ou « Demander le numéro » envoie un texte dans WeChat, et rien ne part sans ce clic. Un échec (fenêtre de 48 heures) est affiché sur la fiche. La réponse du fournisseur (photo ou texte) arrive comme les autres messages : gardée et transférée aux opérateurs, mais pas rattachée automatiquement à la fiche.
- **Message d'accueil par profil** (fabricant, distributeur, stock disponible), selon la catégorie et les rattachements au moment de l'approbation (`supplier_welcome`). Comme les autres messages du robot, il est envoyé en chinois puis en anglais. Il ne contient aucun lien : le fournisseur passe par le menu « 供应商 > 上传库存 ».
- **Rien n'est publié avant l'approbation**, comme avant. Les durées de validité (14 jours pour un fabricant, 7 pour les autres) et les libellés montrés aux acheteurs ne changent pas.

## Conséquences et risques

- Une seule pièce, c'est un contrôle plus faible à l'entrée. Il est compensé par l'approbation manuelle avant publication ; en cas de doute, l'administrateur demande la seconde pièce.
- Ville et région laissées vides : l'administrateur les lit sur la licence. Sans photo, la région vient du numéro.
- Formulaire plus long à l'écran : d'où les trois blocs, cinq marques « 必填 » seulement et les contacts supplémentaires repliés.
- Contacts saisis mais non reliés au robot : ils ne reçoivent rien ; le back office et `/depot/` le montrent.
- Coordonnées personnelles stockées : lues par la société et l'administrateur seulement (aucun droit pour un visiteur ni un compte acheteur, jamais dans l'API d'offres).
- Un distributeur sans agrément peut choisir « distributeur agréé » : l'acheteur ne le voit « agréé » qu'après rattachement, et l'administrateur peut le reclasser en stock disponible.
- Un surplus d'EMS ou d'OEM se déclare « stock disponible » comme un broker. La distinction repose sur l'administrateur ; une erreur donne le mauvais libellé (« Broker vérifié » ou « Surplus vérifié »).
- Les marques sont du texte libre (fautes, variantes) : ce sont des indications, pas des données de référence.
- Les textes chinois sont des brouillons : relecture native à faire.
