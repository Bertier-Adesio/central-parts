#!/usr/bin/env node
// Génère api/endpoints.md depuis le registre de la maquette (site/app/js/registry.js).
// Usage : node tools/build-api-map.mjs   (aucune dépendance)

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(readFileSync(join(ROOT, 'site/app/js/registry.js'), 'utf8'), ctx);
const { CP_GROUPS, CP_ENDPOINTS, CP_ROUTES } = vm.runInContext('({ CP_GROUPS, CP_ENDPOINTS, CP_ROUTES })', ctx);

const ROLE = { public: 'Public', buyer: 'Acheteur', seller: 'Vendeur', lab: 'Laboratoire', bank: 'Banque', ops: 'Central.Parts', system: 'Système' };
const cell = (s) => String(s).replace(/\|/g, '\\|');
const screens = {};
for (const r of CP_ROUTES) for (const id of r.endpoints) (screens[id] ||= []).push('`' + r.path + '`');

let md = `# Carte des endpoints et des routes

> Fichier généré par \`node tools/build-api-map.mjs\` depuis \`site/app/js/registry.js\` : ne pas modifier à la main.

${CP_ENDPOINTS.length} endpoints et ${CP_ROUTES.length} routes d'écran, implémentés en mémoire par la maquette vivante (\`site/app/\`, publiée sur \`/app/\`). C'est le contrat de départ de la future API : chemins, rôles autorisés et règles métier (\`site/app/js/api.js\`). Les données sont fictives.

## Conventions

- Préfixe \`/v1\` pour l'API de la plateforme ; \`/bank/v1\` désigne l'API attendue de l'établissement qui tient le compte dédié.
- Le rôle de l'appelant (session ou clé d'API de sa société) filtre les données : le vendeur ne voit jamais l'identité ni l'adresse de l'acheteur, l'acheteur ne voit que le pseudonyme du vendeur, le laboratoire ne voit que des pseudonymes.
- Les webhooks entrants (\`/v1/webhooks/…\`) sont signés par l'émetteur : banque, transporteur.
- Rôle « Système » : tâches planifiées et webhooks traités par la plateforme elle-même.
- Erreurs : \`403\` rôle non autorisé, \`404\` ressource absente ou hors du périmètre de l'appelant, \`409\` action impossible à l'étape en cours, \`422\` données invalides.

`;

for (const [key, label] of CP_GROUPS) {
  md += `## ${label}\n\n| Méthode | Chemin | Rôles | Rôle de l'endpoint | Écrans |\n|---|---|---|---|---|\n`;
  for (const e of CP_ENDPOINTS.filter((x) => x.group === key)) {
    md += `| ${e.method} | \`${e.path}\` | ${e.roles.map((r) => ROLE[r]).join(', ')} | ${cell(e.summary)} | ${(screens[e.id] || ['Hors écran : intégration, webhook ou tâche']).join(', ')} |\n`;
  }
  md += '\n';
}

md += `## Routes des écrans\n\n| Route | Rôle | Écran | Endpoints |\n|---|---|---|---|\n`;
for (const r of CP_ROUTES) md += `| \`#${r.path}\` | ${ROLE[r.role]} | ${cell(r.title)} | ${r.endpoints.map((id) => '`' + id + '`').join(', ') || '—'} |\n`;

md += `\n## Étapes d'une transaction Opportunity\n
| Statut | Étape | Qui agit | Endpoint qui fait avancer |
|---|---|---|---|
| \`to_sign_buyer\`, \`to_sign_seller\` | Signatures | Acheteur, puis vendeur | \`POST /v1/transactions/{id}/signatures\` |
| \`awaiting_funds\` | Dépôt des fonds | Acheteur (virement), banque (webhook) | \`POST /v1/webhooks/bank/incoming-transfer\` |
| \`to_ship\` | Expédition | Vendeur | \`POST /v1/transactions/{id}/shipments\` |
| \`to_lab\`, \`at_lab\`, \`lab_passed\` | Laboratoire | Laboratoire | \`…/reception\`, \`…/certificate\`, \`…/reshipment\` |
| \`lab_failed\` | Verdict défavorable | Vendeur | \`POST /v1/transactions/{id}/counter-inspection\` |
| \`to_buyer\` | Livraison | Transporteur (webhook) | \`POST /v1/webhooks/carrier\` |
| \`inspection\` | Inspection | Acheteur | \`POST /v1/transactions/{id}/inspection\` |
| \`return_due\`, \`counter_inspection\` | Retour, contre-inspection | Acheteur, puis vendeur | \`…/returns\`, \`…/counter-inspection\` |
| \`dispute\` | Litige | Central.Parts | \`POST /v1/disputes/{id}/decision\` |
| \`settling\` | Ordres de paiement | Central.Parts (deux opérateurs), banque | \`…/approvals\`, \`…/transmit\`, \`POST /bank/v1/orders/{id}/execution\` |
| \`released\`, \`refunded\`, \`closed_partial\`, \`cancelled\` | Soldée | — | \`POST /v1/webhooks/bank/order-executed\` |

Les délais dépassés sont traités par \`POST /v1/jobs/deadlines\` : fonds non déposés (annulation), non-expédition (annulation et remboursement du principal), silence à l'inspection (réputé accepté), silence à la contre-inspection (retour réputé accepté).
`;

writeFileSync(join(ROOT, 'api/endpoints.md'), md);
console.log('api/endpoints.md');
