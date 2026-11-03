# 0031 — En-tête de sécurité Content-Security-Policy

- Date : 2026-11-03
- Statut : acceptée (Bertier, 3 novembre 2026)

## Contexte

Le site n'envoyait que trois en-têtes de sécurité : HTTPS obligatoire (HSTS), `X-Content-Type-Options` et `Referrer-Policy`. Le panier et le back office manipulent des coordonnées d'entreprises, des numéros de TVA et des comptes transporteurs. L'analyse des plateformes concurrentes relevait l'absence d'en-tête CSP comme un point faible.

## Décision

- **En-tête `Content-Security-Policy`** sur toutes les pages, posé par `site/.htaccess` (Apache, OVH), avec `X-Frame-Options: DENY` pour les anciens navigateurs.
- **Scripts** : seuls les fichiers du site et les scripts en ligne **répertoriés par leur empreinte sha256** s'exécutent. Il n'y a pas de `'unsafe-inline'` : un script injecté ou modifié est refusé par le navigateur.
- **Sources autorisées**, en plus du site lui-même :
  - appels réseau vers Supabase (fonctions Edge, dépôt des fichiers) ;
  - image du QR code WeChat (`mp.weixin.qq.com`, `/depot/`) ;
  - formulaire `mailto:` de l'accueil.
  Tout le reste est refusé : polices, images, scripts et appels vers un autre site, ce qui confirme la règle d'accès depuis la Chine (ADR 0006).
- **Interdits** : affichage du site dans un cadre (`frame-ancestors 'none'`, contre le clickjacking), objets (`object-src 'none'`), changement de base (`base-uri 'self'`).
- **Styles** : `'unsafe-inline'` pour les styles seulement (attributs `style` des pages). Un style ne peut pas exécuter de code.

## Mise en œuvre

- `tools/build-csp.mjs` calcule les empreintes des scripts en ligne de toutes les pages et écrit l'en-tête entre les repères `# CSP:BEGIN` et `# CSP:END` de `site/.htaccess`.
- `tools/build-site.mjs` l'appelle après la génération de la landing.
- La CI échoue si l'en-tête n'est plus à jour (`node tools/build-csp.mjs --check`).
- `tools/test-csp.mjs` sert chaque page avec l'en-tête dans Chromium. Il vérifie qu'aucune violation n'apparaît au chargement, que le QR code WeChat s'affiche, et qu'un script injecté comme un envoi vers un site inconnu sont refusés.

## Conséquences

- Après toute modification du `<script>` d'une page écrite à la main : `node tools/build-csp.mjs`, puis committer `site/.htaccess`.
- Une nouvelle source externe s'ajoute dans `tools/build-csp.mjs`, avec sa raison.
- En cas de problème en production, retirer le bloc CSP de `site/.htaccess` (ou annuler la PR) rétablit l'état antérieur au déploiement suivant.
