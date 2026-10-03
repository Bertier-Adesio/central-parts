# CLAUDE.md — Central.Parts

Instructions pour Claude Code dans ce dépôt.

## Projet

Central.Parts est un Supply Network Operator (SNO) de composants électroniques : distributeur sans stock, ni entrepôt, ni camion, qui relie par API fournisseurs (fabricants, distributeurs, revendeurs, excédents clients) et acheteurs (EMS et OEM européens). Contexte complet : `docs/vision/modele-sno.md`.

## Arborescence

- `site/` : landing page statique trilingue (FR `/`, EN `/en/`, 中文 `/zh/`), publiée telle quelle. Les pages HTML sont **générées** par `node tools/build-site.mjs` depuis `design/landing.dc.html`.
- `design/` : maquette source de la landing et de l'aperçu social.
- `brand/` : logo et design tokens (`tokens.css`).
- `api/`, `data/`, `legal/` : à concevoir, voir leur README.
- `docs/decisions/` : ADR numérotés (`000N-titre.md`).
- `.github/workflows/deploy-site-ovh.yml` : publie `site/` sur l'hébergement OVH à chaque push sur `main` qui touche `site/`.

## Règles

- Écrire en français : code commenté, README, messages de commit (impératif : « Ajoute… », « Corrige… »).
- **Le dépôt est public.** Ne jamais committer de secret, clé d'API, mot de passe, facture, document INPI, données client ou export brut. En cas de doute, demander.
- Ne jamais éditer `site/index.html`, `site/en/`, `site/zh/` à la main : modifier `design/landing.dc.html` puis lancer `node tools/build-site.mjs`, et committer le résultat.
- Textes du site : objet `T` en bas de `design/landing.dc.html`. Toute modification se fait dans les trois langues (`fr`, `en`, `zh`).
- Les pages publiées n'utilisent aucun runtime ni framework : HTML statique, un seul `<script>` vanilla en fin de page, tout lisible sans JavaScript.
- Couleurs et typos : utiliser les variables de `brand/tokens.css` (alias sémantiques `--bg-*`, `--fg-*`, `--accent`…), pas de valeurs en dur.
- Aucune ressource chargée depuis un CDN : tout est auto-hébergé dans `site/assets/`.
- Une branche par sujet (`site/…`, `api/…`, `data/…`, `docs/…`), puis pull request vers `main`. Ne pas pousser directement sur `main` sans accord, car cela déploie le site en production.
- Toute décision structurante (stack API, modèle de données, hébergement) donne lieu à un ADR dans `docs/decisions/`.

## Vérifier le site

```bash
cd site && python3 -m http.server 8000
```

Contrôler `/`, `/en/` et `/zh/` à 1280 px et 390 px de large, avec et sans JavaScript, sans erreur console ni requête externe, et sans aucun `{{` dans le HTML (`grep -c '{{' site/index.html site/*/index.html`).

## Déploiement

Hébergement OVH `centryv.cluster129.hosting.ovh.net`, dossier `www/`, envoi en SFTP via `ssh.cluster129.hosting.ovh.net` (OVH refuse le FTPS), domaines `central.parts` et `www.central.parts`. Secrets GitHub requis : `OVH_FTP_USER`, `OVH_FTP_PASSWORD`. Le certificat SSL doit être actif avant le premier déploiement, car `site/.htaccess` force le HTTPS.
