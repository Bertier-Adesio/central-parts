# CLAUDE.md — Central.Parts

Instructions pour Claude Code dans ce dépôt.

## Projet

Central.Parts est un Supply Network Operator (SNO) de composants électroniques : une seule API d'offres et une seule plateforme qui relient fournisseurs et acheteurs (EMS, OEM, bureaux d'études européens), chaque offre tracée jusqu'à sa source, avec des prix comparables palier par palier. Deux offres :

- **Inventory** : réseau de fabricants (Chine, Asie-Pacifique) et de distributeurs, offre courante agrégée et exposée par API.
- **Opportunity** : surplus, obsolètes et brokers, par enchère anonyme, questionnaire d'état, laboratoires partenaires sur demande et paiement à l'acceptation (fonds de l'acheteur sur un compte dédié jusqu'à l'acceptation). Le mot « escrow » n'apparaît pas sur le site public tant que le montage juridique n'est pas validé.

Règle : la protection dépend de la source. Toute offre de broker ou de surplus passe par les rails Opportunity. Contexte complet : `docs/vision/plateforme.md`.

## Arborescence

- `site/` : landing page statique trilingue (FR `/`, EN `/en/`, 中文 `/zh/`), publiée telle quelle. Les pages HTML sont **générées** par `node tools/build-site.mjs` depuis `design/landing.dc.html`.
- `site/proto/` : prototype public du parcours (HTML écrit à la main). `site/depot/` : espace fournisseur (connexion WeChat, inscription, dépôt des fichiers de stock ; ADR 0010 et 0012, écrit à la main). `site/depot/aide/` : guide du fournisseur, 中文/EN, captures régénérées par `tools/capture-aide.mjs` ; modèles Excel dans `site/depot/modeles/`, générés par `python3 tools/build-templates.py`. `site/recherche/` : recherche publique du catalogue et demande d'achat, FR/EN/中文, suivi dans `site/recherche/commande/` (ADR 0013 et 0014, écrites à la main). `site/depot/lien/` : dépôt des listes par lien personnel, sans WeChat ; `site/offres/` : offres des fournisseurs partenaires, vendeur anonyme, date de mise à jour (ADR 0021, écrites à la main, non indexées). `site/fabricants/` : page publique d'un fabricant partenaire, publiée par un administrateur, sans aucun contact (ADR 0032, écrite à la main, non indexée). `site/sourcing/` : recherche payante de composants rares, paiement par virement bancaire en ligne (GoCardless Pay By Bank) ou sur proforma, suivi dans `site/sourcing/suivi/` (ADR 0033, écrites à la main, non indexées). `site/panier/` : panier des acheteurs, une demande pour plusieurs références (ADR 0028, écrit à la main, non indexé). `site/conditions/` : conditions commerciales (livraison, paiement, retours ; ADR 0029, à tenir à jour avec la règle `default_terms`, non indexées). `site/api/` : documentation publique de l'API d'offres pour les plateformes de chiffrage (ADR 0011, spécification v1, écrite à la main, `noindex`, hors sitemap). `site/admin/` : back office des administrateurs (approbation des fournisseurs, demandes de prix du site et de l'API à valider avant tout envoi au fournisseur, stocks en lecture seule ; connexion Supabase Auth, ADR 0018 et 0026, écrit à la main, `noindex`). `site/app/` : maquette vivante de l'application, cinq rôles et API simulée ; la carte des endpoints vient de `site/app/js/registry.js` (voir ADR 0003).
- `design/` : maquette source de la landing et de l'aperçu social.
- `brand/` : logo et design tokens (`tokens.css`).
- `supabase/` : schéma PostgreSQL (migrations, RLS, vues anonymisées), fonctions Edge (import des fichiers de stock ; `rfq` : API des plateformes, offres en direct avec formats compatibles DigiKey et TI (ADR 0024) et route RFQ validée par un administrateur et diffusée dans WeChat (ADR 0023) ; `rappels` : rappels WeChat avant l'expiration des offres, validité par vendeur et reconfirmation en un geste (ADR 0025), et taux de change de la BCE pour les prix publics en euros (ADR 0027)) et données fictives du projet dev (`seed.sql`) et du bac à sable des plateformes (`sandbox-rfq.sql`), voir ADR 0008 et 0010.
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
- En-tête de sécurité CSP dans `site/.htaccess` (ADR 0031) : les scripts en ligne y sont autorisés par empreinte. Après toute modification du `<script>` d'une page écrite à la main, lancer `node tools/build-csp.mjs` et committer `site/.htaccess` (`tools/build-site.mjs` le fait pour la landing ; la CI échoue sinon). Toute nouvelle source externe (image, appel réseau) s'ajoute dans `tools/build-csp.mjs`.
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
node tools/test-aide-ui.mjs            # guide du fournisseur site/depot/aide/ et modèles téléchargeables (même serveur)
node tools/test-search-ui.mjs          # recherche publique, achat et suivi site/recherche/ (même serveur), API simulée
node tools/test-listes-ui.mjs          # dépôt par lien site/depot/lien/ et offres site/offres/ (même serveur), API simulée
node tools/test-panier-ui.mjs          # panier site/panier/ : ajout depuis les offres et la recherche, envoi, suivi (même serveur), API simulée
node tools/test-csp.mjs                # en-tête CSP sur chaque page (même serveur) : aucune violation, script injecté et envoi externe refusés
node tools/test-sourcing-ui.mjs        # recherche payante site/sourcing/ et son suivi (même serveur), fonction et paiement simulés ; node tools/test-sourcing.mjs : signature des webhooks GoCardless
node tools/test-fabricants-ui.mjs      # page publique du fabricant site/fabricants/ et liens depuis les offres (même serveur), API simulée
node tools/test-api-page-ui.mjs        # documentation de l'API d'offres site/api/ (même serveur) : langues, endpoints, mots interdits, noindex
node tools/test-admin-ui.mjs           # back office site/admin/ (même serveur), API simulée, demandes à valider ; démonstration : node tools/demo-admin.mjs
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

Recherche payante (ADR 0033) : secrets `GOCARDLESS_ACCESS_TOKEN`, `GOCARDLESS_WEBHOOK_SECRET`, `GOCARDLESS_ENV` (`live` en production), webhook GoCardless vers `/functions/v1/sourcing/webhook` ; sans jeton, tout passe par la proforma : voir la section « Mise en service » de l'ADR 0033.

Fonctions Supabase : redéployées automatiquement à chaque push sur `main` qui les touche (`.github/workflows/deploy-supabase-functions.yml`, secret GitHub `SUPABASE_ACCESS_TOKEN`) ; à la main : `tools/deploy-functions.sh [fonction…]`. Les migrations restent manuelles, à appliquer avant de fusionner une PR qui en dépend (ADR 0016).


Hébergement OVH `centryv.cluster129.hosting.ovh.net`, dossier `www/`, envoi en SFTP via `ssh.cluster129.hosting.ovh.net` (OVH refuse le FTPS), domaines `central.parts` et `www.central.parts`. Secrets GitHub requis : `OVH_FTP_USER`, `OVH_FTP_PASSWORD`. Le certificat SSL doit être actif avant le premier déploiement, car `site/.htaccess` force le HTTPS.
