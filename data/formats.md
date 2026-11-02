# Formats d'échange de stock

Comment un fournisseur transmet son stock à Central.Parts. La maquette (`/app/`, écran vendeur « Stock et lots ») implémente la lecture de ces formats dans `site/app/js/api.js` (`importRows`).

## Format attendu des brokers

Format recommandé à tout broker sans API : le **flux distributeur Octopart**, tel que le produit déjà un broker partenaire. Modèle téléchargeable sur la page de dépôt : [`site/depot/stock-template.csv`](../site/depot/stock-template.csv), publié à `https://central.parts/depot/stock-template.csv`.

```
manufacturer,mpn,sku,description,datasheet-url,distributor-url,quantity,price-break-1,price-usd-1,…,price-break-5,price-usd-5,moq,lead-time
```

- Une ligne par référence ; `mpn` et `quantity` obligatoires.
- Jusqu'à cinq paliers : quantité minimale (`price-break-N`) et prix unitaire en USD (`price-usd-N`). Une autre devise s'écrit dans l'en-tête (`price-cnh-N`, `price-eur-N`).
- Séparateur virgule ou point-virgule, décimales à point ou à virgule, CSV, XLS ou XLSX.
- Colonnes facultatives : `date-code`, `packaging`, `lead-time` (délai : « 3 days », « 2 weeks »), et, appréciées : `description` (500 caractères au plus), `datasheet-url` (fiche technique ou page du produit chez le fabricant), `distributor-url` (page du produit chez le vendeur).
- Le `sku` sert de clé de mise à jour : il doit rester stable d'un fichier à l'autre.
- `moq` (quantité minimale de commande, 1 ou plus) est gardé. Les liens sont gardés sans paramètres de suivi (`utm_…`), seulement s'ils commencent par `http://` ou `https://`. Le lien du vendeur, la fiche technique et la description sont visibles des administrateurs (back office) et jamais des acheteurs ([ADR 0022](../docs/decisions/0022-liens-descriptions-fabricants.md)).
- Contrôles ligne par ligne, chaque rejet avec un code traduit en chinois, anglais et français : `mpn` vide, quantité non entière ou non positive, MOQ inférieur à 1, prix nul ou illisible, palier incomplet (quantité sans prix ou l'inverse), quantités des paliers non croissantes (dans l'ordre 1 à 5), prix en hausse avec la quantité, devise non prise en charge.

Vendeurs approuvés sans WeChat : lien personnel `https://central.parts/depot/lien/#k=…` ([ADR 0021](../docs/decisions/0021-listes-vendeurs-lien-expiration.md)), modèle à point-virgule et virgule décimale [`site/depot/lien/modele.csv`](../site/depot/lien/modele.csv). Chaque dépôt remplace la liste précédente ; une offre non rechargée depuis 7 jours n'est plus montrée aux acheteurs.

## Devise des prix

Pour chaque ligne, dans cet ordre ([ADR 0022](../docs/decisions/0022-liens-descriptions-fabricants.md)) : la colonne `currency` / `币种`, ou la devise des en-têtes de prix (`price-usd-N`) ; sinon la devise choisie au dépôt (obligatoire dans l'espace fournisseur et sur la page du lien personnel) ; sinon la devise de la société. Le rapport d'import indique la devise appliquée et sa provenance.

## Format attendu des fabricants chinois

Modèle à en-têtes chinois, sur le modèle des fichiers de prix des fabricants (UMW) : [`site/depot/modele-fabricant.csv`](../site/depot/modele-fabricant.csv), publié à `https://central.parts/depot/modele-fabricant.csv` et proposé dans l'espace fournisseur.

```
型号,品牌,产品编号,产品描述,封装,库存,批次,货期,最小起订量,币种,价格,规格书链接,产品链接
```

- `型号` (MPN) et `库存` (stock) obligatoires ; `产品编号` (code produit du fabricant) sert de SKU, donc de clé de mise à jour.
- `价格` contient tous les paliers dans une cellule : `10~99 0.040|100~999 0.032|1000以上 0.028` (quantité minimale, prix ; « 以上 » ou « + » pour le dernier palier ; séparateurs `|`, `;` ou retour à la ligne). Un simple prix unitaire est aussi accepté.
- `封装` (boîtier) va dans « Boîtier / emballage », `批次` dans le date code, `货期` dans le délai en jours (« 1-3day », « 7天 », « 2周 »).
- `币种` : USD, CNH (ou CNY, RMB), EUR, HKD ; sans cette colonne, la devise choisie au dépôt s'applique.
- `产品描述`, `规格书链接`, `产品链接` : facultatifs mais appréciés, mêmes règles que ci-dessus.
- `包装数量` (quantité par conditionnement) est accepté dans le fichier mais pas encore gardé.

Les autres formats décrits ci-dessous restent acceptés.

## Canaux

Ordre de priorité ([ADR 0007](../docs/decisions/0007-priorite-api-produit-brokers.md)) : 1. l'API produit du broker, interrogée par Central.Parts à chaque demande ; 2. l'envoi vers l'[API fournisseur](../api/fournisseurs.md) ; 3. les fichiers ci-dessous, en repli.

| Canal | Volume | Endpoint | Traitement |
|---|---|---|---|
| Fichier par l'API ou l'écran vendeur | Jusqu'à 500 000 lignes | `POST /v1/stocklists` | Immédiat, rapport d'import en retour |
| Dépôt SFTP | Au-delà de 500 000 lignes | `POST /v1/webhooks/sftp/stocklist` (déclenché par le dépôt) | Asynchrone, même rapport, consultable par `GET /v1/stocklists/{id}` |

Dépôt de fichiers en place ([ADR 0010](../docs/decisions/0010-depot-stock-connexion-wechat.md)) : compartiment privé Supabase `stock-imports`, un dossier par société, transformation en lots par la fonction Edge `import-stock`, rapport d'import dans `stock_imports` ; connexion du fournisseur par WeChat à venir. Un fichier dont le nom contient « complet » remplace le stock précédent. Fichiers CSV (séparateur `,` `;` ou tabulation, champs entre guillemets, UTF-8 ou GB18030) ou XLS/XLSX, 50 Mo au plus ; un SFTP pourra s'ajouter pour les très gros volumes.

## Format broker

Colonnes annoncées par un broker partenaire (octobre 2026), en CSV ou XLS :

| Colonne fournisseur | Champ du lot | Obligatoire | Remarque |
|---|---|---|---|
| Manufacturer | `mfr` | Oui | Normalisé ensuite (alias de fabricants) |
| SKU | `sku` | Recommandé | Clé de mise à jour : un même SKU met à jour le lot existant |
| MPN | `mpn` | Oui | Ligne rejetée si absent |
| Product URL | `url` | Non | Lien vers la fiche du fournisseur, jamais affiché à l'acheteur (anonymat) |
| Unit Price | `price` | Non | Prix catalogue du fournisseur ; sert au conseil de prix, pas au prix acheteur |
| Quantity | `qty` | Oui | Ligne rejetée si nulle ou illisible |
| Price per 10 pcs | `tiers[10]` | Non | Palier |
| Price per 100 pcs | `tiers[100]` | Non | Palier |
| Price per 1,000 pcs | `tiers[1000]` | Non | Palier ; en CSV, l'en-tête contient une virgule et doit être entre guillemets |
| Currency | `currency` | Recommandé | Devises des comptes de Central.Parts : `EUR`, `USD`, `CNH` (`CNY` et `RMB` acceptés comme `CNH`), `HKD`, `GBP`, `JPY` ; autre devise : ligne rejetée |
| Date Code | `dc` | Non | Facultatif ; demandé au broker quand il répond à une demande |

Les prix acceptent `1,250.00` comme `1250,00`. Sans colonne Currency, la devise par défaut de la société s'applique.

## Formats Octopart et ECIA

Reconnus par les mêmes règles : `mpn` / `Manufacturer Part Number`, `manufacturer`, `quantity` / `Quantity Available`, `date_code` / `Date Code`, `packaging` / `Package Type`, `price` / `Unit Price`.

**Flux distributeur Octopart** (point-virgule, décimales à virgule) : `manufacturer;mpn;sku;distributor-url;quantity;price-break-1;price-usd-1;…;price-break-5;price-usd-5;moq`. Chaque paire `price-break-N` / `price-<devise>-N` donne un palier (quantité minimale, prix) ; la devise est lue dans l'en-tête (`usd`) ; le prix du plus petit palier devient le prix unitaire. La colonne `distributor-url` est gardée pour usage interne (ADR 0022) ; `moq` est gardé.

Les en-têtes sont comparés sans casse, tirets, soulignés ni espaces répétés. **En-têtes chinois** reconnus : `型号` / `料号` / `规格型号` (MPN), `品牌` / `厂商` / `厂家` / `制造商`, `数量` / `库存` / `库存数量` / `现货数量`, `批号` / `批次` / `年份` (date code), `包装` / `封装`, `单价` / `价格`, `币种` / `货币`, `产品编号` / `商品编号` / `物料编号` (SKU), `货期` / `交期` / `交货期` (délai), `产品描述` / `描述` / `说明`, `规格书` / `规格书链接` / `数据手册`, `产品链接` / `链接`.

## Ce qu'on demande aux fabricants et aux distributeurs agréés

Facultatif, mais apprécié : ces champs font des offres directement comparables dans les outils de chiffrage, et ils compteront dans la notation du fournisseur quand elle saura en tenir compte (aujourd'hui, aucun effet sur le classement).

| Champ | Colonne | Pourquoi |
|---|---|---|
| Fabricant normalisé | `manufacturer` / `品牌`, avec le **nom complet** du fabricant | Reconnu par le référentiel (`MFR-…`, alias compris) ; un nom non reconnu est signalé dans le rapport d'import |
| Description | `description` / `产品描述` | Affichée à l'acheteur |
| Fiche technique | `datasheet-url` / `规格书链接` | Lien vers le PDF du fabricant |
| Boîtier | `case` / `封装` | SOIC-8, 0603… |
| Cycle de vie | `lifecycle` / `生命周期` | Active, NRND, LTB, Obsolete |
| ECCN | `eccn` / `ECCN` | Contrôle à l'export |
| Code HTS | `hts-code` / `海关编码` | Nomenclature douanière |

Les modèles de `/depot/` (`stock-template.csv`, `modele-fabricant.csv`) et de `/depot/lien/` (`modele.csv`) contiennent ces colonnes. Chaque rapport d'import donne la **complétude** (part des lignes qui renseignent chaque champ) et les marques non reconnues ; le fournisseur voit aussi la complétude de son stock en ligne. L'administrateur la lit dans le back office (`/admin/data-quality`) et dans `rfq stats ORG-…` (`supplier_data_quality`).

## Colonnes facultatives (API d'offres, ADR 0024)

Reprises des meilleures pratiques des API DigiKey et TI ; vides ou illisibles, elles sont ignorées (jamais un motif de rejet). En-têtes reconnus, entre autres :

| Champ | En-têtes | Valeurs |
|---|---|---|
| Quantité d'un conditionnement complet | `SPQ`, `Standard pack`, `Reel qty`, `标准包装`, `整盘数量` | Entier |
| Boîtier | `Case`, `Package case`, `封装` | SOIC-8, 0603… (« 封装 » reste aussi lu comme conditionnement, pour les fichiers déjà déposés) |
| Cycle de vie | `Lifecycle`, `Part status`, `生命周期` | Active, NRND, LTB / EOL, Obsolete, 量产, 停产 |
| ECCN | `ECCN` | EAR99, 3A991… |
| Code HTS | `HTS`, `HTS code`, `HS code`, `海关编码` | Chiffres seulement (points retirés) |
| Pays d'origine | `Country of origin`, `COO`, `原产地` | Code ISO (CN, MY…) ou nom courant (China, Malaisie, 中国…) |

Le conditionnement (`Packaging`, `包装`) est présenté aux plateformes en liste fermée : `tape_reel`, `cut_tape`, `tray`, `tube`, `bulk`, avec le libellé déposé.

## Règles d'import

- Mise à jour : même SKU chez le même vendeur, ou à défaut même MPN et même date code.
- Doublon possible : même MPN, même date code et même quantité chez un autre vendeur ; le lot est signalé, pas fusionné.
- Lignes rejetées : MPN absent, quantité invalide ; le rapport donne le numéro de ligne et le motif.
- Date code : facultatif dans le stock. Le broker le donne quand il est consulté, dans sa réponse à la demande ; il est alors reporté sur le lot.
- Rappel de la règle de la plateforme : toute offre de broker passe par les rails Opportunity (questionnaire d'état, paiement à l'acceptation).

## À confirmer avec le broker

1. Liste complète des colonnes (la liste reçue s'arrête au palier 1 000 pcs) et un extrait de fichier.
2. Conditionnement, pays d'origine et délai : disponibles dans un autre champ ou un autre fichier ?
3. Colonne de devise (sinon : devise unique de tout le fichier) et fréquence de mise à jour.
4. Le SKU est-il stable dans le temps (clé de mise à jour) ?
5. Fichier complet ou différentiel par SFTP ; nom de fichier et horaire de dépôt.
