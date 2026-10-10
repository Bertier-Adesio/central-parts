# 0003 — Maquette vivante de l'application et carte de l'API

- Date : 2026-10-10
- Statut : acceptée

## Contexte

Avant de choisir une stack et de brancher les API (banque, laboratoires, transporteurs, Adesio), il faut une vision commune de l'application de bout en bout : qui fait quoi, à quelle étape, par quel endpoint, avec quelles données visibles par chaque partie. Le projet se construit en public : cette vision doit être consultable en ligne.

## Décision

- `site/app/` contient une **maquette vivante** publiée sur `/app/` : les écrans des cinq rôles (acheteur, vendeurs, laboratoire, banque, Central.Parts) et un journal des appels d'API.
- L'API est **implémentée en mémoire dans le navigateur** (`site/app/js/api.js`) : chaque action d'écran passe par `CP.api(méthode, chemin, corps)`, qui contrôle le rôle de l'appelant, applique les règles métier et renvoie du JSON, comme le fera la vraie API. L'état est partagé entre les rôles et enregistré dans le navigateur (`localStorage`).
- `site/app/js/registry.js` est la **source unique** de la carte des endpoints et des routes. `tools/build-api-map.mjs` en génère `api/endpoints.md`.
- Deux tests sans framework : `tools/test-app.mjs` (règles métier, Node seul) et `tools/test-app-ui.mjs` (parcours complet dans Chromium, Playwright).
- Exception aux règles des pages publiées (`CLAUDE.md`) : l'application a besoin de JavaScript et de plusieurs scripts. Elle reste en JavaScript vanilla, sans framework ni CDN, avec les tokens de `brand/tokens.css`, et affiche un message `<noscript>` qui renvoie vers le prototype lisible sans JavaScript.
- L'établissement financier n'est pas nommé dans la maquette publique : le rôle s'appelle « Banque · compte dédié » tant qu'aucun accord n'est signé.

## Conséquences

- La future API part de ce contrat : chemins, rôles, statuts de transaction, codes d'erreur. Changer un endpoint se fait d'abord dans `registry.js` et `api.js`, puis on régénère `api/endpoints.md` et on relance les deux tests.
- Les données, taux et barèmes de la maquette sont fictifs ; ils ne valent pas décision.
- La maquette n'a aucune sécurité réelle : le sélecteur de rôle simule l'authentification.
- Les fichiers de l'application portent un paramètre de version (`?v=N` dans `site/app/index.html`) à incrémenter à chaque modification, car `.htaccess` met les scripts en cache un mois.
