# Offre Inventory : le réseau fabricants et distributeurs

*Version 0.2 · 10 octobre 2026 · Document de travail.*

Cadre général : [`plateforme.md`](plateforme.md).

## Principe

Inventory est l'offre courante de Central.Parts : l'agrégation, sans stock propre, de l'offre des fabricants et des distributeurs, exposée par API à tous les canaux où les acheteurs travaillent. C'est le cœur du modèle Supply Network Operator.

## Fournisseurs

- **Fabricants**, en priorité chinois et d'Asie-Pacifique déjà référencés par les plateformes du marché.
- **Distributeurs**.

Les offres de brokers et de détenteurs de surplus ne passent pas par Inventory : elles suivent les rails de l'offre [Opportunity](opportunity.md) (questionnaire d'état et escrow obligatoires), même pour une référence courante.

## Acheteurs

EMS et OEM français et européens.

**Points de contact** (API first) : plateformes de cotation et d'achat (Adesio, Luminovo, CalcuQuote), ERP des clients, site central.parts, sites des distributeurs et revendeurs qui référencent l'offre Central.Parts.

## Ce que fait l'offre

1. **Structure, fédère, collecte et distribue** la donnée produit des fabricants.
2. **Agrège l'offre** (stock, paliers de prix, délais) des fabricants et des distributeurs.
3. **Expose** recherche, offres, cotations et commandes par API à tous les canaux acheteurs.
4. **Automatise** la transaction de bout en bout : demande, cotation, commande, suivi.

## Preuve de conformité et paiement

- Traçabilité jusqu'au fabricant ; certificat de conformité du fabricant ou du distributeur.
- Paiement classique, éventuellement à terme, selon les conditions du client.

## Partenaires données

Échange de données produit avec des référentiels comme SiliconExpert ou Octopart, dans le cadre d'accords écrits. Les données de prix et de stock de ces services ne servent jamais à alimenter ou valoriser l'offre de Central.Parts (voir [`plateforme.md`](plateforme.md)).
