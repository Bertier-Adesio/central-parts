# Site central.parts

Landing page publique, trilingue (FR / EN / 中文) : recherche de démonstration, parcours acheteurs et distributeurs, fonctionnement, régions, API, garanties, FAQ, formulaire de contact.

## Structure

```
design/
├── landing.dc.html             maquette source (gabarit + traductions, objet T)
└── social-preview.html         aperçu social 1200×630
tools/
├── build-site.mjs              génère les pages statiques de site/ (Node, sans dépendance)
└── render-social.mjs           génère site/social-preview-*.png (Playwright)
site/                           publié tel quel sur OVH
├── index.html                  FR (généré)
├── en/index.html               EN (généré)
├── zh/index.html               中文 (généré)
├── social-preview-fr.png       og:image FR (généré)
├── social-preview-en.png       og:image EN et 中文 (généré)
├── proto/                      prototype public du parcours (écrit à la main, FR, données fictives)
├── app/                        maquette vivante de l'application : cinq rôles, API simulée (ADR 0003)
└── assets/
    ├── favicon.svg
    ├── tokens.css              copie de brand/tokens.css (générée)
    └── fonts/                  Space Grotesk (variable), IBM Plex Mono 400/500/600
```

Les pages sont du HTML statique : tous les textes sont écrits dans le HTML (lisible sans JavaScript, indexable, aperçus sociaux corrects). Un seul petit script vanilla en fin de page gère les exemples de recherche, le focus du champ de recherche, les onglets Acheteur / Distributeur et l'envoi du formulaire de contact. La FAQ utilise `<details>` et fonctionne sans JavaScript. Voir [ADR 0002](../docs/decisions/0002-landing-statique-generee.md).

## Prototype (`/proto/`)

`site/proto/` contient le prototype public de la plateforme (build in public) : une nomenclature répartie entre Inventory et Opportunity, puis une transaction Opportunity simulée. Écrit à la main en HTML, `proto.css` et `proto.js`, avec les tokens de `/assets/tokens.css`. Sans JavaScript, toutes les étapes s'affichent à la suite. Page en `noindex`, données fictives.

## Maquette de l'application (`/app/`)

`site/app/` est une application d'une page en JavaScript vanilla : routes `#/…` par rôle (acheteur, vendeurs, laboratoire, banque, Central.Parts), API simulée dans `js/api.js`, carte des endpoints dans `js/registry.js`, journal des appels en bas d'écran. L'état est enregistré dans le navigateur ; « Réinitialiser » repart des données de démonstration. Tests : `node tools/test-app.mjs` et `node tools/test-app-ui.mjs`. Voir [ADR 0003](../docs/decisions/0003-maquette-application.md).

## Modifier les textes

1. Modifier l'objet `T` (clés `fr`, `en`, `zh`) en bas de `design/landing.dc.html`, dans les trois langues. Titres et descriptions des pages : objet `LANGS` de `tools/build-site.mjs`.
2. Régénérer : `node tools/build-site.mjs` (depuis la racine du dépôt).
3. Si l'accroche change : `node tools/render-social.mjs` pour régénérer les aperçus sociaux.

Ne jamais modifier `site/index.html`, `site/en/` ou `site/zh/` à la main : ils sont écrasés à chaque génération.

## Prévisualiser

```bash
python3 -m http.server 8000   # depuis ce dossier
```

## Mise en ligne sur OVH

Le domaine central.parts est associé à l'hébergement web OVH `centryv.cluster129.hosting.ovh.net` (DNSSEC et protection contre le transfert actifs). Le workflow [`.github/workflows/deploy-site-ovh.yml`](../.github/workflows/deploy-site-ovh.yml) envoie en SFTP (`ssh.cluster129.hosting.ovh.net`) le contenu de `site/` dans `www/` à chaque modification poussée sur `main`.

Une seule fois, avant le premier déploiement :

1. **Espace client OVH > Hébergements > centryv > FTP-SSH** : relever l'identifiant principal, vérifier que **SSH est activé** pour lui (le déploiement passe en SFTP, le FTPS étant refusé par OVH) et, si besoin, redéfinir son mot de passe.
2. **GitHub > Settings > Secrets and variables > Actions** : créer `OVH_FTP_USER` et `OVH_FTP_PASSWORD`.
3. **Hébergements > centryv > Multisite** : vérifier que `central.parts` et `www.central.parts` pointent vers le dossier `www`, puis activer le **certificat SSL** (Let's Encrypt, gratuit) sur les deux.
4. Supprimer la page par défaut d'OVH (`www/index.html` d'origine) si elle est encore là : le premier déploiement l'écrase de toute façon.
5. Lancer le workflow à la main (**Actions > Déploiement site (OVH) > Run workflow**), puis ouvrir https://central.parts.

Le déploiement ne supprime pas ce qui a disparu de `site/` : l'étape « Nettoie www/ » du workflow retire une liste explicite (`ui_kits/`, `components/`, `tokens/`, `guidelines/`, `*.dc.html`, `support.js`, `SKILL.md`, `assets/js/`, `assets/vendor/`). Ajouter à cette liste tout fichier retiré de `site/` qui ne doit plus être en ligne.

`.htaccess` force le HTTPS, redirige `www.` vers le domaine nu et règle le cache des polices et scripts.

## À faire

- [ ] Brancher le formulaire de contact sur un vrai endpoint (aujourd'hui : `mailto:contact@central.parts`).
- [ ] Lien « Ouvrir la plateforme » après la recherche : masqué tant que la plateforme n'est pas en production.
- [ ] Logos des distributeurs partenaires : grille masquée (`showPartners: false` dans `tools/build-site.mjs`) ; la réactiver avec les vrais logos.
- [ ] Recherche de démonstration → API SiliconExpert, via un backend (`api/`) : la clé d'API ne doit jamais apparaître dans le site, qui est public.
- [x] Mobile : en-tête sur deux lignes sous 640 px (iPhone 17, Pixel Pro), plus de débordement.
- [ ] Mentions légales, politique de confidentialité, bandeau cookies si mesure d'audience.
- [ ] Premier déploiement OVH (étapes ci-dessus).
