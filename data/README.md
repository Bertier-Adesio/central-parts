# Données produit et offre

Collecte, normalisation et enrichissement des données composants issues des fournisseurs et des partenaires données.

## Sources prévues

- Fabricants (priorité Chine et Asie du Sud-Est).
- Distributeurs et revendeurs : flux de stock et de prix (fichier ou API).
- Excédents de stock clients.
- Partenaires données : SiliconExpert, Octopart.

## Formats d'échange

[`formats.md`](formats.md) : canaux (API, SFTP au-delà de 500 000 lignes), format broker, Octopart et ECIA, règles d'import et questions ouvertes.

## Organisation envisagée

```
data/
├── connectors/   un connecteur par source
├── schema/       modèle de données pivot (pièce, fabricant, offre, palier de prix)
├── pipelines/    normalisation, dédoublonnage, enrichissement IA
└── samples/      petits jeux d'exemple anonymisés (seuls CSV versionnés)
```

Les données brutes et les exports restent hors du dépôt (voir `.gitignore`).
