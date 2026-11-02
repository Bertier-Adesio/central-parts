// Textes du robot WeChat (fonctions « wechat-events » et « admin »), une seule source ; testés par tools/test-import.mjs.
//
// Règle de langue :
//   - destinataire opérateur (table operators) : anglais seul, aucun caractère chinois ;
//   - destinataire fournisseur ou inconnu : chinois, avec l'anglais (textes chinois inchangés).
// Chaque fonction qui dépend du destinataire prend `operator` (booléen) ; par défaut, la version fournisseur.
// Les fiches et avis destinés aux seuls opérateurs (supplierCard, requestAnswerNote, [Message #n]…) sont déjà en
// anglais et restent dans wechat.ts et wechat-events.

const SITE = 'https://central.parts/depot/';

// Réponse au scan du QR code de connexion affiché sur la page de dépôt (scène dl_…).
const SCAN = {
  ok: {
    both: '已登录 Central.Parts 库存上传，请返回上传页面。\nLogged in to Central.Parts stock upload: go back to the upload page.',
    en: 'Logged in to Central.Parts stock upload: go back to the upload page.',
  },
  not_bound: {
    both: '已登录。请返回网页，注册您的公司。\nLogged in: go back to the web page to register your company.',
    en: 'Logged in: go back to the web page to register your company.',
  },
  invite_invalid: {
    both: '邀请链接无效、已过期或已被其他账号使用，请联系 Central.Parts。\nThe invitation link is invalid, expired or already used: please contact Central.Parts.',
    en: 'The invitation link is invalid, expired or already used.',
  },
  expired: {
    both: '二维码已过期，请在上传页面刷新二维码。\nThis QR code has expired: refresh it on the upload page.',
    en: 'This QR code has expired: refresh it on the upload page.',
  },
};
export function scanReply(status, operator = false) {
  const t = SCAN[status];
  return t ? (operator ? t.en : t.both) : null;
}

// Ligne ajoutée à la réponse au scan : sur téléphone, un lien personnel ramène à la page, déjà connecté.
export function phoneBackLine(url, operator = false) {
  return (operator ? '\n\nOn a phone, tap to go back:\n' : '\n\n手机上请点此返回 · On a phone, tap to go back:\n') + url;
}

// Bouton « 供应商 › 上传库存 » du menu : lien de connexion personnel au centre fournisseurs.
export function depotLinkText(url, operator = false) {
  if (operator) {
    return [
      'Log in to the Central.Parts supplier centre (valid 15 minutes):', url, '',
      'If the link has expired, tap the menu again or send "link".',
    ].join('\n');
  }
  return [
    '点此登录 Central.Parts 供应商中心（15 分钟内有效）：', url, '',
    '尚未注册的公司可在页面上注册。链接过期后，请再次点击菜单「供应商」→「上传库存」。', '',
    'Tap to log in to the Central.Parts supplier centre (valid 15 minutes). Companies not yet registered can register on the page. If the link has expired, tap the menu again.',
  ].join('\n');
}

export function linkErrorText(operator = false) {
  return operator
    ? 'The login link could not be created, please try again later.'
    : '暂时无法生成登录链接，请稍后再试。\nThe login link could not be created, please try again later.';
}

// Message d'accueil (abonnement, scan d'un QR code du compte, message d'un inconnu ; 2 048 octets au plus).
// Sans lien (scene vide : la création du lien a échoué), la ligne 1 garde son texte, sans adresse.
export function welcomeText(scene, operator = false) {
  const link = scene ? `${SITE}?login=${scene}` : SITE;
  if (operator) {
    return [
      'Central.Parts operator account.',
      '',
      `1. Supplier centre login (valid 15 minutes; send "link" for a new one): ${link}`,
      '2. Stock template: https://central.parts/depot/stock-template.csv',
      '3. Send "help" for the operator commands.',
    ].join('\n');
  }
  return [
    '感谢关注 Central.Parts！',
    '我们为中国原厂、分销商和贸易商拓展欧洲客户：欧洲 EMS、OEM 和设计公司直接查询您的现货。',
    '',
    `1. 注册公司、上传库存（15 分钟内有效，过期请发送任意消息获取新链接）：${link}`,
    '2. 库存表模板：https://central.parts/depot/stock-template.csv',
    '3. 了解我们：https://central.parts/zh/',
    '',
    'electronica 2026 · 慕尼黑 · 11月10–13日 · B4 馆 251/12 展位，欢迎来访。',
    '',
    'Thank you for following Central.Parts. Link 1 registers your company and uploads your stock (valid 15 minutes). Meet us at electronica 2026, Hall B4, Booth 251/12.',
  ].join('\n');
}

// Accusé de réception d'un message (texte, image, voix) d'un contact rattaché à une société.
export function receivedText(operator = false) {
  return operator
    ? 'Message received and forwarded to the operators.'
    : '已收到您的消息，我们会尽快回复。\nMessage received, we will reply shortly.';
}

// Aide des commandes, pour les opérateurs seulement : anglais. Les mots-clés chinois restent acceptés.
export function operatorHelpText() {
  return [
    'Commands:',
    'pending: companies awaiting review',
    'approve ORG-0123',
    'reject ORG-0123 reason',
    'link: your login link to the supplier centre',
    'reply 123 text: answer forwarded message #123',
    '',
    'Purchase requests (PR-0001):',
    'request PR-0001: show the request',
    'confirm PR-0001',
    'unavailable PR-0001',
    'proforma PR-0001',
    'paid PR-0001',
    'shipped PR-0001',
    'cancel PR-0001',
  ].join('\n');
}

// Erreur d'une commande approve / reject (le message vient de la base).
export function operatorErrorText(subject, message) {
  return `${subject}: ${message}`;
}

// ---------------------------------------------------------------- messages envoyés aux fournisseurs par une
// décision ou une réponse d'opérateur : chinois et anglais. Le texte chinois d'origine est inchangé.

export function approvedNotice(alias) {
  return `您的公司已通过 Central.Parts 审核（编号 ${alias}），库存已纳入 Central.Parts 平台。\nYour company has been approved by Central.Parts (${alias}).`;
}

// Refus : ligne anglaise ajoutée ; le motif, écrit une fois par l'opérateur, n'est pas répété.
export function rejectedNotice(reason) {
  return `您的公司未通过 Central.Parts 审核${reason ? '：' + reason : '。'}\n如有疑问，请直接回复此消息。\n` +
    `Your company has not been approved by Central.Parts${reason ? ' (reason above)' : ''}. If you have any question, reply to this message.`;
}

// Réponse d'un opérateur à un message transféré (« reply 123 texte ») : en-tête bilingue, puis le texte tel quel.
export function operatorReplyText(text) {
  return `Central.Parts 回复 · Reply from Central.Parts:\n${text}`;
}
