# 0002 — Landing statique générée

- Date : 2026-10-03
- Statut : acceptée

## Contexte

La landing provient d'un export Claude Design : un gabarit (`{{ … }}`, `<sc-for>`, `<sc-if>`) rendu dans le navigateur par un runtime et React. Servi sans ce runtime, le gabarit s'affiche brut ; même avec, les textes n'existent pas dans le HTML, ce qui pénalise le référencement, les aperçus sociaux et la lecture sans JavaScript.

## Décision

La maquette reste la source (`design/landing.dc.html`). `tools/build-site.mjs` (Node, sans dépendance) en génère trois pages HTML statiques : `/` (FR), `/en/`, `/zh/`. Tous les textes sont écrits dans le HTML, les styles inline sont conservés à l'identique, les listes sont dépliées. Les interactions passent par `<details>` (FAQ) et un seul script vanilla en fin de page. Les pages générées sont versionnées et publiées telles quelles : pas d'étape de build au déploiement.

## Conséquences

- Plus de dépendance au runtime ni à React en production.
- Toute modification de texte passe par la maquette puis par le script ; éditer `site/*.html` à la main est perdu à la génération suivante.
- Le script s'arrête si la maquette change d'une façon qu'il ne sait pas convertir, plutôt que de publier une page fausse.
