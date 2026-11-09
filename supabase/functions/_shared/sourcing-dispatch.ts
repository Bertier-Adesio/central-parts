// Recherches payantes : diffusion aux brokers volontaires, clôtures et tâche planifiée (ADR 0033, complément du
// 9 novembre 2026). Partagé par les fonctions « sourcing » (paiement, actions de l'acheteur), « admin » (proforma
// marquée payée), « wechat-events » et « depot » (réponses), et « rfq » (tâche planifiée, toutes les 5 minutes).
//
// Règles :
//   - diffusion automatique au paiement, sans validation ni drapeau : les volontaires se sont inscrits eux-mêmes ;
//   - l'échéance de 48 h démarre à l'envoi réussi (sourcing_notify_result avec l'heure de l'envoi) ; un échec ne
//     compte jamais contre le vendeur et l'opérateur est prévenu ;
//   - à la clôture, les volontaires qui n'ont pas répondu sont prévenus (sans effet sur leur note).
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
import { sourcingClosedOperatorText, sourcingClosedText, sourcingOpenedOperatorText, sourcingReminderText, sourcingSupplierText } from './robot-texts.js';
import { RFQ_RESPONSE_HOURS } from './rfq.js';
import { notifyOperators, sendText } from './wechat.ts';

type Card = Record<string, unknown> & { ref: string; open_until?: string; deadline_at?: string };
type Contact = { seller_id: string; openids: string[]; card: Card };
export type Closed = { id: string; mpn: string; status: string; reason: string; offers: number; tell: { seller_id: string; openids: string[] }[] };
export type Sender = (db: SupabaseClient, openid: string, text: string) => Promise<boolean>;

// Prévient les volontaires encore à prévenir d'une recherche ouverte. Renvoie les vendeurs joints et non joints.
export async function notifyVolunteers(db: SupabaseClient, id: string, contacts: Contact[], send: Sender = sendText) {
  const res = { sent: [] as string[], failed: [] as string[] };
  for (const c of contacts) {
    const at = new Date();
    const deadline = new Date(at.getTime() + RFQ_RESPONSE_HOURS * 3600 * 1000).toISOString();
    let ok = false, err: string | null = null;
    if (!c.openids.length) err = 'no_channel';
    else {
      const text = sourcingSupplierText(c.card, deadline);
      ok = (await Promise.all(c.openids.map((o) => send(db, o, text)))).some(Boolean);
      if (!ok) err = 'WeChat: not delivered (48-hour window)';
    }
    await db.rpc('sourcing_notify_result', { p_id: id, p_seller: c.seller_id, p_ok: ok, p_error: err, p_now: at.toISOString() });
    (ok ? res.sent : res.failed).push(c.seller_id);
  }
  return res;
}

// Recherche payée : ouverture aux volontaires (une seule fois) et envoi ; avis à l'opérateur. Null si déjà ouverte.
export async function openSourcing(db: SupabaseClient, id: string, send: Sender = sendText) {
  const { data, error } = await db.rpc('sourcing_open', { p_id: id });
  if (error || !data) return null;
  const res = await notifyVolunteers(db, data.id, (data.contacts || []) as Contact[], send);
  await notifyOperators(db, sourcingOpenedOperatorText(data, res)).catch(() => {});
  return { ...res, open_until: data.open_until, volunteers: data.volunteers };
}

// Clôture : avis aux volontaires sans réponse, et à l'opérateur.
export async function tellSourcingClosed(db: SupabaseClient, c: Closed | null, send: Sender = sendText) {
  if (!c) return;
  await Promise.all((c.tell || []).flatMap((t) => t.openids.map((o) => send(db, o, sourcingClosedText(c.id)))));
  await notifyOperators(db, sourcingClosedOperatorText(c)).catch(() => {});
}

// Tâche planifiée : rappel à 36 h (une fois), échéances de 48 h, recherches arrivées au terme.
export async function sourcingTick(db: SupabaseClient, send: Sender = sendText) {
  const out = { reminders: 0, expired: 0, closed: 0 };
  const { data, error } = await db.rpc('sourcing_tick');
  if (error || !data) return out;
  for (const c of (data.reminders || []) as Contact[]) {
    await Promise.all(c.openids.map((o) => send(db, o, sourcingReminderText(c.card))));
    out.reminders++;
  }
  out.expired = Number(data.expired) || 0;
  for (const c of (data.closed || []) as Closed[]) { await tellSourcingClosed(db, c, send); out.closed++; }
  return out;
}
