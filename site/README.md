# Site central.parts

Landing page publique, trilingue (FR / EN / 中文) : recherche de démonstration, parcours acheteurs et distributeurs, fonctionnement, régions, API, garanties, FAQ, formulaire de contact.

## Structure

```
site/
├── index.html                  page (contenu + traductions dans le bloc <script data-dc-script>)
└── assets/
    ├── favicon.svg
    ├── fonts/                  Space Grotesk (variable), IBM Plex Mono 400/500/600
    ├── js/dc-runtime.js        runtime de rendu (fichier généré, ne pas modifier)
    └── vendor/                 React 18.3.1 et ReactDOM 18.3.1 (UMD, production)
```

La page provient d'un export « bundled » de Claude Design, dégroupé pour être servi tel quel par n'importe quel hébergement statique (OVH, GitHub Pages, Netlify…). `window.__resources` dans `<head>` redirige les URL unpkg de React vers `assets/vendor/`, donc aucune requête ne sort vers un CDN.

## Modifier les textes

Les textes des trois langues sont dans l'objet `T` (clés `fr`, `en`, `zh`) en bas de `index.html`. Modifier les trois langues ensemble.

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

`.htaccess` force le HTTPS, redirige `www.` vers le domaine nu et règle le cache des polices et scripts.

## À faire

- [ ] Brancher le formulaire de contact (aujourd'hui il affiche seulement « Demande envoyée »).
- [ ] Remplacer les huit emplacements « Logo distributeur » par de vrais partenaires.
- [ ] Recherche de démonstration → appel réel à l'API (`api/`).
- [x] Mobile : en-tête sur deux lignes sous 640 px (iPhone 17, Pixel Pro), plus de débordement.
- [ ] Mentions légales, politique de confidentialité, bandeau cookies si mesure d'audience.
- [ ] Premier déploiement OVH (étapes ci-dessus).
