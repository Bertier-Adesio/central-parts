# 0018 — Back office administrateur : approbation des fournisseurs et lecture des stocks

- Date : 2026-11-02
- Statut : proposée (phase 1 ; migration 20261102000014 à appliquer après accord)

## Contexte

Les fournisseurs s'inscrivent seuls (ADR 0012) et sont validés par un opérateur dans WeChat (commandes `approve ORG-…`, `reject ORG-… motif`). C'est suffisant pour quelques sociétés, pas pour le lancement du 9 novembre et electronica (10–13 novembre) : il faut voir la fiche complète, la liste des sociétés en attente, un journal des décisions, et consulter les stocks déposés (dont des fichiers de plus de 1 800 références).

## Décision

### Une page /admin/ sur le même hébergement, branchée sur Supabase
- `site/admin/` : HTML statique écrit à la main, un seul script vanilla, aucune ressource externe, `noindex` (balise et en-tête `X-Robots-Tag`), absente du plan du site et de toute navigation. Point d'entrée : **https://central.parts/admin/**, à garder en favori.
- La page n'est qu'une façade : **la protection est côté serveur**. La fonction Edge `admin` vérifie le jeton de l'utilisateur, puis appelle les fonctions SQL `admin_*` **avec ce jeton** ; chacune refuse quiconque n'est pas administrateur (erreur 42501). anon n'a le droit d'en exécuter aucune. Aucune clé (ni service, ni anon) dans la page.

### Administrateur = membre de l'organisation Central.Parts dans Supabase Auth
- Choix de Bertier (2 novembre 2026) : connexion par **lien e-mail** (Supabase Auth, sans mot de passe), plutôt que par l'identité WeChat du robot.
- Est administrateur l'utilisateur rattaché (table `members`) à l'organisation de type `ops`, c'est-à-dire `app.is_ops()` du schéma initial, déjà utilisé par les politiques de sécurité par ligne. Pas de nouvelle liste : un seul mécanisme pour la base et le back office.
- Aucun compte n'est créé par la page (`shouldCreateUser: false`) ; la réponse ne dit pas si l'adresse existe.
- Session limitée : le jeton d'accès Supabase vit une heure et n'est pas renouvelé. Depuis le 3 novembre 2026 (demande de Bertier), il est partagé par les onglets du navigateur (`localStorage`) : un onglet ouvert après la connexion est déjà connecté, et le lien e-mail ouvert dans un nouvel onglet connecte aussi celui resté sur la page de connexion. Se déconnecter dans un onglet déconnecte tous les autres ; un jeton expiré est effacé. Le jeton survit à la fermeture du navigateur jusqu'à son expiration, une heure au plus : se déconnecter avant de quitter un poste partagé.

### Même logique métier que le robot WeChat
- `admin_approve` et `admin_reject` appellent `approve_supplier` et `reject_supplier`, les fonctions du robot ; rien n'est réécrit à côté.
- Nouveaux pour les deux canaux : journal `supplier_decisions` en ajout seul (qui, quand, quoi, statut d'avant, motif), alimenté par ces fonctions mêmes ; décision « remettre en attente » (`reset_supplier_pending`) ; une société réapprouvée garde son pseudonyme V-n.
- Décisions réversibles, historique jamais effacé. Une société approuvée ne se refuse pas directement (règle du robot inchangée) : on la remet en attente, puis on la refuse.
- Motif du refus obligatoire dans le back office (`admin_reject`, code CP005). Le robot garde `reject ORG-…` sans motif, pour ne pas changer son comportement.
- Messages au fournisseur : les mêmes que ceux du robot à l'approbation et au refus, rien de plus. La remise en attente n'envoie rien.

### Stocks et offres en lecture seule
- Par fournisseur : références en stock, dernier import, source, devise. Recherche par référence, marque ou boîtier / emballage (colonne `pack` : la base n'a pas de colonne « boîtier » distincte). Paliers « de … à … » calculés depuis `lot_price_breaks`. 50 lignes par page.

## Conséquences

- À faire une fois, dans Supabase (après accord) : appliquer la migration, créer le compte de Bertier dans Authentication > Users et le rattacher à l'organisation Central.Parts, ajouter `https://central.parts/admin/` aux Redirect URLs. Voir `supabase/README.md`.
- La fonction `admin` est déployée sans vérification de jeton par la passerelle (pour la demande de lien), comme `depot` : elle contrôle elle-même chaque appel.
- Phase 2 (après electronica) : boîte de réception WeChat, plusieurs administrateurs avec rôles. Les demandes de prix du site (PR-…) et de l'API (DEM-…) sont validées dans l'onglet « Demandes » depuis le 3 novembre 2026 (ADR 0026).
