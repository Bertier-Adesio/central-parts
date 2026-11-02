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
    'requests: open purchase requests (latest 10)',
    'reply 123 text: answer forwarded message #123',
    '',
    'Platform RFQs (DEM-1001):',
    'rfq: RFQs awaiting validation',
    'rfq DEM-1001: show the RFQ',
    'approve DEM-1001 (or: approve DEM-1001 only ORG-0101,ORG-0105)',
    'reject DEM-1001 reason',
    'resend DEM-1001 (or: resend DEM-1001 ORG-0101)',
    'rfq stats ORG-0101: supplier handling rate',
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

// Statuts des demandes d'achat, pour les opérateurs.
export const STATUS_EN = { submitted: 'awaiting supplier', confirmed: 'confirmed by supplier', unavailable: 'unavailable',
  proforma_sent: 'proforma sent', paid: 'paid', shipped: 'shipped', cancelled: 'cancelled' };

// Demandes « en cours » : ni expédiées, ni annulées, ni sans stock.
export const OPEN_REQUEST_STATUSES = ['submitted', 'confirmed', 'proforma_sent', 'paid'];

// Commande « requests » (bouton Review › Purchase requests) : demandes en cours, les plus récentes d'abord.
// rows : { id, status, mpn, qty, buyer_company, created_at } ; total : nombre de demandes en cours.
export function operatorRequestsText(rows, total = rows.length) {
  if (!rows.length) return 'No open purchase request.';
  const day = (d) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Europe/Paris' });
  return [
    `Open purchase requests: ${total}${total > rows.length ? ` (latest ${rows.length} shown)` : ''}`,
    ...rows.map((r) => `${r.id} · ${STATUS_EN[r.status] || r.status} · ${r.mpn} × ${r.qty} · ${r.buyer_company} · ${day(r.created_at)}`),
    '',
    `Full card: "request ${rows[0].id}"`,
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

// ---------------------------------------------------------------- route RFQ des plateformes (ADR 0023)
// Fournisseur : chinois, puis anglais. Jamais la plateforme, l'acheteur, la référence client ni le prix cible :
// les fonctions ne reçoivent que la fiche fournisseur (rfq_for_supplier), qui ne les contient pas.
// Administrateur : anglais seul.

const RFQ_SITE = 'https://central.parts/depot/';

// Heure de l'échéance, à Pékin et à Paris : « 11月5日 17:00（北京时间）· 10:00（巴黎时间）».
export function rfqDeadline(iso, lang = 'zh') {
  const d = new Date(iso);
  const fmt = (tz, locale, opts) => new Intl.DateTimeFormat(locale, { timeZone: tz, ...opts }).format(d);
  const hm = { hour: '2-digit', minute: '2-digit', hour12: false };
  // « 11月5日 » : mois et jour lus dans le fuseau, sans dépendre du format chinois du moteur.
  const md = (tz) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, month: 'numeric', day: 'numeric' })
      .formatToParts(d).map((x) => [x.type, x.value]));
    return `${Number(p.month)}月${Number(p.day)}日`;
  };
  if (lang === 'zh') {
    return `${md('Asia/Shanghai')} ${fmt('Asia/Shanghai', 'en-GB', hm)}（北京时间）· ${md('Europe/Paris')} ${fmt('Europe/Paris', 'en-GB', hm)}（巴黎时间）`;
  }
  return `${fmt('Asia/Shanghai', 'en-GB', { day: 'numeric', month: 'short' })} ${fmt('Asia/Shanghai', 'en-GB', hm)} China time · ` +
    `${fmt('Europe/Paris', 'en-GB', { day: 'numeric', month: 'short' })} ${fmt('Europe/Paris', 'en-GB', hm)} Paris time`;
}

function countryName(code, locale) {
  try { return new Intl.DisplayNames([locale], { type: 'region' }).of(code) || code; } catch { return code; }
}

// Nouvelle demande de prix. card : ref, mpn, manufacturer?, qty, dc_min?, packaging?, lead_days_max?, ship_to.
export function rfqSupplierText(card, deadlineIso) {
  const zh = [
    `【Central.Parts 新询价】${card.ref}`,
    `型号：${card.mpn}${card.manufacturer ? `（${card.manufacturer}）` : ''}  数量：${card.qty}` + (card.dc_min ? `  最低批号：${card.dc_min}` : ''),
    `送达国家：${countryName(card.ship_to, 'zh-CN')}` + (card.lead_days_max ? `  最长交期：${card.lead_days_max} 天` : '') +
      (card.packaging ? `  包装：${card.packaging}` : ''),
    `回复截止：${rfqDeadline(deadlineIso, 'zh')}`,
    `报价请回复：报价 ${card.ref} 单价 币种 交期天数 批号`,
    `例如：报价 ${card.ref} 0.52 USD 7 2425`,
    `无货请回复：无货 ${card.ref}`,
    `超过截止时间的回复无效，并计为未处理。买方信息已匿名。`,
    `详情：${RFQ_SITE}`,
  ];
  const en = [
    `[Central.Parts RFQ] ${card.ref}: ${card.mpn} × ${card.qty}` + (card.dc_min ? `, D/C ≥ ${card.dc_min}` : '') +
      `, ship to ${countryName(card.ship_to, 'en')}. Reply by ${rfqDeadline(deadlineIso, 'en')}:`,
    `"报价 ${card.ref} price currency lead_days date_code" or "无货 ${card.ref}" (no stock). Late replies are not accepted.`,
  ];
  return [...zh, '', ...en].join('\n');
}

// Rappel à 36 h, une fois.
export function rfqReminderText(card) {
  return [
    `【Central.Parts 询价提醒】${card.ref} 剩余12小时`,
    `型号：${card.mpn}  数量：${card.qty}`,
    `回复截止：${rfqDeadline(card.deadline_at, 'zh')}`,
    `报价 ${card.ref} 单价 币种 交期天数 批号 · 无货 ${card.ref}`,
    '',
    `[Central.Parts] Reminder: 12 hours left to answer ${card.ref}.`,
  ].join('\n');
}

export function rfqCancelledText(ref) {
  return `【Central.Parts】询价 ${ref} 已取消，无需回复。\nRFQ ${ref} has been cancelled: no reply needed.`;
}

// Réponse enregistrée.
export function rfqQuoteOkText(r, q) {
  return `已收到报价 ${r.ref}：${q.price} ${q.currency}，交期 ${q.lead} 天${q.dateCode ? `，批号 ${q.dateCode}` : ''}。截止后 Central.Parts 将通知结果。\n` +
    `Quote received for ${r.ref}: ${q.price} ${q.currency}, ${q.lead} days${q.dateCode ? `, D/C ${q.dateCode}` : ''}.`;
}
export function rfqDeclineOkText(ref) {
  return `已记录：${ref} 无货。感谢回复。\nRecorded: no stock for ${ref}. Thank you.`;
}

// Refus d'une réponse : le code vient de la base (supplier_rfq_answer) ; field précise une donnée invalide.
export function rfqAnswerErrorText(ref, code, field) {
  if (code === 'CP410') return `${ref} 已过回复截止时间，报价未被接受。\nThe deadline for ${ref} has passed: reply not accepted.`;
  if (code === 'CP409') {
    return /quoted|declined/.test(field || '')
      ? `您已回复过 ${ref}，每家公司只能回复一次。\nYou have already answered ${ref}.`
      : `询价 ${ref} 已结束。\nRFQ ${ref} is closed.`;
  }
  if (code === '22023') {
    const zh = { currency: '币种无效，可用 EUR、USD、CNH、HKD、GBP、JPY', price: '单价无效', lead: '交期无效',
      date_code: '请提供批号（D/C），例如：报价 ' + ref + ' 0.52 USD 7 2425', lot: '批次（LOT）不属于该型号' }[field] || '格式错误';
    const en = { currency: 'currency not accepted (EUR, USD, CNH, HKD, GBP, JPY)', price: 'invalid price', lead: 'invalid lead time',
      date_code: 'please give the date code', lot: 'this LOT does not match the part number' }[field] || 'invalid format';
    return `${zh}。\n${ref}: ${en}.`;
  }
  return `未找到询价 ${ref}。\nRFQ ${ref} not found.`;
}

export function rfqHelpText(ref) {
  return `报价格式：报价 ${ref} 单价 币种 交期天数 批号\n例如：报价 ${ref} 0.52 USD 7 2425\n无货：无货 ${ref}\n` +
    `Format: 报价 ${ref} price currency lead_days date_code`;
}

// ---- administrateur (anglais)

const RFQ_STATUS_EN = { pending_validation: 'pending validation', rejected: 'rejected', auction: 'open (suppliers notified)',
  offers: 'offers ready', no_offer: 'no offer', ordered: 'ordered', cancelled: 'cancelled' };

// Fiche d'une demande (rfq_for_operator).
export function rfqOperatorCard(c, title = 'RFQ') {
  const lines = [
    `[${title} ${c.id}] ${RFQ_STATUS_EN[c.status] || c.status}${c.sandbox ? ' · SANDBOX' : ''}`,
    `Client: ${c.client || '?'}${c.customer_reference ? ' · ref ' + c.customer_reference : ''}${c.rfq_id ? ' · ' + c.rfq_id : ''}`,
    `${c.mpn}${c.manufacturer ? ' (' + c.manufacturer + ')' : ''} × ${c.qty}` + (c.dc_min ? ` · D/C ≥ ${c.dc_min}` : '') +
      ` · ship to ${c.ship_to} · ${c.currency}` + (c.target_price ? ` · target ${c.target_price}` : '') +
      (c.lead_days_max ? ` · lead ≤ ${c.lead_days_max} d` : ''),
  ];
  if (c.status === 'pending_validation') {
    const n = (c.candidates || []).length;
    lines.push(n ? `Matching suppliers: ${n} (${c.candidates.join(', ')})` : 'Matching suppliers: none (approving closes it as "no offer")');
    lines.push(`Reply "approve ${c.id}", "approve ${c.id} only ORG-…" or "reject ${c.id} reason"`);
  }
  if (c.rejected_reason) lines.push(`Reason: ${c.rejected_reason}`);
  for (const s of c.sellers || []) {
    lines.push(`${s.org}: ${s.notify}${s.notify === 'sent' ? ' · ' + s.response : ''}${s.error ? ' · ' + s.error : ''}`);
  }
  if (c.bids) lines.push(`Quotes received: ${c.bids}`);
  return lines.join('\n');
}

export function rfqOperatorListText(list) {
  if (!list.length) return 'No RFQ awaiting validation.';
  return [`RFQs awaiting validation: ${list.length}`,
    ...list.slice(0, 10).map((c) => `${c.id} · ${c.mpn} × ${c.qty} · ${c.client || '?'} · ${(c.candidates || []).length} match`),
    '', `Card: "rfq ${list[0].id}"`].join('\n');
}

// Résultat de la diffusion après validation ou renvoi.
export function rfqDispatchText(ref, r) {
  if (r.closed) {
    return `${ref}: broadcast closed (RFQ_WECHAT_OPEN is not true). Nothing was sent to suppliers. ` +
      `Once it is opened, send "resend ${ref}".`;
  }
  const parts = [`${ref}: ${r.sandbox ? 'sandbox, simulated' : 'sent'} to ${r.sent.length} supplier(s)` + (r.sent.length ? ` (${r.sent.join(', ')})` : '')];
  if (r.failed.length) {
    parts.push(`Not delivered: ${r.failed.join(', ')} (WeChat only delivers free text to contacts active in the last ` +
      `${48} hours). Their 48-hour deadline has not started. Ask them to write to the account, then "resend ${ref} ORG-…".`);
  }
  return parts.join('\n');
}

export function rfqStatsText(s) {
  if (!s || !s.received) return `${s?.org || '?'}: no RFQ received yet.`;
  return [`${s.org}: ${s.received} RFQ received · ${s.quoted} quoted · ${s.declined} no stock · ${s.expired} expired (not handled)`,
    `Handling rate ${Math.round((s.treatment_rate || 0) * 100)} %` + (s.median_response_minutes != null ? ` · median reply ${s.median_response_minutes} min` : '') +
      (s.counts_for_ranking ? '' : ' · below 10 RFQs: no effect on ranking'),
    s.expired_demands?.length ? `Expired: ${s.expired_demands.slice(0, 10).join(', ')}` : ''].filter(Boolean).join('\n');
}

// Complétude des fiches produit d'un fournisseur (supplier_data_quality), pour « rfq stats ORG-… ».
export function rfqDataQualityLine(q) {
  if (!q || !q.lots) return '';
  const r = q.rates || {}, pc = (k) => Math.round((r[k] || 0) * 100) + ' %';
  return `\nProduct data ${Math.round((q.completeness || 0) * 100)} % on ${q.lots} lot(s): manufacturer ${pc('manufacturer')}, description ${pc('description')}, ` +
    `datasheet ${pc('datasheet')}, case ${pc('package_case')}, lifecycle ${pc('lifecycle')}, ECCN ${pc('eccn')}, HTS ${pc('hts_code')} (not used for ranking yet)`;
}

export function rfqClosedText(r) {
  return r.status === 'offers'
    ? `[RFQ ${r.id}] closed: ${r.offers} offer(s) sent to the platform.` + (r.no_margin ? ` ${r.no_margin} quote(s) skipped: no margin set for the supplier.` : '')
    : `[RFQ ${r.id}] closed with no offer.` + (r.no_margin ? ` ${r.no_margin} quote(s) skipped: no margin set for the supplier.` : '');
}
