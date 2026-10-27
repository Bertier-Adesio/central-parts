# 0006 — Accès au site depuis la Chine

- Date : 2026-10-27
- Statut : proposée (mesures et hébergement à trancher)

## Contexte

Central.Parts s'adresse d'abord à des fabricants chinois, rencontrés à electronica 2026 puis via WeChat. Le site est hébergé chez OVH en France. Il n'est pas bloqué a priori, mais la distance (latence élevée, pertes de paquets) et l'inaccessibilité de nombreux services occidentaux depuis la Chine peuvent le rendre lent, voire incomplet. L'hébergement en Chine continentale exige une licence ICP, qui suppose une entité chinoise : hors de portée à court terme.

## Décision (appliquée)

Le site ne dépend d'aucun service tiers :

- Aucune ressource ni aucun lien vers Google, LinkedIn, réseaux sociaux, CDN, polices ou scripts externes. `tools/build-site.mjs` échoue si une page référence un domaine autre que `central.parts`.
- Polices auto-hébergées, préchargées ; pas de police CJK à télécharger (pile système PingFang SC / Microsoft YaHei).
- Page légère (une trentaine de Ko, environ 7 Ko compressée), compression activée, cache réglé dans `.htaccess`.
- `/` redirige vers `/zh/` ou `/en/` selon la langue du navigateur, sauf si le visiteur vient déjà du site (le sélecteur de langue reste utilisable).
- L'adresse e-mail est affichée en clair : le lien `mailto:` ne fonctionne pas dans le navigateur intégré de WeChat.

## Points ouverts

1. **Mesurer** le temps de chargement depuis plusieurs villes chinoises, avec un outil de test depuis des nœuds en Chine, avant de payer quoi que ce soit.
2. **Si c'est lent** : placer un CDN doté de points de présence en Chine devant OVH, ou servir une copie statique depuis Hong Kong (sans licence ICP). À comparer en coût et en résultat de mesure, puis consigner le choix dans un nouvel ADR.
3. **Formulaire de contact** : remplacer le `mailto:` par un vrai endpoint (voir `site/README.md`), ou renvoyer vers le formulaire WeChat. Aujourd'hui, le message « Demande envoyée » s'affiche même si aucun client de messagerie ne s'ouvre.

## Conséquences

- Toute nouvelle ressource externe fait échouer la génération : il faut l'auto-héberger.
- Le coût d'un CDN ou d'un hébergement à Hong Kong n'est engagé qu'après mesure.
