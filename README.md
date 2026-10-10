# Central.Parts

**Supply Network Operator (SNO) pour les composants électroniques.**

Central.Parts est un distributeur sans stock, sans entrepôt et sans camion : la plateforme relie, de façon automatisée et API-first, les fournisseurs aux acheteurs (EMS et OEM français et européens). Le modèle s'inspire des opérateurs mobiles virtuels (MVNO) appliqués à la chaîne d'approvisionnement.

Une seule plateforme, deux offres complémentaires :

- **Inventory** : le réseau des fabricants (Chine, Asie-Pacifique) et des distributeurs, pour les références courantes.
- **Opportunity** : surplus, obsolètes et brokers, pour les références introuvables dans le canal agréé ; lots décrits par un questionnaire d'état, tests en laboratoire partenaire, paiement du vendeur seulement après acceptation par l'acheteur.

Détails : [`docs/vision/plateforme.md`](docs/vision/plateforme.md).

Les offres Central.Parts sont consultables partout où les acheteurs travaillent : Adesio, Luminovo, CalcuQuote, les ERP, le site central.parts et les sites des distributeurs partenaires.

## Contenu du dépôt

| Dossier | Rôle | État |
|---|---|---|
| [`site/`](site/) | Landing page publique central.parts (FR / EN / 中文), statique et auto-hébergée | v0 en ligne localement |
| [`brand/`](brand/) | Logo et design tokens (couleurs, typographies) | v0 |
| [`api/`](api/) | API publique : recherche, offres, demandes de cotation, commandes | À concevoir |
| [`data/`](data/) | Connecteurs fournisseurs, normalisation et enrichissement des données produit | À concevoir |
| [`legal/`](legal/) | Gabarits contractuels (CGV, contrats distributeurs, mentions légales) | À rédiger |
| [`docs/`](docs/) | Vision, plateforme et offres, décisions d'architecture | v0 |

## Démarrer

Prévisualiser le site en local :

```bash
cd site
python3 -m http.server 8000
# puis ouvrir http://localhost:8000
```

Aucune dépendance externe au chargement : polices, React et runtime sont servis depuis `site/assets/`.

## Conventions

- Branche principale : `main`. Une branche par sujet (`site/…`, `api/…`, `data/…`, `docs/…`).
- Messages de commit en français, à l'impératif (« Ajoute le connecteur Mouser »).
- Décisions structurantes consignées dans [`docs/decisions/`](docs/decisions/) (format ADR court).
- Aucun secret, clé d'API, facture ni document personnel dans ce dépôt.

## Licence

© 2026 Central.Parts. Tous droits réservés. Code et contenus propriétaires, sans licence de réutilisation.
