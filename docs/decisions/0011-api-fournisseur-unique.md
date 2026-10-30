# 0011 — Central.Parts, API fournisseur unique

- Date : 2026-10-30
- Statut : acceptée (le prix d'appel tout compris détaillé à la commande et le montage d'Inventory restent à valider par un avocat)

## Contexte

Les fournisseurs de Central.Parts sont des fabricants, des distributeurs, des revendeurs et des brokers. Certains ont une API produit, d'autres ne transmettent que des fichiers CSV ou Excel. De l'autre côté, les acheteurs chiffrent leurs nomenclatures dans des outils qui interrogent les API de fournisseurs : Adesio, Luminovo, CalcuQuote, d'autres plateformes et des ERP. Ces outils comparent des offres palier par palier et attendent une réponse en quelques secondes.

## Décision

Central.Parts devient **une seule API fournisseur**, qui agrège tous ses fournisseurs et ne révèle jamais leur identité.

```
Fournisseurs : fabricants, distributeurs, revendeurs, brokers
   ├─ avec API produit → connecteur Central.Parts (ADR 0007)
   └─ sans API         → dépôt de fichiers, transformés en lots (ADR 0010)
                              ↓
              API d'offres Central.Parts (une clé par client)
                              ↓
       Adesio, Luminovo, CalcuQuote, autres plateformes, ERP
```

### Entrées

- **Fournisseur avec API produit** : le connecteur interroge son API par référence. Il est interrogé **au moment de la recherche**, avec un cache court, et plus seulement à la création d'une demande (ce qui tranche le point ouvert de l'ADR 0007).
- **Fournisseur sans API** : dépôt de fichiers dans Supabase, transformés en lots (ADR 0010). L'envoi d'offres par l'API fournisseur (ADR 0004) reste possible pour qui le souhaite.

### Sortie : l'API d'offres

- Recherche par référence fabricant, et par liste de références (nomenclature).
- Chaque offre porte :
  - un **identifiant Central.Parts opaque** ;
  - le fabricant et la référence ;
  - le stock, le minimum de commande et le multiple ;
  - les **paliers de prix** dans la devise demandée ;
  - le délai et le conditionnement ;
  - le date code s'il est connu ;
  - la durée de validité du prix ;
  - la **catégorie de source** : fabricant, distributeur agréé, ou broker et surplus ;
  - le **pays d'expédition**.
- N'en sortent jamais : le nom du fournisseur, son SKU, l'URL de sa fiche, son prix d'achat.
- Les offres sans prix fournisseur sont publiées « sur demande » ; une demande de prix déclenche l'enchère Opportunity.

### Prix

- Le prix publié est **tout compris** : prix du fournisseur, marge de Central.Parts, conversion dans la devise demandée. C'est ce prix que l'outil de chiffrage compare, palier par palier.
- Pour une offre broker ou surplus (Opportunity), l'acheteur reçoit à la commande le **détail** : prix d'achat converti avec le taux, commission, marge de change et frais. Le total est égal au prix publié ; le détail figure sur l'offre détaillée, la fiche transaction et la facture (ADR 0009).
- Le test en laboratoire, le transport, les échantillons et la recherche étendue sont des options facturées à part.
- On n'ajoute jamais de marge après le prix publié.

### Règle de la source

- La règle « la protection dépend de la source » est conservée. L'API ne nomme pas le fournisseur, mais affiche sa catégorie ; une offre de broker n'est jamais présentée comme agréée.
- La commande d'une offre broker ou surplus suit les rails Opportunity : questionnaire d'état, test au choix, paiement à l'acceptation.

### Accès et clients

- Accès par **clé d'API**, une par client, avec quotas et journal des appels ; aucun accès anonyme.
- **Adesio** est le premier client, puis Luminovo, CalcuQuote et d'autres plateformes, sur partenariat et au format qu'elles attendent.
- Adesio est un client comme les autres : même clé, mêmes données, sans accès privilégié à l'identité des fournisseurs.

### Périmètre

- D'abord le **chiffrage** : stock, prix et délais.
- La **commande** vient ensuite et passe par Central.Parts (fiche transaction, rails Inventory ou Opportunity selon la source).

## Conséquences

- La fonction `search_stock` de l'ADR 0010 (quantités agrégées, sans prix) reste un outil interne ; l'API d'offres est à concevoir. Elle se placera dans le service API métier de l'ADR 0008, avec une spécification OpenAPI d'abord, puis le code.
- Il faut :
  - un **moteur de prix** : marge par catégorie de source et par palier, conversion au taux de référence, durée de validité ;
  - un **cache des connecteurs** ;
  - un **identifiant opaque par offre**, relié au lot et figé à la cotation.
- Les lots doivent porter le minimum de commande, le multiple, le délai et le pays d'expédition. Le format broker actuel ne les fournit pas tous : valeurs par défaut par fournisseur, à compléter.
- Le format exact de sortie se calera sur les intégrations de fournisseurs de Luminovo et CalcuQuote, à étudier avec elles.
- À valider par un avocat : qu'un prix d'appel tout compris dans un outil tiers, détaillé à la commande, suffit pour l'achat pour le compte de l'acheteur ; et le montage d'Inventory (achat-revente ou non), qui décide si son prix doit lui aussi être détaillé.
