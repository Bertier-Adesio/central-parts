#!/usr/bin/env node
// Génère la landing statique (site/index.html, site/en/index.html, site/zh/index.html)
// à partir de la maquette design/landing.dc.html, sans runtime : tous les textes
// sont écrits dans le HTML, les listes sont dépliées, les interactions passent
// par un petit script vanilla en fin de page.
//
// Usage : node tools/build-site.mjs   (aucune dépendance)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'design/landing.dc.html');
const OUT = join(ROOT, 'site');
const ORIGIN = 'https://central.parts';
const CONTACT_EMAIL = 'contact@central.parts';

const LANGS = {
  fr: {
    path: '/', htmlLang: 'fr', hreflang: 'fr', ogLocale: 'fr_FR', ogImage: 'social-preview-fr.png',
    headline: 'Composants électroniques, distributeurs autorisés',
    description: 'Recherche, cotation et achat de composants électroniques auprès de distributeurs autorisés. Europe, Amériques, Chine.',
    partner: 'Logo distributeur ', mailSubject: 'Demande de contact', mailProfile: 'Profil',
  },
  en: {
    path: '/en/', htmlLang: 'en', hreflang: 'en', ogLocale: 'en_GB', ogImage: 'social-preview-en.png',
    headline: 'Electronic components, authorised distributors',
    description: 'Search, quote and buy electronic components from authorised distributors. Europe, the Americas, China.',
    partner: 'Distributor logo ', mailSubject: 'Contact request', mailProfile: 'Profile',
  },
  zh: {
    path: '/zh/', htmlLang: 'zh-Hans', hreflang: 'zh-Hans', ogLocale: 'zh_CN', ogImage: 'social-preview-en.png',
    headline: '电子元器件，授权分销商',
    description: '从授权分销商搜索、询价并采购电子元器件。覆盖欧洲、美洲与中国。',
    partner: '分销商标志 ', mailSubject: '联系请求', mailProfile: '身份',
  },
};

// ---------------------------------------------------------------- source
const src = readFileSync(SRC, 'utf8');
const between = (s, a, b) => {
  const i = s.indexOf(a); const j = s.indexOf(b, i + a.length);
  if (i < 0 || j < 0) throw new Error(`Bloc introuvable : ${a} … ${b}`);
  return s.slice(i + a.length, j);
};
const head = between(src, '<head>', '</head>');
const xdc = between(src, '<x-dc>', '</x-dc>');
const helmet = between(xdc, '<helmet>', '</helmet>');
let body = xdc.slice(xdc.indexOf('</helmet>') + '</helmet>'.length).trim();
const logic = between(src, '<script type="text/x-dc" data-dc-script="">', '</script>');

// Traductions et styles des pastilles / onglets, repris tels quels de la maquette.
const T = new Function(`${logic.slice(0, logic.indexOf('class Component'))}; return T;`)();
const grab = (name) => {
  const m = logic.match(new RegExp(`const ${name} = (\\(on\\) => \\(\\{[^\\n]*\\}\\));`));
  if (!m) throw new Error(`${name} introuvable dans la maquette`);
  return new Function(`return ${m[1]}`)();
};
const pill = grab('pill');
const tabStyle = grab('tabStyle');

// Styles : blocs <style> du <head> puis du <helmet>, sans doublon, chemins absolus.
const styles = [...new Set([...head.matchAll(/<style>[\s\S]*?<\/style>/g), ...helmet.matchAll(/<style>[\s\S]*?<\/style>/g)].map((m) => m[0]))]
  .join('\n').replaceAll('url("assets/', 'url("/assets/');

// ------------------------------------------------- réécritures ciblées
// Chaque motif doit apparaître exactement le nombre de fois attendu : si la
// maquette change, le script s'arrête au lieu de produire une page fausse.
function rewrite(from, to, count = 1) {
  const n = body.split(from).length - 1;
  if (n !== count) throw new Error(`Motif trouvé ${n} fois au lieu de ${count} :\n${from}`);
  body = body.replaceAll(from, to);
}

// Sélecteur de langue : liens /, /en/, /zh/.
rewrite('<button sc-camel-on-click="{{ l.pick }}" style="{{ l.style }}">{{ l.label }}</button>',
  '<a href="{{ l.href }}" hreflang="{{ l.hreflang }}" lang="{{ l.hreflang }}" aria-current="{{ l.current }}" style="display: inline-flex; align-items: center; text-decoration: none; {{ l.style }}">{{ l.label }}</a>');

// Recherche : formulaire GET ?mpn=, exemples cliquables, note de démonstration sans lien plateforme.
rewrite('<form data-search="1" sc-camel-on-submit="{{ onSearch }}" style=', '<form data-search="1" role="search" action="#top" method="get" style=');
rewrite('<input value="{{ q }}" sc-camel-on-change="{{ onQ }}" ', '<input id="q" name="mpn" type="text" enterkeyhint="search" autocomplete="off" ');
rewrite('<button sc-camel-on-click="{{ ex.pick }}" style=', '<button type="button" data-mpn="{{ ex.label }}" style=');
body = body.replace(/<sc-if value="\{\{ searched \}\}"[^>]*>\s*<p style="([^"]*)">\{\{ t\.searchNote \}\}[\s\S]*?<\/p>\s*<\/sc-if>/, (m, st) => {
  if (!m) throw new Error('note de recherche introuvable');
  return `<p id="search-note" role="status" hidden style="${st}">{{ t.searchNote }}</p>`;
});
if (body.includes('ui_kits/')) throw new Error('Lien plateforme encore présent');

// CTA acheteur : ramène au champ de recherche (focus via le script).
rewrite('<a href="#top" style="margin-top: auto;', '<a href="#q" data-focus-search="1" style="margin-top: auto;');
// CTA distributeur : ouvre le formulaire sur l'onglet Distributeur.
rewrite('<a href="#contact" sc-camel-on-click="{{ toDist }}" style=', '<a href="#contact" data-pick-tab="dist" style=');

// FAQ : <details>/<summary>, la première question ouverte comme dans la maquette.
body = body.replace(/<sc-for list="\{\{ faq \}\}"[\s\S]*?<\/sc-for>/, () =>
  `<sc-for list="{{ faq }}" as="f">
<details data-open="{{ f.open }}" style="border-bottom: 1px solid #D9D5CD">
<summary style="display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 20px 0; list-style: none; font-size: 16px; font-weight: 500; color: #15171C; cursor: pointer">{{ f.q }}<span class="faq-sign" aria-hidden="true" style="font-family: 'IBM Plex Mono', monospace; font-size: 18px; color: #6B7079; flex: none"></span></summary>
<p style="margin: 0 0 20px; max-width: 640px; font-size: 15px; line-height: 1.55; color: #4A4E57; text-wrap: pretty">{{ f.a }}</p>
</details>
</sc-for>`);

// Contact : mailto en attendant un endpoint ; onglets Acheteur / Distributeur.
rewrite('<form sc-camel-on-submit="{{ onSend }}" style=', `<form id="contact-form" action="mailto:${CONTACT_EMAIL}" method="post" enctype="text/plain" style=`);
rewrite('<button type="button" sc-camel-on-click="{{ tb.pick }}" style="{{ tb.style }}">{{ tb.label }}</button>',
  '<button type="button" data-tab="{{ tb.key }}" aria-pressed="{{ tb.on }}" data-style-on="{{ tb.styleOn }}" data-style-off="{{ tb.styleOff }}" style="{{ tb.style }}">{{ tb.label }}</button>');
rewrite('{{ t.fName }}<input required=""', '{{ t.fName }}<input name="nom" autocomplete="name" required=""');
rewrite('{{ t.fCompany }}<input required=""', '{{ t.fCompany }}<input name="societe" autocomplete="organization" required=""');
rewrite('{{ t.fEmail }}<input type="email" required=""', '{{ t.fEmail }}<input name="email" type="email" autocomplete="email" required=""');
rewrite('{{ msgLabel }}<textarea rows="4"', '<span id="msg-label" data-buyer="{{ t.fMsgBuyer }}" data-dist="{{ t.fMsgDist }}">{{ t.fMsgBuyer }}</span><textarea name="message" rows="4"');
rewrite('<sc-if value="{{ sent }}" hint-placeholder-val="{{ false }}">\n<div role="status" style=', '<input type="hidden" name="profil" value="{{ t.tabBuyer }}">\n<div id="contact-sent" role="status" hidden style=');
body = body.replace(/(<div id="contact-sent"[\s\S]*?<\/div>)\s*<\/sc-if>/, '$1');

// Pied de page : signature sur trois lignes.
rewrite('<span style="display: flex; flex-direction: column; gap: 2px; font-family: \'IBM Plex Mono\', monospace; font-size: 9px; line-height: 1.2; letter-spacing: 0.22em; text-transform: uppercase"><span>Supply</span><span>Network</span><span>Operator</span></span>',
  '<span style="display: block; font-family: \'IBM Plex Mono\', monospace; font-size: 9px; line-height: 1.4; letter-spacing: 0.22em; text-transform: uppercase">Supply<br>Network<br>Operator</span>');

// ------------------------------------------------------- mini-moteur
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const UNITLESS = new Set(['fontWeight', 'lineHeight', 'opacity', 'zIndex', 'flex', 'flexGrow', 'flexShrink', 'order']);
const css = (o) => Object.entries(o).map(([k, v]) =>
  `${k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}: ${typeof v === 'number' && !UNITLESS.has(k) && v !== 0 ? v + 'px' : v}`).join('; ');
const get = (ctx, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), ctx);
const val = (ctx, path) => {
  const v = get(ctx, path);
  if (v === undefined) throw new Error(`Valeur manquante : {{ ${path} }}`);
  return v && typeof v === 'object' ? css(v) : v;
};

function render(tpl, ctx) {
  tpl = tpl.replace(/<sc-for list="\{\{ ([\w.]+) \}\}" as="(\w+)"[^>]*>([\s\S]*?)<\/sc-for>/g, (_, list, as, inner) =>
    get(ctx, list).map((item) => render(inner, { ...ctx, [as]: item })).join(''));
  tpl = tpl.replace(/<sc-if value="\{\{ ([\w.]+) \}\}"[^>]*>([\s\S]*?)<\/sc-if>/g, (_, cond, inner) => (get(ctx, cond) ? render(inner, ctx) : ''));
  return tpl.replace(/\{\{ ([\w.]+) \}\}/g, (_, p) => esc(val(ctx, p)));
}

// style-hover / style-focus → classes CSS (les styles inline restent identiques).
function hoverClasses(html) {
  const rules = new Map();
  const cls = (kind, decl) => {
    if (!rules.has(kind + decl)) rules.set(kind + decl, { name: `${kind === 'hover' ? 'hv' : 'fc'}${rules.size + 1}`, kind, decl });
    return rules.get(kind + decl).name;
  };
  html = html.replace(/<[a-z]+\b[^>]*\sstyle-(?:hover|focus)="[^"]*"[^>]*>/g, (tag) => {
    const names = [];
    tag = tag.replace(/\sstyle-(hover|focus)="([^"]*)"/g, (_, kind, decl) => { names.push(cls(kind, decl)); return ''; });
    return tag.replace(/>$/, ` class="${names.join(' ')}">`);
  });
  const sheet = [...rules.values()].map(({ name, kind, decl }) => {
    const important = decl.split(';').map((d) => d.trim()).filter(Boolean).map((d) => `${d} !important`).join('; ');
    return kind === 'hover' ? `.${name}:hover { ${important} }` : `.${name}:focus, .${name}:focus-within { ${important} }`;
  }).join('\n');
  return { html, sheet };
}

// ---------------------------------------------------------- pages
const SCRIPT = `<script>
(function () {
  var q = document.getElementById('q');
  var note = document.getElementById('search-note');
  var search = document.querySelector('[data-search]');
  function focusSearch() { q.focus(); q.scrollIntoView({ block: 'center' }); }
  // Recherche de démonstration : pas encore de plateforme en production.
  search.addEventListener('submit', function (e) { e.preventDefault(); note.hidden = !q.value.trim(); });
  q.addEventListener('input', function () { note.hidden = true; });
  document.querySelectorAll('[data-mpn]').forEach(function (b) {
    b.addEventListener('click', function () { q.value = b.getAttribute('data-mpn'); note.hidden = true; q.focus(); });
  });
  document.querySelectorAll('[data-focus-search]').forEach(function (a) {
    a.addEventListener('click', function (e) { e.preventDefault(); focusSearch(); });
  });
  if (location.hash === '#q') focusSearch();

  // Contact : onglets Acheteur / Distributeur, puis envoi par e-mail.
  var form = document.getElementById('contact-form');
  var sent = document.getElementById('contact-sent');
  var label = document.getElementById('msg-label');
  var tab = 'buyer';
  function pick(k) {
    tab = k;
    form.querySelectorAll('[data-tab]').forEach(function (b) {
      var on = b.getAttribute('data-tab') === k;
      b.setAttribute('aria-pressed', on);
      b.setAttribute('style', b.getAttribute(on ? 'data-style-on' : 'data-style-off'));
      if (on) form.elements.profil.value = b.textContent;
    });
    label.textContent = label.getAttribute(k === 'dist' ? 'data-dist' : 'data-buyer');
    sent.hidden = true;
  }
  form.querySelectorAll('[data-tab]').forEach(function (b) { b.addEventListener('click', function () { pick(b.getAttribute('data-tab')); }); });
  document.querySelectorAll('[data-pick-tab]').forEach(function (a) { a.addEventListener('click', function () { pick(a.getAttribute('data-pick-tab')); }); });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var f = form.elements;
    var lines = [label.textContent + ' :', f.message.value, '', f.nom.value, f.societe.value, f.email.value, MAIL.profile + ' : ' + f.profil.value];
    location.href = 'mailto:${CONTACT_EMAIL}?subject=' + encodeURIComponent(MAIL.subject + ' — ' + f.societe.value) + '&body=' + encodeURIComponent(lines.join('\\n'));
    sent.hidden = false;
  });
})();
</script>`;

function page(lang) {
  const L = LANGS[lang];
  const t = T[lang];
  const ctx = {
    t, htmlLang: L.htmlLang,
    langs: Object.entries(LANGS).map(([k, o]) => ({ label: { fr: 'FR', en: 'EN', zh: '中文' }[k], href: o.path, hreflang: o.hreflang, current: k === lang ? 'page' : 'false', style: pill(k === lang) })),
    examples: ['STM32F103C8T6', 'LM358DR', 'ATMEGA328P-AU', 'GRM188R71H104KA93D'].map((label) => ({ label })),
    partners: Array.from({ length: 8 }, (_, i) => L.partner + String(i + 1).padStart(2, '0')),
    faq: t.faq.map((f, i) => ({ ...f, open: i === 0 ? 'open' : '' })),
    tabs: [['buyer', t.tabBuyer], ['dist', t.tabDist]].map(([key, label]) => ({ key, label, on: String(key === 'buyer'), style: tabStyle(key === 'buyer'), styleOn: tabStyle(true), styleOff: tabStyle(false) })),
  };
  let html = render(body, ctx)
    .replace(/<details data-open="open"/g, '<details open').replace(/<details data-open=""/g, '<details')
    .replace(/ sc-camel-view-box=/g, ' viewBox=')
    .replace(/ hint-placeholder-[\w-]+="[^"]*"/g, '');
  const hv = hoverClasses(html);
  html = hv.html;
  for (const bad of ['{{', 'sc-for', 'sc-if', 'sc-camel', 'x-dc', 'helmet', 'style-hover', 'style-focus']) {
    if (html.includes(bad)) throw new Error(`« ${bad} » reste dans la page ${lang}`);
  }

  // Titre de page : l'accroche d'abord, la marque ensuite (si un moteur tronque,
  // il coupe la marque). Les aperçus sociaux n'affichent que l'accroche :
  // la marque y figure déjà via og:site_name, et le titre reste sous 60 caractères.
  const title = `${L.headline} — Central.Parts`;
  const url = ORIGIN + L.path;
  const alt = Object.values(LANGS).map((o) => `<link rel="alternate" hreflang="${o.hreflang}" href="${ORIGIN + o.path}">`).join('\n')
    + `\n<link rel="alternate" hreflang="x-default" href="${ORIGIN}/">`;
  const img = `${ORIGIN}/${L.ogImage}`;
  const og = [
    ['og:type', 'website'], ['og:site_name', 'Central.Parts'], ['og:url', url], ['og:title', L.headline], ['og:description', L.description],
    ['og:image', img], ['og:image:width', '1200'], ['og:image:height', '630'], ['og:image:alt', title], ['og:locale', L.ogLocale],
    ...Object.entries(LANGS).filter(([k]) => k !== lang).map(([, o]) => ['og:locale:alternate', o.ogLocale]),
  ].map(([p, c]) => `<meta property="${p}" content="${esc(c)}">`).join('\n');
  const tw = [['twitter:card', 'summary_large_image'], ['twitter:title', L.headline], ['twitter:description', L.description], ['twitter:image', img]]
    .map(([n, c]) => `<meta name="${n}" content="${esc(c)}">`).join('\n');
  const mail = JSON.stringify({ subject: L.mailSubject, profile: L.mailProfile });

  return `<!DOCTYPE html>
<!-- Fichier généré par tools/build-site.mjs depuis design/landing.dc.html : ne pas modifier à la main. -->
<html lang="${L.htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(L.description)}">
<link rel="canonical" href="${url}">
${alt}
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
${og}
${tw}
${styles}
<style>
[hidden] { display: none !important; }
summary::-webkit-details-marker { display: none; }
.faq-sign::before { content: '+'; }
details[open] .faq-sign::before { content: '\\2212'; }
${hv.sheet}
</style>
</head>
<body>
${html}
${SCRIPT.replace('(function () {', `(function () {\n  var MAIL = ${mail};`)}
</body>
</html>
`;
}

for (const lang of Object.keys(LANGS)) {
  const file = join(OUT, LANGS[lang].path, 'index.html');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, page(lang));
  console.log(`${file.replace(ROOT + '/', '')}`);
}
