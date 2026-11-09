// Diffusion des RFQ (supabase/functions/_shared/rfq-dispatch.ts) avec une base et WeChat simulés : aucun appel réseau.
//   - drapeau RFQ_WECHAT_OPEN fermé : rien n'est envoyé ;
//   - envoi réussi : échéance = heure de l'envoi + 48 h, inscrite avec cette heure ; échec : rien ne démarre ;
//   - bac à sable : aucun message, même drapeau ouvert ;
//   - tâche planifiée : rappels, clôtures, livraison signée des webhooks ;
//   - recherches payantes (ADR 0033) : envoi aux brokers volontaires sans drapeau, échéance de 48 h, rappel, clôture.
// Usage : deno run --allow-env tools/test-rfq-dispatch.ts
import { closeRfq, deliverWebhooks, dispatchRfq, tick } from '../supabase/functions/_shared/rfq-dispatch.ts';
import { verifyWebhook, webhookSecret } from '../supabase/functions/_shared/rfq.js';
import { openSourcing, sourcingTick, tellSourcingClosed } from '../supabase/functions/_shared/sourcing-dispatch.ts';

let n = 0, bad = 0;
const ok = (cond: unknown, label: string) => { n++; if (!cond) { bad++; console.log('ÉCHEC ' + label); } };

type Call = { name: string; args: Record<string, unknown> };
// Base simulée : réponses par fonction SQL, journal des appels ; tables operators et wechat_access_tokens.
function fakeDb(responses: Record<string, unknown>) {
  const calls: Call[] = [];
  const chain = (data: unknown) => {
    const q: Record<string, unknown> = {};
    for (const k of ['select', 'eq', 'is', 'in', 'order', 'limit', 'upsert']) q[k] = () => q;
    q.maybeSingle = () => Promise.resolve({ data: Array.isArray(data) ? data[0] ?? null : data });
    q.then = (res: (v: unknown) => unknown) => res({ data });
    return q;
  };
  const db = {
    calls,
    rpc(name: string, args: Record<string, unknown> = {}) {
      calls.push({ name, args });
      const r = responses[name];
      return Promise.resolve({ data: typeof r === 'function' ? (r as (a: unknown) => unknown)(args) : r ?? null, error: null });
    },
    from(table: string) {
      if (table === 'operators') return chain([{ openid: 'oOPERATOR' }]);
      if (table === 'wechat_access_tokens') return chain({ token: 'jeton', expires_at: new Date(Date.now() + 3600e3).toISOString() });
      return chain([]);
    },
  };
  return db;
}

// WeChat simulé : messages envoyés, par destinataire.
const outbox: { to: string; text: string }[] = [];
const fetched: { url: string; init?: RequestInit }[] = [];
let webhookStatus = 200;
globalThis.fetch = ((url: string, init?: RequestInit) => {
  fetched.push({ url: String(url), init });
  if (String(url).startsWith('https://api.weixin.qq.com/cgi-bin/message/custom/send')) {
    const b = JSON.parse(String(init?.body));
    outbox.push({ to: b.touser, text: b.text.content });
    return Promise.resolve(new Response(JSON.stringify({ errcode: 0 })));
  }
  if (String(url).startsWith('https://plateforme.example/')) return Promise.resolve(new Response('ok', { status: webhookStatus }));
  return Promise.resolve(new Response(JSON.stringify({ errcode: 0 })));
}) as typeof fetch;

const card = { ref: 'DEM-1042', mpn: 'NE555DR', qty: 2000, dc_min: '2420', ship_to: 'DE' };
const contacts = [
  { seller_id: 'ORG-0101', openids: ['oA1', 'oA2'], card },
  { seller_id: 'ORG-0105', openids: ['oB1'], card },
  { seller_id: 'ORG-0107', openids: [], card },
];
const sent: { to: string; text: string }[] = [];
const sender = (ok: Record<string, boolean>) => (_db: unknown, to: string, text: string) => {
  sent.push({ to, text });
  return Promise.resolve(ok[to] ?? true);
};

// ---------------------------------------------------------------- drapeau fermé
Deno.env.delete('RFQ_WECHAT_OPEN');
{
  const db = fakeDb({ rfq_contacts: contacts });
  const r = await dispatchRfq(db as never, 'DEM-1042', null, sender({}));
  ok(r.closed && !r.sent.length && !sent.length, 'drapeau fermé : rien envoyé, « diffusion fermée »');
  ok(!db.calls.some((c) => c.name === 'record_notify_result'), 'drapeau fermé : aucune échéance démarrée');
}

// ---------------------------------------------------------------- drapeau ouvert
Deno.env.set('RFQ_WECHAT_OPEN', 'true');
{
  sent.length = 0;
  const db = fakeDb({ rfq_contacts: contacts });
  const before = Date.now();
  const r = await dispatchRfq(db as never, 'DEM-1042', null, sender({ oA1: false, oA2: true, oB1: false }));
  const rec = db.calls.filter((c) => c.name === 'record_notify_result');
  ok(JSON.stringify(r.sent) === '["ORG-0101"]' && JSON.stringify(r.failed) === '["ORG-0105","ORG-0107"]', 'ouvert : un contact joint suffit ; échec et aucun canal');
  ok(sent.filter((s) => s.to.startsWith('oA')).length === 2, 'ouvert : tous les contacts de la société sont prévenus');
  const a = rec.find((c) => c.args.p_seller === 'ORG-0101')!;
  const at = Date.parse(String(a.args.p_now));
  ok(a.args.p_ok === true && at >= before && at <= Date.now(), 'envoi réussi : inscrit avec l\'heure de l\'envoi');
  const deadline = new Date(at + 48 * 3600e3);
  const hh = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(deadline);
  ok(sent[0].text.includes(hh + '（北京时间）'), 'message : échéance = envoi + 48 h (' + hh + ')');
  ok(rec.find((c) => c.args.p_seller === 'ORG-0105')?.args.p_ok === false, 'envoi échoué : inscrit comme échec');
  ok(rec.find((c) => c.args.p_seller === 'ORG-0107')?.args.p_error === 'no_channel', 'aucun compte WeChat : no_channel');
  ok(!sent.some((s) => /Plateforme|ADS-|client/i.test(s.text)), 'anonymat : rien de la plateforme dans les messages');
}
{
  sent.length = 0;
  const db = fakeDb({ rfq_contacts: contacts });
  const r = await dispatchRfq(db as never, 'DEM-1042', 'ORG-0105', sender({}));
  ok(JSON.stringify(r.sent) === '["ORG-0105"]' && sent.every((s) => s.to === 'oB1'), 'renvoi ciblé : un seul fournisseur');
}

// ---------------------------------------------------------------- bac à sable
{
  sent.length = 0;
  const db = fakeDb({ rfq_contacts: [{ seller_id: 'SBX-S', openids: ['sandbox-openid'], card: { ...card, sandbox: true } }] });
  const r = await dispatchRfq(db as never, 'DEM-2000', null, sender({}));
  ok(r.sandbox && JSON.stringify(r.sent) === '["SBX-S"]' && !sent.length, 'bac à sable : envoi simulé, aucun message');
  ok(db.calls.some((c) => c.name === 'record_notify_result' && c.args.p_ok === true), 'bac à sable : échéance démarrée (cycle complet possible)');
}

// ---------------------------------------------------------------- tâche planifiée et clôture
{
  sent.length = 0; outbox.length = 0;
  const db = fakeDb({
    claim_ops_rfq_reminders: ['DEM-1042'],
    rfq_for_operator: { id: 'DEM-1042', status: 'pending_validation', client: 'ORG-0150 Adesio', mpn: 'NE555DR', qty: 2000, ship_to: 'DE', currency: 'EUR', candidates: [] },
    claim_rfq_reminders: [{ seller_id: 'ORG-0101', openids: ['oA1'], card: { ...card, deadline_at: new Date(Date.now() + 12 * 3600e3).toISOString() } },
                          { seller_id: 'SBX-S', openids: ['sandbox-openid'], card: { ...card, sandbox: true, deadline_at: new Date().toISOString() } }],
    expire_overdue_sellers: ['DEM-0999'],
    rfq_due_for_close: ['DEM-0999'],
    close_rfq: { id: 'DEM-0999', status: 'offers', offers: 2, no_margin: 0 },
    claim_webhook_deliveries: [],
  });
  const r = await tick(db as never, sender({}));
  ok(r.ops_reminders === 1 && outbox.some((m) => m.to === 'oOPERATOR' && m.text.includes('Reminder: RFQ waiting 24 h')), 'tâche : rappel 24 h à l\'administrateur');
  ok(r.reminders === 1 && sent.length === 1 && sent[0].text.includes('剩余12小时'), 'tâche : rappel 36 h au fournisseur, jamais au bac à sable');
  ok(r.expired === 1 && r.closed === 1, 'tâche : expirations et clôture');
  ok(outbox.some((m) => m.text.includes('[RFQ DEM-0999] closed: 2 offer(s)')), 'clôture : administrateur prévenu');
  ok(!db.calls.some((c) => c.name === 'approve_rfq'), 'tâche : aucune validation automatique');
}

// ---------------------------------------------------------------- webhooks
{
  Deno.env.set('RFQ_WEBHOOK_KEY', 'cle-de-test');
  fetched.length = 0;
  const payload = { event: 'demand.offers_ready', demand_id: 'DEM-1042', offers_count: 2 };
  const db = fakeDb({ claim_webhook_deliveries: [{ id: 7, webhook_id: 'WHK-0003', url: 'https://plateforme.example/hook', payload }] });
  const delivered = await deliverWebhooks(db as never);
  const call = fetched.find((f) => f.url === 'https://plateforme.example/hook')!;
  const h = call.init!.headers as Record<string, string>;
  const secret = await webhookSecret('cle-de-test', 'WHK-0003');
  ok(delivered === 1 && await verifyWebhook(secret, String(call.init!.body), h), 'webhook : livré et signé (CP-Signature, CP-Timestamp)');
  ok(db.calls.some((c) => c.name === 'record_webhook_delivery' && c.args.p_ok === true && c.args.p_status === 200), 'webhook : livraison inscrite');
  webhookStatus = 500;
  const db2 = fakeDb({ claim_webhook_deliveries: [{ id: 8, webhook_id: 'WHK-0003', url: 'https://plateforme.example/hook', payload }] });
  ok(await deliverWebhooks(db2 as never) === 0 && db2.calls.some((c) => c.name === 'record_webhook_delivery' && c.args.p_ok === false), 'webhook : échec inscrit, nouvelle tentative plus tard');
  Deno.env.delete('RFQ_WEBHOOK_KEY');
  const db3 = fakeDb({ claim_webhook_deliveries: [{ id: 9 }] });
  ok(await deliverWebhooks(db3 as never) === 0 && !db3.calls.length, 'webhook : sans RFQ_WEBHOOK_KEY, rien n\'est livré');
}
{
  outbox.length = 0;
  const db = fakeDb({ close_rfq: { id: 'DEM-2000', status: 'offers', offers: 1 }, rfq_for_operator: { id: 'DEM-2000', sandbox: true } });
  await closeRfq(db as never, 'DEM-2000');
  ok(!outbox.length, 'bac à sable : clôture sans message à l\'administrateur');
}
// ---------------------------------------------------------------- recherches payantes : brokers volontaires
Deno.env.delete('RFQ_WECHAT_OPEN');
{
  sent.length = 0; outbox.length = 0;
  const srcCard = { ref: 'SRC-0012', mpn: 'LM317HVK', qty: 500, condition: 'new', ship_to: 'FR', open_until: '2026-11-17T08:00:00Z' };
  const db = fakeDb({ sourcing_open: { id: 'SRC-0012', open_until: '2026-11-17T08:00:00Z', volunteers: 3, contacts: [
    { seller_id: 'ORG-0201', openids: ['oV1'], card: srcCard },
    { seller_id: 'ORG-0202', openids: ['oV2'], card: srcCard },
    { seller_id: 'ORG-0203', openids: [], card: srcCard }] } });
  const before = Date.now();
  const r = await openSourcing(db as never, 'SRC-0012', sender({ oV2: false }));
  const rec = db.calls.filter((c) => c.name === 'sourcing_notify_result');
  ok(r !== null && JSON.stringify(r.sent) === '["ORG-0201"]' && JSON.stringify(r.failed) === '["ORG-0202","ORG-0203"]', 'volontaires : envoi sans drapeau ; échec et aucun canal');
  const a = rec.find((c) => c.args.p_seller === 'ORG-0201')!;
  const at = Date.parse(String(a.args.p_now));
  ok(a.args.p_ok === true && at >= before && at <= Date.now(), 'volontaires : envoi réussi inscrit avec son heure');
  const hh = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(at + 48 * 3600e3));
  ok(sent.find((x) => x.to === 'oV1')!.text.includes(hh + '（北京时间）'), 'volontaires : échéance = envoi + 48 h');
  ok(rec.find((c) => c.args.p_seller === 'ORG-0203')?.args.p_error === 'no_channel', 'volontaires : aucun compte WeChat');
  ok(outbox.some((m) => m.to === 'oOPERATOR' && m.text.includes('[Sourcing SRC-0012] paid') && m.text.includes('1 notified')), 'volontaires : opérateur prévenu');
  ok(await openSourcing(fakeDb({ sourcing_open: null }) as never, 'SRC-0012', sender({})) === null, 'volontaires : ouverture rejouée sans envoi');
}
{
  sent.length = 0; outbox.length = 0;
  const srcCard = { ref: 'SRC-0012', mpn: 'LM317HVK', qty: 500, deadline_at: new Date(Date.now() + 12 * 3600e3).toISOString() };
  const db = fakeDb({ sourcing_tick: { reminders: [{ seller_id: 'ORG-0201', openids: ['oV1'], card: srcCard }], expired: 2,
    closed: [{ id: 'SRC-0011', mpn: 'X', status: 'not_found', reason: 'expired', offers: 0, tell: [{ seller_id: 'ORG-0202', openids: ['oV2'] }] }] } });
  const r = await sourcingTick(db as never, sender({}));
  ok(r.reminders === 1 && r.expired === 2 && r.closed === 1, 'volontaires : tâche planifiée (rappel, échéances, clôture)');
  ok(sent.some((x) => x.to === 'oV1' && x.text.includes('剩余12小时')) && sent.some((x) => x.to === 'oV2' && x.text.includes('寻货 SRC-0011 已结束')), 'volontaires : rappel et avis de clôture');
  ok(outbox.some((m) => m.text.includes('[Sourcing SRC-0011] closed (expired)')), 'volontaires : clôture signalée à l\'opérateur');
  await tellSourcingClosed(db as never, null, sender({}));
}

ok(!fetched.some((f) => !/^https:\/\/(api\.weixin\.qq\.com|plateforme\.example)\//.test(f.url)), 'aucun autre appel réseau');

console.log(`${n - bad}/${n} vérifications réussies`);
Deno.exit(bad ? 1 : 0);
