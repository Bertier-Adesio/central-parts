# 0022 — Liens, fiches techniques et descriptions des références ; fichiers de prix des fabricants

- Date : 2026-11-02
- Statut : acceptée (Bertier, 2 novembre 2026) ; migration 20261102000016 à appliquer à la main

## Contexte

- Les fichiers des vendeurs contiennent souvent un lien vers la page du produit chez eux (flux Octopart : `distributor-url`). L'ADR 0021 l'écartait à l'import : il révèle le vendeur, et l'acheteur pourrait commander directement chez lui. C'est vrai surtout des brokers.
- Un fabricant donne plutôt un lien vers une fiche technique ou la page du produit sur son site, qui aide l'acheteur sans révéler la source.
- Aucun champ ne recevait une description du produit, et le modèle demandait une colonne (`distributor-url`) que l'import jetait.
- Les fabricants chinois (fichier de prix UMW, 1 812 références) envoient leurs paliers dans une seule cellule (`10~90 0.0379|…|10000以上 0.0185`), avec boîtier, lot et délai en en-têtes chinois : l'import rejetait toutes les lignes.

## Décision

1. **Lien du vendeur** (`lots.product_url`) : gardé, sans paramètres de suivi, pour les administrateurs (back office) et le vendeur lui-même. Jamais renvoyé par une fonction publique (recherche, offres partenaires, devis, demandes d'achat) ; vérifié par `supabase/checks/12_liens_descriptions.sql`.
2. **Fiche technique** (`lots.datasheet_url`, nouveau champ) : gardée à part du lien du vendeur, pour pouvoir être publiée plus tard sans jamais publier ce dernier. Interne pour l'instant.
3. **Description** (`lots.description`, nouveau champ, 500 caractères au plus) : donnée par le vendeur, facultative mais appréciée. Interne pour l'instant : elle pourrait contenir le nom ou les coordonnées du vendeur ; sa publication sera décidée après lecture des premières descriptions reçues.
4. Seuls les liens `http(s)` sont gardés ; le back office les ouvre dans un nouvel onglet sans transmettre son adresse.
5. **Fichiers des fabricants chinois** : la cellule de paliers, `封装` (boîtier), `批次` (lot), `货期` (délai, en jours), `产品编号` (SKU) sont lus. Modèle préféré pour un fabricant chinois : `site/depot/modele-fabricant.csv` (en-têtes chinois, devise, description et liens facultatifs), proposé dans l'espace fournisseur à côté du modèle international, qui gagne les colonnes `description`, `datasheet-url` et `lead-time`.

## Conséquences

- Remplace, dans l'ADR 0021, « la colonne `distributor-url` est ignorée et jamais gardée ».
- Les liens des fichiers déjà importés n'ont pas été gardés : il faut réimporter le fichier (il reste dans le stockage) pour les récupérer.
- À décider plus tard : publication des fiches techniques et des descriptions aux acheteurs ; `包装数量` (quantité par conditionnement), accepté mais pas encore gardé.
