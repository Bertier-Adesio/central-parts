// Taux de change de référence de la Banque centrale européenne (ADR 0027), lus par la fonction « rappels » une fois
// par jour, puis enregistrés en base (set_eur_rates). Fichier public, sans clé : https://www.ecb.europa.eu/stats/eurofxref/
// Module sans dépendance, partagé par Deno (fonction Edge) et Node (tests).

export const ECB_DAILY_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';

// Lit le fichier quotidien de la BCE : <Cube time='2026-11-03'><Cube currency='USD' rate='1.0812'/>…
// Renvoie { date: 'AAAA-MM-JJ', rates: { USD: 1.0812, … } } (unités de devise pour 1 euro), ou null si illisible.
export function parseEcbDaily(xml) {
  const text = String(xml || '');
  const d = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(text);
  if (!d) return null;
  const rates = {};
  for (const m of text.matchAll(/<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"](\d+(?:\.\d+)?)['"]\s*\/>/g)) {
    const v = Number(m[2]);
    if (v > 0) rates[m[1]] = v;
  }
  return Object.keys(rates).length ? { date: d[1], rates } : null;
}

// Faut-il relire la BCE ? Oui si le plus ancien taux en base date de plus de 20 heures (ou s'il n'y en a pas).
export function ratesStale(ratesAt, now = Date.now()) {
  if (!ratesAt) return true;
  return now - new Date(ratesAt).getTime() > 20 * 3600 * 1000;
}
