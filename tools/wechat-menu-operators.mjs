// Menu anglais des opérateurs du compte de service WeChat, par étiquette d'abonné (个性化菜单, règle tag_id).
// Les opérateurs (étiquette « operators ») voient supabase/wechat/menu-operators.json ; tous les autres gardent le
// menu par défaut, en chinois (supabase/wechat/menu.json, inchangé). WeChat ne permet plus un menu selon la langue.
//
// À lancer depuis le Terminal, à la racine du dépôt, APRÈS le déploiement de wechat-events qui gère les boutons
// OP_PENDING et OP_HELP. Rien n'est envoyé à WeChat sans --apply.
//
//   node tools/wechat-menu-operators.mjs                     # vérifie le menu et affiche ce qui serait fait
//   read -s WECHAT_SECRET; export WECHAT_SECRET
//   node tools/wechat-menu-operators.mjs --openids /chemin/operators.txt --apply
//   unset WECHAT_SECRET
//
// operators.txt : un openid par ligne, résultat de « select openid from public.operators; » (éditeur SQL). Ce fichier
// ne doit pas être dans le dépôt (le garder hors du dossier, par exemple dans ~/Downloads, puis le supprimer).
// Le script : crée l'étiquette si besoin, la met aux openid de la liste et la retire aux autres, remplace le menu
// personnalisé de cette étiquette, puis vérifie avec menu/trymatch ce que voit chaque opérateur. Il n'affiche jamais
// le jeton ni un openid complet. À relancer après chaque publication de menu.json : menu/create efface les menus
// personnalisés.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const TAG_NAME = 'operators';
const APPID = process.env.WECHAT_APPID || 'wx90a9a7c046914f5e'; // AppID public (supabase/README.md) ; le secret, jamais
const API = 'https://api.weixin.qq.com';

// Limites WeChat : 3 boutons principaux (16 octets), 5 sous-boutons chacun (60 octets) ; clic : key ≤ 128 octets.
export function menuProblems(menu) {
  const out = [];
  const bytes = (s) => Buffer.byteLength(String(s || ''));
  const top = menu?.button || [];
  if (!top.length || top.length > 3) out.push('1 à 3 boutons principaux');
  for (const b of top) {
    if (!b.name || bytes(b.name) > 16) out.push(`bouton principal « ${b.name} » : 16 octets au plus`);
    const subs = b.sub_button || [];
    if (subs.length > 5) out.push(`« ${b.name} » : 5 sous-boutons au plus`);
    for (const s of subs.length ? subs : [b]) {
      if (subs.length && (!s.name || bytes(s.name) > 60)) out.push(`sous-bouton « ${s.name} » : 60 octets au plus`);
      if (s.type === 'click' && (!s.key || bytes(s.key) > 128)) out.push(`« ${s.name} » : clé de clic absente ou trop longue`);
      if (s.type === 'view' && !/^https:\/\//.test(s.url || '')) out.push(`« ${s.name} » : adresse https attendue`);
      if (!['click', 'view'].includes(s.type)) out.push(`« ${s.name} » : type click ou view attendu`);
    }
  }
  return out;
}

export function conditionalMenu(menu, tagId) {
  return { button: menu.button, matchrule: { tag_id: String(tagId) } };
}

// Openid : lettres, chiffres, tiret et souligné ; lignes vides et commentaires (#) ignorés.
export function readOpenids(text) {
  const list = String(text || '').split(/\r?\n/).map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
  const bad = list.filter((o) => !/^[A-Za-z0-9_-]{20,64}$/.test(o));
  if (bad.length) throw new Error(`${bad.length} ligne(s) ne ressemblent pas à un openid`);
  return [...new Set(list)];
}

export const mask = (openid) => String(openid).slice(0, 4) + '…' + String(openid).slice(-3);

async function call(token, path, body) {
  const r = await fetch(`${API}${path}?access_token=${encodeURIComponent(token)}`,
    body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (j.errcode && j.errcode !== 0) {
    const e = new Error(`${path} : erreur WeChat ${j.errcode} ${j.errmsg || ''}`.trim());
    e.errcode = j.errcode;
    throw e;
  }
  return j;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const fileArg = args[args.indexOf('--openids') + 1];
  const menu = JSON.parse(readFileSync(new URL('../supabase/wechat/menu-operators.json', import.meta.url), 'utf8'));
  const problems = menuProblems(menu);
  if (problems.length) throw new Error('menu-operators.json : ' + problems.join(' ; '));
  console.log('menu-operators.json : conforme aux limites WeChat.');
  if (!apply) {
    console.log('Simulation : rien n\'est envoyé. Ajouter --openids <fichier> --apply pour publier.');
    return;
  }
  if (!args.includes('--openids') || !fileArg) throw new Error('--openids <fichier> est obligatoire avec --apply');
  const openids = readOpenids(readFileSync(fileArg, 'utf8'));
  if (!openids.length) throw new Error('aucun openid dans le fichier');
  const secret = process.env.WECHAT_SECRET;
  if (!secret) throw new Error('WECHAT_SECRET absent : « read -s WECHAT_SECRET; export WECHAT_SECRET »');

  const t = await (await fetch(`${API}/cgi-bin/stable_token`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credential', appid: APPID, secret }) })).json();
  if (!t.access_token) throw new Error(`jeton refusé : ${t.errcode ?? ''} ${t.errmsg ?? ''}`);
  const token = t.access_token;

  // Le menu par défaut doit exister : les menus personnalisés s'y ajoutent.
  let current;
  try { current = await call(token, '/cgi-bin/menu/get'); } catch (e) {
    if (e.errcode === 46003) throw new Error('aucun menu par défaut : publier d\'abord supabase/wechat/menu.json');
    throw e;
  }

  // 1. Étiquette « operators ».
  const { tags = [] } = await call(token, '/cgi-bin/tags/get');
  let tag = tags.find((x) => x.name === TAG_NAME);
  if (!tag) tag = (await call(token, '/cgi-bin/tags/create', { tag: { name: TAG_NAME } })).tag;
  console.log(`Étiquette « ${TAG_NAME} » : n° ${tag.id}.`);

  // 2. Membres : exactement les openid du fichier.
  const tagged = [];
  for (let next = ''; ;) {
    const r = await call(token, '/cgi-bin/user/tag/get', { tagid: tag.id, next_openid: next });
    tagged.push(...(r.data?.openid || []));
    if (!r.next_openid || !r.count) break;
    next = r.next_openid;
  }
  const add = openids.filter((o) => !tagged.includes(o)), remove = tagged.filter((o) => !openids.includes(o));
  for (let i = 0; i < add.length; i += 50) await call(token, '/cgi-bin/tags/members/batchtagging', { openid_list: add.slice(i, i + 50), tagid: tag.id });
  for (let i = 0; i < remove.length; i += 50) await call(token, '/cgi-bin/tags/members/batchuntagging', { openid_list: remove.slice(i, i + 50), tagid: tag.id });
  console.log(`Membres : ${openids.length} opérateur(s) ; ${add.length} ajouté(s), ${remove.length} retiré(s).`);

  // 3. Menu personnalisé de l'étiquette : l'ancien est remplacé, les autres menus personnalisés ne sont pas touchés.
  for (const c of current.conditionalmenu || []) {
    if (String(c.matchrule?.tag_id) === String(tag.id)) await call(token, '/cgi-bin/menu/delconditional', { menuid: String(c.menuid) });
  }
  const { menuid } = await call(token, '/cgi-bin/menu/addconditional', conditionalMenu(menu, tag.id));
  console.log(`Menu anglais publié (menuid ${menuid}).`);

  // 4. Vérification : premier bouton vu par chaque opérateur.
  for (const o of openids) {
    const r = await call(token, '/cgi-bin/menu/trymatch', { user_id: o });
    const first = r.button?.[0]?.name;
    console.log(`${mask(o)} : ${first === menu.button[0].name ? 'menu anglais' : `menu inattendu (« ${first} »)`}`);
  }
  console.log('Fait. Le menu apparaît après quelques minutes (se désabonner puis se réabonner pour le voir tout de suite).');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('Échec : ' + e.message); process.exit(1); });
}
