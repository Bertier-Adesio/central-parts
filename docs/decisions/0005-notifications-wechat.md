# 0005 — Notifications des vendeurs sur WeChat et WeCom

- Date : 2026-10-11
- Statut : proposée

## Contexte

Une grande partie du stock Opportunity est détenue par des vendeurs chinois, qui travaillent sur WeChat plutôt que par e-mail. Une demande a une durée de vie courte (enchère de deux jours ouvrés) : un vendeur qui ne la voit pas à temps ne répond pas.

## Décision

- Les événements vendeur (`demand.created`, `offer.accepted`, `transaction.updated`) sont envoyés sur des **canaux de notification** choisis par chaque société : e-mail, robot de groupe **WeCom (企业微信)**, compte de service **WeChat (服务号)**, en plus des webhooks de l'API fournisseur.
- Chaque canal a sa **langue** (中文, English, Français) ; les messages des vendeurs chinois sont en chinois.
- Le robot WeCom se branche par une URL fournie par le vendeur. Le compte de service se lie par un **QR code** temporaire ; l'événement WeChat rattache l'openid au canal.
- Les messages restent **anonymes** : ni nom ni adresse de l'acheteur. Ils renvoient vers la demande sur la plateforme, où le vendeur répond.
- Implémentation simulée dans la maquette (`site/app/js/api.js`, écran `#/vendeur/notifications`) ; spécification dans `api/fournisseurs.md`.

## Conséquences

- Il faut un compte de service WeChat vérifié et des modèles de message approuvés, ou un partenaire en Chine.
- La page de réponse doit être disponible en chinois et rapide depuis la Chine.
- D'autres messageries (DingTalk, Feishu, WhatsApp) pourront s'ajouter comme nouveaux types de canal sans changer les événements.
