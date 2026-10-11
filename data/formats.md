# Formats d'échange de stock

Comment un fournisseur transmet son stock à Central.Parts. La maquette (`/app/`, écran vendeur « Stock et lots ») implémente la lecture de ces formats dans `site/app/js/api.js` (`importRows`).

## Canaux

Le canal recommandé est l'[API fournisseur](../api/fournisseurs.md) : le stock est poussé à chaque changement. Les fichiers ci-dessous restent proposés en repli.

| Canal | Volume | Endpoint | Traitement |
|---|---|---|---|
| Fichier par l'API ou l'écran vendeur | Jusqu'à 500 000 lignes | `POST /v1/stocklists` | Immédiat, rapport d'import en retour |
| Dépôt SFTP | Au-delà de 500 000 lignes | `POST /v1/webhooks/sftp/stocklist` (déclenché par le dépôt) | Asynchrone, même rapport, consultable par `GET /v1/stocklists/{id}` |

SFTP prévu : un dossier par société (`/inbox/<pseudonyme>/`), authentification par clé SSH déposée à l'inscription, fichier complet quotidien qui remplace le précédent. Fichiers CSV (séparateur `,` `;` ou tabulation, champs entre guillemets) ou XLS/XLSX, convertis côté serveur.

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
| Currency | `currency` | Recommandé | `EUR`, `USD`, `CNY` (`RMB` accepté), `HKD`, `GBP`, `JPY`, `TWD`, `SGD` ; devise inconnue : ligne rejetée |
| Date Code | `dc` | Non | Facultatif ; demandé au broker quand il répond à une demande |

Les prix acceptent `1,250.00` comme `1250,00`. Sans colonne Currency, la devise par défaut de la société s'applique.

## Formats Octopart et ECIA

Reconnus par les mêmes règles : `mpn` / `Manufacturer Part Number`, `manufacturer`, `quantity` / `Quantity Available`, `date_code` / `Date Code`, `packaging` / `Package Type`, `price` / `Unit Price`.

## Règles d'import

- Mise à jour : même SKU chez le même vendeur, ou à défaut même MPN et même date code.
- Doublon possible : même MPN, même date code et même quantité chez un autre vendeur ; le lot est signalé, pas fusionné.
- Lignes rejetées : MPN absent, quantité invalide ; le rapport donne le numéro de ligne et le motif.
- Date code : facultatif dans le stock. Le broker le donne quand il est consulté, dans sa réponse à la demande ; il est alors reporté sur le lot.
- Rappel de la règle de la plateforme : toute offre de broker passe par les rails Opportunity (questionnaire, escrow).

## À confirmer avec le broker

1. Liste complète des colonnes (la liste reçue s'arrête au palier 1 000 pcs) et un extrait de fichier.
2. Conditionnement, pays d'origine et délai : disponibles dans un autre champ ou un autre fichier ?
3. Colonne de devise (sinon : devise unique de tout le fichier) et fréquence de mise à jour.
4. Le SKU est-il stable dans le temps (clé de mise à jour) ?
5. Fichier complet ou différentiel par SFTP ; nom de fichier et horaire de dépôt.
