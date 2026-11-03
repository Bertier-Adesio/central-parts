// Fonction Edge « rappels » : rappels WeChat aux fournisseurs avant l'expiration de leurs offres (ADR 0025).
// Appelée par une tâche planifiée (pg_cron, toutes les heures) ; déployée sans vérification de jeton Supabase
// (--no-verify-jwt) : elle exige l'en-tête X-CP-Jobs-Secret, même secret que la tâche de la route RFQ (RFQ_JOBS_SECRET).
//
//   POST /rappels/tick           envoie les rappels dus : « bientôt » (48 h avant l'échéance) et « expiré » (24 h après),
//                                aux administrateurs WeChat du fournisseur, avec un lien de connexion personnel ;
//                                puis un résumé aux opérateurs. Un rappel par fournisseur, type et échéance.
//   POST /rappels/tick?dry=1     liste les rappels dus sans rien envoyer (ni mise à jour des taux).
//
// À chaque passage, si les taux de change en base ont plus de 20 heures, relit le fichier quotidien de la BCE et met
// à jour public.currencies (set_eur_rates) : prix publics en euros, ADR 0027. Un échec de la BCE n'empêche pas les
// rappels ; les opérateurs sont prévenus si les taux ont plus de 4 jours.
//
// WeChat ne délivre un message libre (客服消息) qu'à un abonné actif dans les 48 dernières heures : un rappel non délivré
// est signalé aux opérateurs, qui relancent à la main (message modèle 模板消息 à venir).
// Secrets : RFQ_JOBS_SECRET ; WECHAT_APPID et WECHAT_SECRET (envoi des messages).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { operatorReminderSummary, stockReminderText } from '../_shared/robot-texts.js';
import { notifyOperators, sendText } from '../_shared/wechat.ts';
import { ECB_DAILY_URL, parseEcbDaily, ratesStale } from '../_shared/fx.js';

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
  const dry = url.searchParams.get('dry') === '1';

  // Taux de la BCE, une fois par jour (publiés vers 16 h à Francfort, les jours ouvrés).
  let fx: unknown = null;
  const { data: ratesAt } = await db.rpc('eur_rates_at');
  if (!dry && ratesStale(ratesAt as string | null)) {
    try {
      const r = await fetch(ECB_DAILY_URL, { signal: AbortSignal.timeout(10000) });
      const daily = r.ok ? parseEcbDaily(await r.text()) : null;
      if (!daily) throw new Error('fichier BCE illisible (HTTP ' + r.status + ')');
      const { data: res, error: e } = await db.rpc('set_eur_rates', { p_rates: daily.rates, p_date: daily.date });
      fx = e ? { error: e.message } : res;
    } catch (err) {
      fx = { error: err instanceof Error ? err.message : String(err) };
    }
    // Alerte une fois par jour (passage de 8 h UTC) quand les taux ont plus de 4 jours.
    if (ratesAt && new Date().getUTCHours() === 8 && Date.now() - new Date(ratesAt as string).getTime() > 4 * 86400000 && (fx as { error?: string })?.error) {
      await notifyOperators(db, `[Exchange rates] ECB rates not updated since ${String(ratesAt).slice(0, 10)}: ${(fx as { error: string }).error}. Public prices in EUR use the last known rates.`);
    }
  }

  const { data, error } = await db.rpc('due_stock_reminders', {});
  if (error) return json({ error: 'database', detail: error.message }, 500);
  const due = (data || []) as Due[];
  if (dry) {
    return json({ dry_run: true, rates_at: ratesAt, due: due.map(({ admins, ...r }) => ({ ...r, admins: admins.length })) });
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
  return json({ fx, sent: done.length, delivered: done.filter((r) => r.delivered).length,
    reminders: done.map(({ admins, ...r }) => ({ ...r, admins: admins.length })) });
});
