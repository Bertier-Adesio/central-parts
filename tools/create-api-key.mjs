// Crée une clé d'API de plateforme (route RFQ, ADR 0023) SANS rien écrire nulle part : affiche la clé, une seule fois,
// et le SQL à coller dans le SQL Editor de Supabase (empreinte sha256 seulement : la clé n'est jamais en base).
// À lancer sur le poste de Bertier ; ne jamais coller la clé dans le dépôt, un ticket ou une conversation.
//
// Usage :
//   node tools/create-api-key.mjs --org ORG-0150 --env test          clé de bac à sable (cp_test_…)
//   node tools/create-api-key.mjs --org ORG-0150 --env live          clé de production (cp_live_…)
//   node tools/create-api-key.mjs --new-org "Adesio" --env test      SQL de création de l'organisation, puis de la clé
// Options : --label "texte" ; --read-only (sans la portée demands:write : lecture seule) ;
//   --calls-per-minute 300 (limite propre à la clé, 60 par défaut ; un connecteur « une référence par appel » en a besoin).
import { createHash, randomInt } from 'node:crypto';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : null; };
const env = opt('env');
const org = opt('org');
const newOrg = opt('new-org');
if (!['test', 'live'].includes(env) || (!org && !newOrg) || (org && !/^[A-Z0-9-]{2,32}$/.test(org))) {
  console.error('Usage : node tools/create-api-key.mjs (--org ORG-0150 | --new-org "Nom") --env test|live [--label …] [--read-only]');
  process.exit(1);
}
const sql = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const secret = Array.from({ length: 32 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
const key = `cp_${env}_${secret}`;
const hash = createHash('sha256').update(key).digest('hex');
const scopes = args.includes('--read-only') ? '{}' : '{demands:write}';
const label = opt('label') || (env === 'test' ? 'Bac à sable' : 'Production');
const cpm = opt('calls-per-minute');
if (cpm && !/^\d{1,4}$/.test(cpm)) { console.error('--calls-per-minute : entier de 1 à 6000'); process.exit(1); }

const orgExpr = org ? sql(org) : "(select id from new_org)";
const lines = ['-- À coller dans le SQL Editor de Supabase (projet de production). Ne contient que l\'empreinte de la clé.'];
if (newOrg) {
  lines.push('with new_org as (',
    `  insert into public.organizations (type, name, alias, country, currency, lang, kyb)`,
    `  values ('buyer', ${sql(newOrg)}, ${sql('P-' + newOrg.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12))}, 'FR', 'EUR', 'fr', 'validated')`,
    '  returning id)');
}
lines.push(`insert into public.api_keys (org_id, environment, prefix, key_hash, label, scopes${cpm ? ', calls_per_minute' : ''})`,
  `select ${orgExpr}, ${sql(env === 'test' ? 'sandbox' : 'live')}, ${sql(key.slice(0, 12))}, ${sql(hash)}, ${sql(label)}, ${sql(scopes)}${cpm ? ', ' + Number(cpm) : ''}` +
  (newOrg ? ' from new_org' : '') + `\nreturning id, org_id, environment, prefix;`);

console.log(lines.join('\n'));
console.log('\n-- Clé à transmettre à la plateforme par un canal sûr (affichée une seule fois, introuvable ensuite) :');
console.log('-- ' + key);
