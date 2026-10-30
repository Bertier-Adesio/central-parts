# 0012 — Inscription des fournisseurs chinois et invitation des collègues

- Date : 2026-10-30
- Statut : proposée

## Contexte

Le dépôt de stock par WeChat est en service (ADR 0010). Aujourd'hui, l'opérateur crée chaque société à la main dans l'éditeur SQL, puis un lien d'invitation par contact. Ce fonctionnement suffit pour quelques fournisseurs, mais il ne passe pas à l'échelle.

Pour l'instant, Central.Parts ne recrute que des **fournisseurs chinois**, et ceux-ci travaillent sur WeChat. Le réseau ne doit pas se remplir de petits brokers sans contrôle : ceux-là ont vocation à être fédérés par un broker établi qui en répond.

## Décision

### Inscription en libre-service, publication après validation

1. **Connexion par WeChat seulement.** Le fournisseur scanne le QR code du compte de service sur `https://central.parts/depot/` (ADR 0010). Pas d'e-mail ni de mot de passe pour l'instant. La page est en chinois par défaut.
2. **Enregistrement de la société.** Un compte WeChat sans société voit un formulaire, à la place du message « non rattaché ». Il saisit :
   - le nom chinois de la société ;
   - le **统一社会信用代码**, c'est-à-dire le numéro unique de 18 caractères, avec contrôle de la clé ;
   - la ville ;
   - le profil : fabricant, distributeur, revendeur ou broker ;
   - la devise ;
   - une photo du **营业执照** (licence commerciale).

   Celui qui enregistre la société en devient l'**administrateur**.
3. **Une société n'existe qu'une fois.** Le numéro 统一社会信用代码 est unique. S'il est déjà enregistré, la personne ne crée rien : elle envoie une demande d'adhésion, que l'administrateur de la société accepte ou refuse.
4. **Transmettre à qui de droit.** Souvent, la personne qui découvre la page, un commercial ou une assistante, n'est pas celle qui engage la société. Elle peut donc :
   - commencer l'enregistrement, puis choisir « 我不是负责人，转发给负责人 » (je ne suis pas le responsable, je transmets). La page crée un **lien de transmission**, à usage unique et valable 14 jours, avec les informations déjà saisies. La personne l'envoie dans WeChat, en copiant le lien ou en enregistrant une image avec un QR code, faute de partage personnalisé sans licence ICP. Le responsable ouvre le lien, scanne, vérifie, complète et confirme : il devient administrateur, et l'initiateur devient membre ;
   - si la société existe déjà, transmettre de la même façon sa demande d'adhésion à l'administrateur, qui l'accepte en scannant.

   L'initiateur voit où en est sa demande : transmise, confirmée ou expirée.
5. **Invitation des collègues par l'administrateur, depuis la page.** L'administrateur :
   - génère les liens d'invitation, à usage unique et valables 14 jours, comme aujourd'hui ;
   - choisit le rôle : administrateur ou membre ;
   - retire un accès.

   Une société garde toujours au moins un administrateur.
6. **Dépôt possible avant validation, sans publication.** Une société en attente peut déposer son stock. Ses lots ne sont ni publiés ni renvoyés par `search_stock` ou l'API d'offres (ADR 0011) tant qu'elle n'est pas validée, car `app.is_verified` exige déjà un KYB validé et un abonnement en cours.

### Validation par l'opérateur, dans WeChat

- À chaque nouvelle société, le compte de service envoie aux opérateurs un **message modèle** (模板消息), du type « 审核通知 » : nom, numéro, ville, profil, nombre de lignes déposées, lien vers la licence.
- L'opérateur répond dans la conversation du compte de service :
  - **通过** : validée ; pseudonyme V-n attribué, abonnement ouvert, lots publiés ;
  - **拒绝 + motif** : refusée, avec le motif transmis au fournisseur ;
  - **转给 V-n** : orientée vers un fédérateur (voir plus bas).
- Le fournisseur reçoit la réponse dans WeChat.
- Seuls les comptes WeChat inscrits dans la table des opérateurs peuvent valider ; les messages des autres comptes sont ignorés. La même validation reste possible depuis l'éditeur SQL (`approve_supplier`, `reject_supplier`).
- Le contrôle automatique du numéro auprès d'un registre (国家企业信用信息公示系统 ou un service commercial) viendra plus tard. Au départ, l'opérateur compare lui-même la licence et le numéro.

### Fédération des petits brokers

- Une société validée peut être **fédératrice** : un broker établi, qui recrute et répond de petits brokers.
- Un petit broker orienté vers un fédérateur devient son **sous-fournisseur** : sa société a une société parente. C'est le fédérateur qui le valide, par le même message dans WeChat.
- Les lots du sous-fournisseur sont publiés sous le pseudonyme du fédérateur. La base garde toujours le sous-fournisseur d'origine de chaque lot, pour la traçabilité, les notes, les suspensions et les litiges sur les rails Opportunity.

### Modèle de données (migration à venir)

- `organizations` reçoit :
  - `credit_code` : unique, pour les sociétés chinoises ;
  - `status` : `pending`, `validated`, `rejected` ou `federated` ;
  - `parent_org_id` : le fédérateur, le cas échéant ;
  - `license_path` : la photo de la licence, dans un compartiment privé.
- `wechat_identities` reçoit un rôle (`admin` ou `member`). Une identité reste rattachée à une seule société.
- Nouvelles tables : `join_requests` (demandes d'adhésion), `registration_handoffs` (enregistrements transmis au responsable, empreinte du jeton seule) et `operators` (openid autorisés à valider).
- Le pseudonyme V-n est attribué automatiquement à la validation.
- Les sociétés créées à la main avant cette décision deviennent `validated`. Leur premier contact devient administrateur.

## Points ouverts

- **Vendeur des lots fédérés** : le fédérateur, responsable et seul interlocuteur (recommandé), ou chaque sous-fournisseur ?
- **Rémunération du fédérateur** : une marge qu'il fixe sur le prix de ses sous-fournisseurs, ou une commission versée par Central.Parts ?
- L'accord du premier fédérateur pressenti pour porter cette responsabilité.
- Le choix du message modèle dans la bibliothèque de la console WeChat.

## Conséquences

- L'opérateur ne crée plus de société et ne génère plus d'invitation. Il valide, refuse ou oriente, depuis WeChat.
- `site/depot/` devient l'espace du fournisseur : inscription, dépôt, collègues et, pour un fédérateur, ses sous-fournisseurs.
- Le jour où des fournisseurs non chinois ou des acheteurs s'inscriront, il faudra une table des personnes avec plusieurs moyens de connexion (WeChat, e-mail). Elle fera l'objet d'un ADR à part ; le modèle ci-dessus est prévu pour être repris par cette table.
- Les photos de licence sont des documents d'entreprise : compartiment privé, jamais dans le dépôt Git.
