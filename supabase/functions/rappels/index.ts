// Fonction Edge « rappels » : rappels WeChat aux fournisseurs avant l'expiration de leurs offres (ADR 0025).
// Appelée par une tâche planifiée (pg_cron, toutes les heures) ; déployée sans vérification de jeton Supabase
// (--no-verify-jwt) : elle exige l'en-tête X-CP-Jobs-Secret, même secret que la tâche de la route RFQ (RFQ_JOBS_SECRET).
//
//   POST /rappels/tick           envoie les rappels dus : « bientôt » (48 h avant l'échéance) et « expiré » (24 h après),
//                                aux administrateurs WeChat du fournisseur, avec un lien de connexion personnel ;
//                                puis un résumé aux opérateurs. Un rappel par fournisseur, type et échéance.
//   POST /rappels/tick?dry=1     liste les rappels dus sans rien envoyer.
//
// WeChat ne délivre un message libre (客服消息) qu'à un abonné actif dans les 48 dernières heures : un rappel non délivré
// est signalé aux opérateurs, qui relancent à la main (message modèle 模板消息 à venir).
// Secrets : RFQ_JOBS_SECRET ; WECHAT_APPID et WECHAT_SECRET (envoi des messages).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { operatorReminderSummary, stockReminderText } from '../_shared/robot-texts.js';
import { notifyOperators, sendText } from '../_shared/wechat.ts';

const SITE = 'https://central.parts/depot/';

type Due = { org_id: string; name: string; kind: 'soon' | 'expired'; lots: number; expires_at: string; admins: string[] };

Deno.serve(async (req) => {
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  const url = new URL(req.url);
  const secret = Deno.env.get('RFQ_JOBS_SECRET') || '';
  if (req.method !== 'POST' || !url.pathname.endsWith('/tick') || !secret || req.headers.get('x-cp-jobs-secret') !== secret) {
    return json({ error: 'forbidden' }, 403);
  }
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const { data, error } = await db.rpc('due_stock_reminders', {});
  if (error) return json({ error: 'database', detail: error.message }, 500);
  const due = (data || []) as Due[];
  if (url.searchParams.get('dry') === '1') {
    return json({ dry_run: true, due: due.map(({ admins, ...r }) => ({ ...r, admins: admins.length })) });
  }

  const done: (Due & { delivered: boolean })[] = [];
  for (const r of due) {
    let delivered = false;
    for (const openid of r.admins) {
      const { data: scene } = await db.rpc('depot_login_link', { p_openid: openid });
      const link = scene ? `${SITE}?login=${scene}` : SITE;
      if (await sendText(db, openid, stockReminderText(r.kind, r.lots, r.expires_at, link))) delivered = true;
    }
    await db.rpc('record_stock_reminder', { p_org: r.org_id, p_kind: r.kind, p_expires: r.expires_at, p_delivered: delivered });
    done.push({ ...r, delivered });
  }
  if (done.length) await notifyOperators(db, operatorReminderSummary(done));
  return json({ sent: done.length, delivered: done.filter((r) => r.delivered).length,
    reminders: done.map(({ admins, ...r }) => ({ ...r, admins: admins.length })) });
});
