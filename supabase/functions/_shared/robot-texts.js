// Textes du robot WeChat (fonctions « wechat-events » et « admin »), une seule source ; testés par tools/test-import.mjs.
//
// Règle de langue :
//   - destinataire opérateur (table operators) : anglais seul, aucun caractère chinois ;
//   - destinataire fournisseur ou inconnu : chinois, avec l'anglais (textes chinois inchangés).
// Chaque fonction qui dépend du destinataire prend `operator` (booléen) ; par défaut, la version fournisseur.
// Les fiches et avis destinés aux seuls opérateurs (supplierCard, requestAnswerNote, [Message #n]…) sont déjà en
// anglais et restent dans wechat.ts et wechat-events.

const SITE = 'https://central.parts/depot/';
const HELP = 'https://central.parts/depot/aide/';

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
    `2. 使用帮助与模板：${HELP}`,
    '3. 了解我们：https://central.parts/zh/',
    '',
    'electronica 2026 · 慕尼黑 · 11月10–13日 · B4 馆 251/12 展位，欢迎来访。',
    '',
    `Thank you for following Central.Parts. Link 1 registers your company and uploads your stock (valid 15 minutes). Help and templates: ${HELP}. Meet us at electronica 2026, Hall B4, Booth 251/12.`,
  ].join('\n');
}

// Demande d'aide d'un fournisseur ou d'un inconnu (« help », « 帮助 »…) : les opérateurs ont leur propre « help ».
export function isHelpRequest(text) {
  return /^\s*(help|guide|帮助|使用帮助|教程|[?？])\s*$/i.test(String(text || ''));
}

// Étapes de connexion et d'utilisation, avec le lien du guide (site/depot/aide/).
export function supplierHelpText() {
  return [
    '使用帮助',
    '1. 登录：点击菜单「供应商」→「上传库存」，再点击收到的链接（15 分钟内有效）。在电脑上：打开 central.parts/depot/，用微信扫码。',
    '2. 首次登录：注册公司（中国大陆、香港或其他），并在网页上上传营业执照。',
    '3. 上传库存表（CSV 或 Excel），并至少每 7 天重新上传一次。',
    `完整指南与模板：${HELP}`,
    '',
    'Help',
    '1. Log in: tap the menu “供应商” → “上传库存”, then the link you receive (valid 15 minutes). On a computer: open central.parts/depot/ and scan the QR code with WeChat.',
    '2. First time: register your company (Mainland China, Hong Kong or other) and upload your business licence on the page.',
    '3. Upload your stock file (CSV or Excel) at least every 7 days.',
    `Full guide and templates: ${HELP}`,
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
    'approve PR-0001: send it to the supplier',
    'reject PR-0001 reason (internal, never shown)',
    'confirm PR-0001',
    'unavailable PR-0001',
    'proforma PR-0001',
    'paid PR-0001',
    'shipped PR-0001',
    'cancel PR-0001',
  ].join('\n');
}

// Statuts des demandes d'achat, pour les opérateurs.
export const STATUS_EN = { pending_validation: 'awaiting your validation', rejected: 'rejected', submitted: 'awaiting supplier', confirmed: 'confirmed by supplier', unavailable: 'unavailable',
  proforma_sent: 'proforma sent', paid: 'paid', shipped: 'shipped', cancelled: 'cancelled' };

// Demandes « en cours » : ni refusées, ni expédiées, ni annulées, ni sans stock.
export const OPEN_REQUEST_STATUSES = ['pending_validation', 'submitted', 'confirmed', 'proforma_sent', 'paid'];

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

// Facturation et transport d'une demande (ADR 0030), pour les avis aux opérateurs.
function billingTransportLines(op) {
  const t = op.transport || {};
  return [
    ...(op.billing && op.billing !== op.delivery ? [`Billing: ${op.billing}`] : []),
    t.mode === 'own' ? `Shipping: buyer's ${t.carrier} account ${t.account} (FCA)` : `Shipping: by Central.Parts (DAP)${t.carrier ? ', preferred ' + t.carrier : ''}`,
    ...(op.ship_address ? [`Ships from: ${op.ship_address.label} · ${op.ship_address.city} ${op.ship_address.country}`] : []),
  ];
}

// Demande d'achat du site (ADR 0014, 0026) : avis aux opérateurs à l'arrivée, avant toute diffusion au fournisseur.
// op : fiche request_for_operator.
export function purchaseRequestOperatorNote(op) {
  return [
    `[Purchase request ${op.ref}] ${op.mpn} × ${op.qty} · awaiting your validation`,
    `Buyer: ${op.buyer_company} · ${op.buyer_vat}${op.vat_checked ? ' (VIES checked)' : ' (not checked)'}`,
    `${op.buyer_name} · ${op.buyer_email}${op.buyer_phone ? ' · ' + op.buyer_phone : ''}`,
    `Delivery: ${op.delivery}`,
    ...billingTransportLines(op),
    `Price ${op.unit_price ?? 'to confirm'} ${op.currency} (total ${op.total ?? 'to confirm'})`,
    `Supplier ${op.supplier}: ${op.supplier_unit_price ?? '?'} ${op.supplier_currency}, stock ${op.lot_qty}`,
    ...(op.message ? [`Message: ${op.message}`] : []),
    '',
    `Nothing is sent to the supplier before you decide: "approve ${op.ref}" or "reject ${op.ref} reason", or https://central.parts/admin/`,
  ].join('\n');
}

// Panier (ADR 0028) : un seul avis aux opérateurs, une ligne par demande ; chaque ligne se valide à part.
// cards : fiches request_for_operator des lignes ; total : total du panier (null si une ligne est à confirmer).
export function purchaseCartOperatorNote(ref, cards, total, currency) {
  const b = cards[0];
  return [
    `[Cart ${ref}] ${cards.length} line(s) · awaiting your validation`,
    `Buyer: ${b.buyer_company} · ${b.buyer_vat}${b.vat_checked ? ' (VIES checked)' : ' (not checked)'}`,
    `${b.buyer_name} · ${b.buyer_email}${b.buyer_phone ? ' · ' + b.buyer_phone : ''}`,
    `Delivery: ${b.delivery}`,
    ...billingTransportLines(b),
    ...(b.message ? [`Message: ${b.message}`] : []),
    '',
    ...cards.map((c) => `${c.ref} · ${c.mpn} × ${c.qty} · ${c.unit_price ?? 'to confirm'} ${c.currency} · ${c.supplier}: ${c.supplier_unit_price ?? '?'} ${c.supplier_currency}, stock ${c.lot_qty}`),
    `Total: ${total ?? 'to confirm'}${total != null ? ' ' + currency : ''}`,
    '',
    `Nothing is sent to the suppliers before you decide, line by line: "approve PR-…" or "reject PR-… reason", or https://central.parts/admin/`,
  ].join('\n');
}

// Demande d'achat validée : message au fournisseur (chinois), sans l'acheteur. v : supplier_view (request_for_supplier).
export function supplierRequestText(v) {
  return [
    `【新询单 ${v.ref}】`,
    `型号 ${v.mpn}，数量 ${v.qty}`,
    `您的单价 ${v.unit_price ?? '待报价'} ${v.currency}，交货国家 ${v.delivery_country}`,
    `请在 24 小时内回复「确认 ${v.ref}」或「无货 ${v.ref}」，或在 ${SITE} 处理。`,
  ].join('\n');
}

// Décision d'un opérateur sur une demande d'achat (approve / reject PR-…), réponse dans WeChat.
// d : réponse de decide_purchase_request ; notified : nombre de contacts du fournisseur prévenus (validation).
export function purchaseDecisionText(d, notified = 0) {
  if (d.status === 'rejected') return `Rejected ${d.ref}. Nothing was sent to the supplier; the buyer sees "not accepted".`;
  return `Approved ${d.ref} → ${d.supplier}: ` + (notified
    ? `${notified} WeChat contact(s) notified.`
    : 'no WeChat contact reached (48-hour rule): the request is visible in their supplier centre, follow up by hand.');
}

// Erreur d'une commande approve / reject (le message vient de la base).
export function operatorErrorText(subject, message) {
  return `${subject}: ${message}`;
}

// ---------------------------------------------------------------- messages envoyés aux fournisseurs par une
// décision ou une réponse d'opérateur : chinois et anglais. Le texte chinois d'origine est inchangé.

// Accueil d'un fournisseur approuvé : dit dès le départ que les offres se reconfirment (ADR 0025), et comment, en un
// geste. Durées par défaut de app.settings (7 jours, 14 pour un fabricant) : à mettre à jour ici si elles changent.
export function approvedNotice(alias) {
  return `您的公司已通过 Central.Parts 审核（编号 ${alias}），欢迎加入！\n` +
    '您的报价将向欧洲采购商展示。为保证库存真实，每条报价在最后一次更新后展示 7 天（制造商 14 天），到期后自动隐藏。\n' +
    '· 库存没有变化：回复「确认库存」，或在供应商中心点「库存无变化，一键确认」，所有报价立即续期。\n' +
    '· 库存有变化：在供应商中心上传新的库存表。\n' +
    '建议至少每周确认一次；库存变化快（如贸易商）可以每天上传或确认。报价越新越准确，更新频率也将计入您的供应商评分。供应商中心：https://central.parts/depot/\n\n' +
    `Your company has been approved by Central.Parts (${alias}). Welcome!\n` +
    'Your offers will be shown to European buyers. To keep stock accurate, each offer stays visible for 7 days after its last update (14 days for manufacturers), then is hidden automatically.\n' +
    '· Stock unchanged: reply 确认库存 (or "confirm stock"), or tap "库存无变化，一键确认" in the supplier centre: all your offers are renewed at once.\n' +
    '· Stock changed: upload a new stock file in the supplier centre.\n' +
    'Confirm at least once a week. If your stock moves fast (brokers, traders), you can upload or confirm every day. The fresher your offers, the more accurate they are for buyers, and how often you update will also count towards your supplier rating. Supplier centre: https://central.parts/depot/';
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

// ---- recherches payantes : brokers volontaires (ADR 0033, complément du 9 novembre 2026)
// card : ref (SRC-…), mpn, manufacturer?, qty, needed_by?, condition (new|any), ship_to, open_until.
// Jamais la société de l'acheteur, son contact, son prix cible ni ses précisions.
export function sourcingSupplierText(card, deadlineIso) {
  const zh = [
    `【Central.Parts 寻货】${card.ref}`,
    `型号：${card.mpn}${card.manufacturer ? `（${card.manufacturer}）` : ''}  数量：${card.qty}` +
      (card.condition === 'new' ? '  全新原装' : '  新旧均可'),
    `送达国家：${countryName(card.ship_to, 'zh-CN')}` + (card.needed_by ? `  需要日期：${card.needed_by}` : ''),
    `您承诺在 ${rfqDeadline(deadlineIso, 'zh')} 前回复：`,
    `找到请回复：报价 ${card.ref} 单价 币种 交期天数 批号（数量不足请加：数量 N）`,
    `例如：报价 ${card.ref} 2.5 USD 10 2420 数量 400`,
    `找不到请回复：无货 ${card.ref}`,
    `寻货开放至 ${rfqDeadline(card.open_until, 'zh')}，之后找到也可报价。报价直接展示给买方（价格含 Central.Parts 约定的费用，您的公司名称不展示）。回复速度计入您的供应商评分。`,
    `详情：${RFQ_SITE}`,
  ];
  const en = [
    `[Central.Parts sourcing] ${card.ref}: ${card.mpn} × ${card.qty}, ship to ${countryName(card.ship_to, 'en')}.`,
    `Please answer by ${rfqDeadline(deadlineIso, 'en')}: "报价 ${card.ref} price currency lead_days date_code [数量 N]" or "无货 ${card.ref}" (not found).`,
    `Open until ${rfqDeadline(card.open_until, 'en')}: you can still quote later if you find the parts.`,
  ];
  return [...zh, '', ...en].join('\n');
}

export function sourcingReminderText(card) {
  return [
    `【Central.Parts 寻货提醒】${card.ref} 剩余12小时`,
    `型号：${card.mpn}  数量：${card.qty}`,
    `回复截止：${rfqDeadline(card.deadline_at, 'zh')}`,
    `报价 ${card.ref} 单价 币种 交期天数 批号 · 无货 ${card.ref}`,
    '',
    `[Central.Parts] Reminder: 12 hours left to answer sourcing request ${card.ref}.`,
  ].join('\n');
}

export function sourcingClosedText(ref) {
  return `【Central.Parts】寻货 ${ref} 已结束，无需回复，不影响您的评分。\nSourcing request ${ref} is closed: no reply needed, no effect on your score.`;
}

export function sourcingQuoteOkText(r, q) {
  return `已收到报价 ${r.ref}：${q.price} ${q.currency}，交期 ${q.lead} 天${q.dateCode ? `，批号 ${q.dateCode}` : ''}${q.qty ? `，数量 ${q.qty}` : ''}。报价已展示给买方，买方下单后 Central.Parts 将联系您。\n` +
    `Quote received for ${r.ref} and shown to the buyer. Central.Parts will contact you if the buyer orders.`;
}

export function sourcingDeclineOkText(ref) {
  return `已记录：${ref} 未找到。如果之后找到，寻货结束前仍可报价。\nRecorded: not found for ${ref}. You can still quote while the request is open.`;
}

export function sourcingAnswerErrorText(ref, code, detail) {
  if (code === 'CP409') {
    if (detail === 'answered') return `您已回复过 ${ref}。找到货可直接报价。\nYou have already answered ${ref}; you can still send a quote.`;
    if (detail === 'max_offers') return `${ref} 每家公司最多报价 5 次。\nAt most 5 quotes per company for ${ref}.`;
    return `寻货 ${ref} 已结束。\nSourcing request ${ref} is closed.`;
  }
  if (code === '22023') {
    const zh = { currency: '币种无效，可用 EUR、USD、CNH、HKD、GBP、JPY', price: '单价无效', lead: '交期无效', qty: '数量无效' }[detail] || '格式错误';
    const en = { currency: 'currency not accepted (EUR, USD, CNH, HKD, GBP, JPY)', price: 'invalid price', lead: 'invalid lead time', qty: 'invalid quantity' }[detail] || 'invalid format';
    return `${zh}。\n${ref}: ${en}.`;
  }
  return `未找到寻货 ${ref}。\nSourcing request ${ref} not found.`;
}

// Avis aux opérateurs (anglais, comme les autres commandes de l'administrateur).
export function sourcingOpenedOperatorText(o, res) {
  return `[Sourcing ${o.id}] paid, open to volunteers until ${String(o.open_until || '').slice(0, 16).replace('T', ' ')} UTC: ` +
    `${res.sent.length} notified${res.failed.length ? `, ${res.failed.length} not reached (${res.failed.join(', ')})` : ''}` +
    (o.volunteers ? '' : ' · no active volunteer: handle it by hand');
}
export function sourcingOfferOperatorText(r, q, sellerId) {
  return `[Sourcing ${r.ref}] ${sellerId}: ${q.kind === 'quote' ? `quote ${q.price} ${q.currency}, ${q.lead} d${q.qty ? `, qty ${q.qty}` : ''}` +
    (r.priced ? ' · shown to the buyer' : ' · NO MARGIN: not shown, set the seller margin') : 'not found'}`;
}
export function sourcingOrderOperatorText(o) {
  return `[Sourcing ${o.id}] ORDER: offer ${o.offer} (${o.seller_id}, net ${o.net} ${o.currency}, ${o.lead_days} d) · ${o.mpn} × ${o.qty} ` +
    `at ${o.unit_price} EUR · buyer ${o.company} (${o.country}), ${o.email}${o.keep_open ? ' · search kept open' : ''}. ` +
    'Send the proforma (sourcing fee deducted).';
}
export function sourcingClosedOperatorText(c) {
  return `[Sourcing ${c.id}] closed (${c.reason}): ${c.offers} offer(s), status ${c.status}.`;
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

// ------------------------------------------------------------ validité des offres (ADR 0025)
// Échéance en chinois puis en anglais, heure de Pékin seulement (le fournisseur la lit en Chine).
function expiryZh(iso) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${Number(p.month)}月${Number(p.day)}日 ${p.hour}:${p.minute}（北京时间）`;
}
function expiryEn(iso) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
    .format(new Date(iso)) + ' China time';
}

// « 确认库存 » / « confirm stock » : le fournisseur reconfirme toutes ses offres sans nouveau fichier.
export function isReconfirmRequest(text) {
  return /^\s*(确认库存|库存无变化|库存不变|confirm\s+stock|stock\s+unchanged)\s*$/i.test(String(text || ''));
}

export function reconfirmOkText(lots, expiresIso) {
  return [
    `已确认库存：${lots} 条报价继续展示，有效期至 ${expiryZh(expiresIso)}。库存有变化时，请上传新的库存表。`,
    `Stock confirmed: ${lots} offers stay visible until ${expiryEn(expiresIso)}. When your stock changes, upload a new file.`,
  ].join('\n');
}

export function reconfirmErrorText(code) {
  return code === 'none'
    ? '您目前没有在售库存，请先上传库存表。\nYou have no stock online: upload a stock file first.'
    : '暂时无法确认库存，请稍后再试，或在供应商中心上传库存表。\nThe stock could not be confirmed, please try again later or upload a file in the supplier centre.';
}

// Rappel au fournisseur : « soon » (avant l'échéance) ou « expired » (offres retirées). url : lien de connexion personnel.
export function stockReminderText(kind, lots, expiresIso, url) {
  const zh = kind === 'soon'
    ? `提醒：您在 Central.Parts 的 ${lots} 条报价将于 ${expiryZh(expiresIso)} 到期，到期后不再向采购方展示。`
    : `您在 Central.Parts 的 ${lots} 条报价已于 ${expiryZh(expiresIso)} 到期，目前不再向采购方展示。`;
  const en = kind === 'soon'
    ? `Reminder: your ${lots} offers on Central.Parts expire on ${expiryEn(expiresIso)} and will then be hidden from buyers.`
    : `Your ${lots} offers on Central.Parts expired on ${expiryEn(expiresIso)} and are no longer shown to buyers.`;
  return [
    zh,
    '库存无变化：直接回复「确认库存」。库存有变化：点击链接上传新的库存表（15 分钟内有效）：',
    url,
    '',
    en,
    'Stock unchanged: reply "confirm stock". Stock changed: tap the link to upload a new file (valid 15 minutes).',
  ].join('\n');
}

// Résumé pour les opérateurs (anglais seul).
export function operatorReminderSummary(items) {
  const lines = items.map((r) => `${r.org_id} · ${r.name}: ${r.lots} offers ${r.kind === 'soon' ? 'expire' : 'expired'} ${expiryEn(r.expires_at)}` +
    (r.delivered ? '' : ' (reminder NOT delivered: write to them)'));
  return [`[Stock reminders] ${items.length} supplier(s)`, ...lines].join('\n');
}
