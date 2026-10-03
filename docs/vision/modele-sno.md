# Le modèle SNO (Supply Network Operator)

## Principe

Un opérateur mobile virtuel (MVNO) vend du service télécom sans posséder d'antennes. Central.Parts applique la même logique à la distribution de composants électroniques : **ni stock, ni entrepôt, ni camion**. La valeur est dans l'orchestration des données et des transactions entre ceux qui ont les pièces et ceux qui en ont besoin.

## Acteurs

**Fournisseurs**
- Fabricants, en priorité chinois et d'Asie du Sud-Est déjà référencés par les plateformes du marché.
- Distributeurs et revendeurs.
- Clients qui remettent sur le réseau leurs excédents de stock.

**Acheteurs**
- EMS et OEM français et européens.

**Points de contact acheteurs** (logique API native / API first)
- Plateformes de cotation et d'achat : Adesio, Luminovo, CalcuQuote.
- ERP des clients.
- Site central.parts.
- Sites des distributeurs et revendeurs qui référencent l'offre Central.Parts.

**Partenaires données**
- SiliconExpert, Octopart : échange de données fabricants déjà référencées.

## Ce que fait la plateforme

1. **Structure, fédère, collecte et distribue** la donnée produit des fabricants.
2. **Agrège l'offre** (stock, paliers de prix, délais) de toutes les sources fournisseurs.
3. **Expose** recherche, offres, cotations et commandes par API à tous les canaux acheteurs.
4. **Automatise** la transaction de bout en bout : demande, cotation, commande, suivi.

## Où intervient l'IA

- Traitement et normalisation des descriptions produit (attributs, équivalences, classification).
- Lecture des signaux de demande et d'offre du marché.
- Automatisation des échanges entre acheteurs et vendeurs.

## Correspondance avec le dépôt

| Brique | Dossier |
|---|---|
| Collecte et normalisation des données fournisseurs | `data/` |
| Exposition aux canaux acheteurs | `api/` |
| Vitrine et point d'entrée direct | `site/` |
| Identité | `brand/` |
| Cadre contractuel | `legal/` |

## Point ouvert

La landing page actuelle annonce « uniquement des distributeurs autorisés, aucun courtier, aucune source grise ». Le modèle ci-dessus inclut aussi des revendeurs et des excédents de stock clients. À arbitrer : soit deux niveaux d'offre clairement signalés (autorisé / excédent tracé), soit un discours resserré sur l'autorisé au lancement.
