# 0001 — Structure du dépôt

- Date : 2026-10-03
- Statut : acceptée

## Contexte

Central.Parts démarre : marque, site, API, connecteurs de données et contrats doivent avancer en parallèle, avec une petite équipe.

## Décision

Un seul dépôt (monorepo) avec un dossier par brique : `site/`, `brand/`, `api/`, `data/`, `legal/`, `docs/`. Chaque dossier a son README qui décrit son rôle et son état.

Le site est servi en statique, sans étape de build, avec toutes les ressources auto-hébergées.

Ne sont jamais versionnés : secrets, exports de données brutes, factures, documents d'identité ou de dépôt de marque.

## Conséquences

- Une seule URL à partager, un historique commun.
- Le choix des technologies de `api/` et `data/` reste ouvert et fera l'objet d'ADR dédiés.
- Si une brique doit être ouverte (SDK client, spécification OpenAPI publique), elle pourra être extraite dans son propre dépôt.
