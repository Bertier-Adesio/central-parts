# CLAUDE.md — Central.Parts

Instructions pour Claude Code dans ce dépôt.

## Projet

Central.Parts est un Supply Network Operator (SNO) de composants électroniques : une seule API d'offres et une seule plateforme qui relient fournisseurs et acheteurs (EMS, OEM, bureaux d'études européens), chaque offre tracée jusqu'à sa source, avec des prix comparables palier par palier. Deux offres :

- **Inventory** : réseau de fabricants (Chine, Asie-Pacifique) et de distributeurs, offre courante agrégée et exposée par API.
- **Opportunity** : surplus, obsolètes et brokers, par enchère anonyme, questionnaire d'état, laboratoires partenaires sur demande et paiement à l'acceptation (fonds de l'acheteur sur un compte dédié jusqu'à l'acceptation). Le mot « escrow » n'apparaît pas sur le site public tant que le montage juridique n'est pas validé.

Règle : la protection dépend de la source. Toute offre de broker ou de surplus passe par les rails Opportunity. Contexte complet : `docs/vision/plateforme.md`.

## Arborescence

- `site/` : landing page statique trilingue (FR `/`, EN `/en/`, 中文 `/zh/`), publiée telle quelle. Les pages HTML sont **générées** par `node tools/build-site.mjs` depuis `design/landing.dc.html`.
- `site/proto/` : prototype public du parcours (HTML écrit à la main). `site/depot/` : espace fournisseur (connexion WeChat, inscription, dépôt des fichiers de stock ; ADR 0010 et 0012, écrit à la main). `site/recherche/` : recherche publique du catalogue et demande d'achat, FR/EN/中文, suivi dans `site/recherche/commande/` (ADR 0013 et 0014, écrites à la main). `site/depot/lien/` : dépôt des listes par lien personnel, sans WeChat ; `site/offres/` : offres des fournisseurs partenaires, vendeur anonyme, date de mise à jour (ADR 0021, écrites à la main, non indexées). `site/api/` : documentation publique de l'API d'offres pour les plateformes de chiffrage (ADR 0011, spécification v1, écrite à la main, `noindex`, hors sitemap). `site/admin/` : back office des administrateurs (approbation des fournisseurs, stocks en lecture seule ; connexion Supabase Auth, ADR 0018, écrit à la main, `noindex`). `site/app/` : maquette vivante de l'application, cinq rôles et API simulée ; la carte des endpoints vient de `site/app/js/registry.js` (voir ADR 0003).
- `design/` : maquette source de la landing et de l'aperçu social.
- `brand/` : logo et design tokens (`tokens.css`).
- `supabase/` : schéma PostgreSQL (migrations, RLS, vues anonymisées), fonctions Edge (import des fichiers de stock ; `rfq` : API des plateformes, offres en direct avec formats compatibles DigiKey et TI (ADR 0024) et route RFQ validée par un administrateur et diffusée dans WeChat (ADR 0023)) et données fictives du projet dev (`seed.sql`) et du bac à sable des plateformes (`sandbox-rfq.sql`), voir ADR 0008 et 0010.
- `api/` : contrats d'API : `endpoints.md` (généré), `fournisseurs.md` (API fournisseur), `plateformes.md` (route RFQ des plateformes, ADR 0023). `data/`, `legal/` : à concevoir, voir leur README.
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
node tools/test-listes-ui.mjs          # dépôt par lien site/depot/lien/ et offres site/offres/ (même serveur), API simulée
node tools/test-api-page-ui.mjs        # documentation de l'API d'offres site/api/ (même serveur) : langues, endpoints, mots interdits, noindex
node tools/test-admin-ui.mjs           # back office site/admin/ (même serveur), API simulée ; démonstration : node tools/demo-admin.mjs
node tools/test-rfq.mjs                # route RFQ : commandes WeChat, textes, erreurs, signature des webhooks
node tools/test-catalog.mjs            # API d'offres en direct : formats natif, compatible DigiKey et compatible TI
deno run --allow-env tools/test-rfq-dispatch.ts   # route RFQ : diffusion avec WeChat simulé
node tools/test-rfq-e2e.mjs            # route RFQ de bout en bout : fonctions rfq et wechat-events sous Deno, base locale (comme test-db.sh), module pg
```

Ces tests tournent aussi sur chaque PR (`.github/workflows/tests.yml`, ADR 0016), avec la vérification de type des fonctions Edge (`deno check supabase/functions/*/index.ts`).

Toute modification du schéma passe par une nouvelle migration dans `supabase/migrations/`, vérifiée par `tools/test-db.sh` (PostgreSQL local) ; la lecture des fichiers de stock par `node tools/test-import.mjs`.

Incrémenter `?v=N` dans `site/app/index.html` à chaque modification des fichiers de `site/app/`.

## Déploiement

Route RFQ des plateformes (Adesio) : migration, secrets (`RFQ_WEBHOOK_KEY`, `RFQ_JOBS_SECRET`, `RFQ_WECHAT_OPEN`), clés d'API (`tools/create-api-key.mjs`, empreinte seule en base) et tâche planifiée : `docs/route-rfq-mise-en-service.md`. Diffusion aux fournisseurs réels fermée tant que `RFQ_WECHAT_OPEN` n'est pas `true`.

Fonctions Supabase : redéployées automatiquement à chaque push sur `main` qui les touche (`.github/workflows/deploy-supabase-functions.yml`, secret GitHub `SUPABASE_ACCESS_TOKEN`) ; à la main : `tools/deploy-functions.sh [fonction…]`. Les migrations restent manuelles, à appliquer avant de fusionner une PR qui en dépend (ADR 0016).


Hébergement OVH `centryv.cluster129.hosting.ovh.net`, dossier `www/`, envoi en SFTP via `ssh.cluster129.hosting.ovh.net` (OVH refuse le FTPS), domaines `central.parts` et `www.central.parts`. Secrets GitHub requis : `OVH_FTP_USER`, `OVH_FTP_PASSWORD`. Le certificat SSL doit être actif avant le premier déploiement, car `site/.htaccess` force le HTTPS.

## Choisir les contrôles selon ce que la PR touche (miroir de .github/workflows/tests.yml)
- Toujours (groupe "base") : node tools/test-import.mjs, node tools/test-app.mjs, deno check supabase/functions/*/index.ts,
  node tools/test-rfq.mjs, node tools/test-catalog.mjs, deno run --allow-env tools/test-rfq-dispatch.ts.
- Si supabase/migrations, checks, functions, seed.sql, reference.sql, sandbox-rfq.sql ou tools/test-rfq* changent :
  tools/test-db.sh puis node tools/test-rfq-e2e.mjs.
- Si site/ ou tools/test-*-ui.mjs changent : lancer le serveur local et les tests UI concernés dans Chromium.
- Dans la réponse finale, dire quels groupes ont tourné et lesquels non, avec les résultats.

## Production
- Un push sur main déploie le site (OVH) et les fonctions Supabase touchées. Toujours passer par une pull request, jamais de
  push direct sur main sans accord explicite de Bertier.
- Les migrations sont manuelles : si une PR en contient une, le dire en tête de la réponse (elle doit être appliquée avant la
  fusion, ADR 0016).

## Comportement
- Ne jamais prétendre qu'une page ou un parcours est vérifié sans l'avoir ouvert (1280 px et 390 px, avec et sans JavaScript).
- Tout contournement, instruction contradictoire ou étape impossible est signalé en fin de tâche sous
  "Frictions et contournements" (ou "Aucun"), avec la ligne exacte de ce fichier à corriger.
- Une décision structurante sans ADR (numéroté dans docs/decisions/) est signalée, pas tranchée en silence.
- Note : docs/decisions/ saute les numéros 0019 et 0020 ; ne pas réutiliser ni combler ces numéros sans demander.
