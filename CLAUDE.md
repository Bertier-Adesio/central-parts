# CLAUDE.md — Central.Parts

Instructions pour Claude Code dans ce dépôt.

## Projet

Central.Parts est un Supply Network Operator (SNO) de composants électroniques : distributeur sans stock, ni entrepôt, ni camion, qui relie fournisseurs et acheteurs (EMS, OEM, bureaux d'études européens). Une seule plateforme, deux offres :

- **Inventory** : réseau de fabricants (Chine, Asie-Pacifique) et de distributeurs, offre courante agrégée et exposée par API.
- **Opportunity** : surplus, obsolètes et brokers, par enchère anonyme, questionnaire d'état, laboratoires partenaires sur demande et paiement à l'acceptation (fonds de l'acheteur sur un compte dédié jusqu'à l'acceptation). Le mot « escrow » n'apparaît pas sur le site public tant que le montage juridique n'est pas validé.

Règle : la protection dépend de la source. Toute offre de broker ou de surplus passe par les rails Opportunity. Contexte complet : `docs/vision/plateforme.md`.

## Arborescence

- `site/` : landing page statique trilingue (FR `/`, EN `/en/`, 中文 `/zh/`), publiée telle quelle. Les pages HTML sont **générées** par `node tools/build-site.mjs` depuis `design/landing.dc.html`.
- `site/proto/` : prototype public du parcours (HTML écrit à la main). `site/depot/` : espace fournisseur (connexion WeChat, inscription, dépôt des fichiers de stock ; ADR 0010 et 0012, écrit à la main). `site/recherche/` : recherche publique du catalogue et demande d'achat, FR/EN/中文, suivi dans `site/recherche/commande/` (ADR 0013 et 0014, écrites à la main). `site/app/` : maquette vivante de l'application, cinq rôles et API simulée ; la carte des endpoints vient de `site/app/js/registry.js` (voir ADR 0003).
- `design/` : maquette source de la landing et de l'aperçu social.
- `brand/` : logo et design tokens (`tokens.css`).
- `supabase/` : schéma PostgreSQL (migrations, RLS, vues anonymisées), fonctions Edge (import des fichiers de stock) et données fictives du projet dev, voir ADR 0008 et 0010.
- `api/`, `data/`, `legal/` : à concevoir, voir leur README.
- `docs/decisions/` : ADR numérotés (`000N-titre.md`).
- `.github/workflows/deploy-site-ovh.yml` : publie `site/` sur l'hébergement OVH à chaque push sur `main` qui touche `site/` ou le workflow, puis retire de `www/` une liste explicite de fichiers qui ne doivent plus être publiés (design system, ancien runtime).

## Règles

- Écrire en français : code commenté, README, messages de commit (impératif : « Ajoute… », « Corrige… »).
- **Le dépôt est public.** Ne jamais committer de secret, clé d'API, mot de passe, facture, document INPI, données client ou export brut. En cas de doute, demander.
- Ne jamais éditer `site/index.html`, `site/en/`, `site/zh/` à la main : modifier `design/landing.dc.html` puis lancer `node tools/build-site.mjs`, et committer le résultat.
- Textes du site : objet `T` en bas de `design/landing.dc.html`. Toute modification se fait dans les trois langues (`fr`, `en`, `zh`).
- Les pages publiées n'utilisent aucun runtime ni framework : HTML statique, un seul `<script>` vanilla en fin de page, tout lisible sans JavaScript.
- Couleurs et typos : utiliser les variables de `brand/tokens.css` (alias sémantiques `--bg-*`, `--fg-*`, `--accent`…), pas de valeurs en dur.
- Aucune ressource chargée depuis un CDN : tout est auto-hébergé dans `site/assets/`.
- Le site doit rester accessible depuis la Chine : aucun lien ni ressource vers Google, LinkedIn ou un autre service tiers (le build échoue sinon), seule exception : le formulaire partenaire Tencent Docs. Voir `docs/decisions/0006-acces-depuis-la-chine.md`.
- Une branche par sujet (`fournisseurs/…`, `clients/…`, `site/…`, `api/…`, `data/…`, `docs/…`, voir ADR 0016), puis pull request vers `main`. Ne pas pousser directement sur `main` sans accord, car cela déploie le site et les fonctions Supabase touchées en production.
- Toute décision structurante (stack API, modèle de données, hébergement) donne lieu à un ADR dans `docs/decisions/`.

## Vérifier le site

```bash
cd site && python3 -m http.server 8000
```

Contrôler `/`, `/en/` et `/zh/` à 1280 px et 390 px de large, avec et sans JavaScript, sans erreur console ni requête externe, et sans aucun `{{` dans le HTML (`grep -c '{{' site/index.html site/*/index.html`).

## Vérifier la maquette de l'application

```bash
node tools/test-app.mjs                 # règles métier de l'API simulée
node tools/build-api-map.mjs            # régénère api/endpoints.md après toute modification de registry.js
(cd site && python3 -m http.server 8765) & node tools/test-app-ui.mjs   # parcours complet dans Chromium
node tools/test-depot-ui.mjs           # espace fournisseur site/depot/ (même serveur), API simulée
node tools/test-search-ui.mjs          # recherche publique, achat et suivi site/recherche/ (même serveur), API simulée
```

Ces tests tournent aussi sur chaque PR (`.github/workflows/tests.yml`, ADR 0016), avec la vérification de type des fonctions Edge (`deno check supabase/functions/*/index.ts`).

Toute modification du schéma passe par une nouvelle migration dans `supabase/migrations/`, vérifiée par `tools/test-db.sh` (PostgreSQL local) ; la lecture des fichiers de stock par `node tools/test-import.mjs`.

Incrémenter `?v=N` dans `site/app/index.html` à chaque modification des fichiers de `site/app/`.

## Déploiement

Fonctions Supabase : redéployées automatiquement à chaque push sur `main` qui les touche (`.github/workflows/deploy-supabase-functions.yml`, secret GitHub `SUPABASE_ACCESS_TOKEN`) ; à la main : `tools/deploy-functions.sh [fonction…]`. Les migrations restent manuelles, à appliquer avant de fusionner une PR qui en dépend (ADR 0016).


Hébergement OVH `centryv.cluster129.hosting.ovh.net`, dossier `www/`, envoi en SFTP via `ssh.cluster129.hosting.ovh.net` (OVH refuse le FTPS), domaines `central.parts` et `www.central.parts`. Secrets GitHub requis : `OVH_FTP_USER`, `OVH_FTP_PASSWORD`. Le certificat SSL doit être actif avant le premier déploiement, car `site/.htaccess` force le HTTPS.
