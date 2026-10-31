# 0016 — Côté fournisseurs et côté clients : branches, déploiement automatique des fonctions, projet de test

- Date : 2026-11-01
- Statut : acceptée (déploiement automatique : en place ; projet Supabase de test : à créer)

## Contexte

Le dépôt porte deux côtés qui vont évoluer en parallèle :

- les **fournisseurs** : `site/depot/`, fonctions `depot`, `import-stock`, `wechat-events`, lecture des fichiers de stock ;
- les **clients** : `site/recherche/`, fonctions `search`, `order`, bientôt les comptes B2B (ADR 0015).

Les deux côtés partagent la même base, les mêmes migrations et le même code commun (`supabase/functions/_shared/`). Aujourd'hui, les fonctions sont déployées à la main depuis le Terminal ; on peut oublier une fonction, ou en déployer une depuis une branche qui n'est pas fusionnée. Avec Chris et les premiers fournisseurs, la base Supabase devient la production.

## Décision

### Un seul dépôt, des branches par côté
- On garde **un dépôt et une base**. Deux applications séparées auraient deux sources de vérité pour le schéma et le code commun, sans bénéfice à ce stade.
- **Une branche par sujet, préfixée par le côté** : `fournisseurs/…` (import, espace fournisseurs, WeChat), `clients/…` (recherche, achat, comptes), puis `site/…`, `docs/…` comme avant. Chaque branche donne une PR, relue et fusionnée par Bertier.
- Pour avancer en parallèle : **une session Claude par branche**.
- **Les migrations sont le point de coordination** : numérotées, appliquées dans l'ordre. Deux branches qui modifient le schéma sont fusionnées l'une après l'autre, chacune avec sa migration ; la seconde renumérote la sienne si besoin.

### Déploiement automatique des fonctions
- À chaque push sur `main` qui touche `supabase/functions/`, le workflow `.github/workflows/deploy-supabase-functions.yml` redéploie **seulement les fonctions touchées**. Une modification de `_shared/` redéploie les fonctions qui l'importent (`depot`, `order`, `wechat-events`).
- Les options de chaque fonction (`--no-verify-jwt` pour `depot`, `order`, `search`, `wechat-events`) sont dans un seul script, `tools/deploy-functions.sh`, utilisé aussi depuis le Terminal.
- Déploiement manuel possible depuis GitHub (Actions, puis « Run workflow »), pour une fonction précise ou pour toutes.
- **Les migrations restent manuelles**, dans le SQL Editor, dans l'ordre : une migration mal appliquée en production ne s'annule pas aussi facilement qu'un déploiement de fonction.
- Prérequis : le secret GitHub `SUPABASE_ACCESS_TOKEN` (jeton d'accès personnel Supabase). Sans lui, le workflow échoue sans rien déployer.

### Projet Supabase de test (à créer)
- Un second projet Supabase, gratuit, en région UE, sert à essayer une PR (migrations, fonctions) avant la production.
- Il reçoit les migrations, `reference.sql` et les données fictives de `seed.sql`, jamais de vraies données de fournisseurs ou de clients.
- Ses secrets de fonctions sont distincts de ceux de la production. Le compte WeChat de production n'y est pas branché : son 消息推送 pointe vers la production.
- On y déploie depuis le Terminal (`SUPABASE_PROJECT_REF=<projet de test> tools/deploy-functions.sh`).

## Conséquences

- Fusionner une PR qui touche une fonction la met en production en quelques minutes : la relecture de la PR devient le dernier contrôle. Les tests (`tools/test-db.sh`, `test-import.mjs`, `test-depot-ui.mjs`, `test-search-ui.mjs`) sont lancés avant d'ouvrir chaque PR.
- Une PR qui contient une migration et une fonction qui en dépend : appliquer la migration **avant** de fusionner, sinon la fonction déployée appellerait une base qui n'est pas encore à jour.
- Le jeton `SUPABASE_ACCESS_TOKEN` donne accès à tous les projets du compte Supabase : il ne vit que dans les secrets GitHub et dans Dashlane.
