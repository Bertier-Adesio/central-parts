# Marque Central.Parts

## Logo

[`logo.svg`](logo.svg) : deux arcs concentriques encre (`#15171C`) ouverts vers la droite, point central rouge (`#D7262E`). Le mot-symbole s'écrit **Central.Parts**, avec le point en rouge.

## Couleurs

| Rôle | Valeur |
|---|---|
| Encre | `#15171C` |
| Papier | `#F4F2EE` |
| Rouge Central | `#D7262E` |
| Rouge vif | `#E8442A` |
| Rouge profond (survol, danger) | `#B3122E` |
| Ligne | `#D9D5CD` |

L'ensemble des variables (échelle de neutres, alias sémantiques, statuts de stock, espacements, rayons, ombres) est dans [`tokens.css`](tokens.css), extrait de la landing page. Dans le code, utiliser les alias sémantiques (`--bg-*`, `--fg-*`, `--border-*`, `--accent`, `--status-*`) plutôt que l'échelle brute.

## Typographies

- **Space Grotesk** (300–700) : titres et texte courant.
- **IBM Plex Mono** (400, 500, 600) : références fabricant, prix, données techniques, étiquettes.

Fichiers `woff2` dans [`site/assets/fonts/`](../site/assets/fonts/). Les deux familles sont sous licence SIL Open Font License.
