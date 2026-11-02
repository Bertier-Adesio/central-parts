// Diffusion des RFQ validées aux fournisseurs, rappels, clôtures et livraison des webhooks des plateformes (ADR 0023).
// Partagé par les fonctions « rfq » (API et tâche planifiée), « wechat-events » (robot) et « admin » (back office).
//
// Règles :
//   - rien n'est envoyé à un fournisseur réel tant que RFQ_WECHAT_OPEN n'est pas « true » ;
//   - une demande du bac à sable (clé cp_test_) n'est jamais envoyée : l'envoi est simulé et inscrit comme réussi ;
//   - le délai de 48 h démarre à l'envoi réussi (record_notify_result avec l'heure de l'envoi) ; un échec ne compte pas.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
import { rfqCancelledText, rfqClosedText, rfqOperatorCard, rfqReminderText, rfqSupplierText } from './robot-texts.js';
import { RFQ_RESPONSE_HOURS, signWebhook, webhookSecret } from './rfq.js';
import { notifyOperators, sendText } from './wechat.ts';

type Card = Record<string, unknown> & { ref: string; sandbox?: boolean };
type Contact = { seller_id: string; openids: string[]; card: Card };
export type DispatchResult = { sent: string[]; failed: string[]; closed: boolean; sandbox: boolean };

// Envoi réel ou simulé : remplaçable dans les tests.
export type Sender = (db: SupabaseClient, openid: string, text: string) => Promise<boolean>;

export const wechatOpen = () => /^(1|true|yes)$/i.test(Deno.env.get('RFQ_WECHAT_OPEN') || '');

// Prévient les fournisseurs à prévenir d'une demande (tous, ou un seul). Renvoie le résumé pour l'administrateur.
export async function dispatchRfq(db: SupabaseClient, ref: string, only: string | null = null, send: Sender = sendText): Promise<DispatchResult> {
  const { data, error } = await db.rpc('rfq_contacts', { p_id: ref, p_all: false });
  if (error) throw error;
  const contacts = ((data || []) as Contact[]).filter((c) => !only || c.seller_id === only);
  const sandbox = contacts.some((c) => c.card.sandbox === true);
  const res: DispatchResult = { sent: [], failed: [], closed: false, sandbox };
  if (!sandbox && !wechatOpen()) return { ...res, closed: contacts.length > 0 };
  for (const c of contacts) {
    const at = new Date();
    const deadline = new Date(at.getTime() + RFQ_RESPONSE_HOURS * 3600 * 1000).toISOString();
    let ok = false, err: string | null = null;
    if (sandbox) {
      ok = true; // bac à sable : aucun message ne part
    } else if (!c.openids.length) {
      err = 'no_channel';
    } else {
      const text = rfqSupplierText(c.card, deadline);
      const results = await Promise.all(c.openids.map((o) => send(db, o, text)));
      ok = results.some(Boolean);
      if (!ok) err = 'WeChat: not delivered (48-hour window)';
    }
    await db.rpc('record_notify_result', { p_id: ref, p_seller: c.seller_id, p_ok: ok, p_error: err, p_now: at.toISOString() });
    (ok ? res.sent : res.failed).push(c.seller_id);
  }
  return res;
}

// Avis d'annulation aux fournisseurs déjà prévenus.
export async function tellCancelled(db: SupabaseClient, ref: string, contacts: Contact[], send: Sender = sendText) {
  if (!wechatOpen() || contacts.some((c) => c.card.sandbox === true)) return;
  await Promise.all(contacts.flatMap((c) => c.openids.map((o) => send(db, o, rfqCancelledText(ref)))));
}

// Clôture d'une demande complète ; prévient l'administrateur (sauf bac à sable).
export async function closeRfq(db: SupabaseClient, ref: string) {
  const { data, error } = await db.rpc('close_rfq', { p_id: ref });
  if (error) return null;
  const { data: card } = await db.rpc('rfq_for_operator', { p_id: ref });
  if (!card?.sandbox) await notifyOperators(db, rfqClosedText(data));
  return data;
}

// Livraison des événements dus aux plateformes, signés HMAC-SHA256 ; 2xx attendu sous 10 s.
export async function deliverWebhooks(db: SupabaseClient, limit = 50) {
  const key = Deno.env.get('RFQ_WEBHOOK_KEY') || '';
  if (!key) return 0;
  const { data } = await db.rpc('claim_webhook_deliveries', { p_limit: limit });
  let n = 0;
  for (const d of (data || []) as { id: number; webhook_id: string; url: string; payload: unknown }[]) {
    const body = JSON.stringify(d.payload);
    let ok = false, status: number | null = null;
    try {
      const headers = await signWebhook(await webhookSecret(key, d.webhook_id), body);
      const r = await fetch(d.url, { method: 'POST', body, signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Central.Parts-Webhooks/1', ...headers } });
      status = r.status; ok = r.ok;
      await r.body?.cancel();
    } catch { /* nouvelle tentative plus tard */ }
    await db.rpc('record_webhook_delivery', { p_id: d.id, p_ok: ok, p_status: status });
    if (ok) n++;
  }
  return n;
}

// Tâche planifiée (toutes les 5 minutes) : rappels à l'administrateur (24 h) et aux fournisseurs (36 h),
// expirations (48 h), clôtures, livraisons. Aucune diffusion automatique d'une demande non validée.
export async function tick(db: SupabaseClient, send: Sender = sendText) {
  const out = { ops_reminders: 0, reminders: 0, expired: 0, closed: 0, delivered: 0 };
  const { data: pending } = await db.rpc('claim_ops_rfq_reminders');
  for (const ref of (pending || []) as string[]) {
    const { data: card } = await db.rpc('rfq_for_operator', { p_id: ref });
    if (card && !card.sandbox) {
      await notifyOperators(db, rfqOperatorCard(card, 'Reminder: RFQ waiting 24 h'));
      out.ops_reminders++;
    }
  }
  const { data: rem } = await db.rpc('claim_rfq_reminders');
  for (const c of (rem || []) as Contact[]) {
    if (c.card.sandbox === true || !wechatOpen()) continue;
    await Promise.all(c.openids.map((o) => send(db, o, rfqReminderText(c.card))));
    out.reminders++;
  }
  const { data: exp } = await db.rpc('expire_overdue_sellers');
  out.expired = ((exp || []) as string[]).length;
  const { data: due } = await db.rpc('rfq_due_for_close');
  for (const ref of (due || []) as string[]) if (await closeRfq(db, ref)) out.closed++;
  out.delivered = await deliverWebhooks(db);
  return out;
}
