# Formats d'échange de stock

Comment un fournisseur transmet son stock à Central.Parts. La maquette (`/app/`, écran vendeur « Stock et lots ») implémente la lecture de ces formats dans `site/app/js/api.js` (`importRows`).

## Format attendu des brokers

Format recommandé à tout broker sans API : le **flux distributeur Octopart**, tel que le produit déjà un broker partenaire. Modèle téléchargeable sur la page de dépôt : [`site/depot/stock-template.csv`](../site/depot/stock-template.csv), publié à `https://central.parts/depot/stock-template.csv`.

```
manufacturer,mpn,sku,distributor-url,quantity,price-break-1,price-usd-1,…,price-break-5,price-usd-5,moq
```

- Une ligne par référence ; `mpn` et `quantity` obligatoires.
- Jusqu'à cinq paliers : quantité minimale (`price-break-N`) et prix unitaire en USD (`price-usd-N`). Une autre devise s'écrit dans l'en-tête (`price-cnh-N`, `price-eur-N`).
- Séparateur virgule ou point-virgule, décimales à point ou à virgule, CSV, XLS ou XLSX.
- Colonnes facultatives, ajoutées en fin de ligne : `date-code`, `packaging`.
- Le `sku` sert de clé de mise à jour : il doit rester stable d'un fichier à l'autre.

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

**Flux distributeur Octopart** (point-virgule, décimales à virgule) : `manufacturer;mpn;sku;distributor-url;quantity;price-break-1;price-usd-1;…;price-break-5;price-usd-5;moq`. Chaque paire `price-break-N` / `price-<devise>-N` donne un palier (quantité minimale, prix) ; la devise est lue dans l'en-tête (`usd`) ; le prix du plus petit palier devient le prix unitaire. Les paramètres de suivi `utm_*` sont retirés du lien produit. La colonne `moq` n'est pas encore gardée.

Les en-têtes sont comparés sans casse, tirets, soulignés ni espaces répétés. **En-têtes chinois** reconnus : `型号` / `料号` / `规格型号` (MPN), `品牌` / `厂商` / `厂家` / `制造商`, `数量` / `库存` / `库存数量` / `现货数量`, `批号` / `年份` (date code), `包装`, `单价` / `价格`, `币种` / `货币`.

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
