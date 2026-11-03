// Complétion d'adresses (ADR 0030) : Photon, moteur libre (Apache 2.0) sur les données OpenStreetMap.
// La fonction Edge « order » interroge Photon côté serveur : aucune ressource tierce n'est chargée par le navigateur
// (accès depuis la Chine, ADR 0006). Instance publique de Komoot par défaut ; une instance auto-hébergée se règle par la
// variable ADDRESS_API, sans changer le code. Module sans dépendance, partagé par Deno (fonction) et Node (tests).

export const PHOTON_DEFAULT = 'https://photon.komoot.io';
export const PHOTON_LANGS = ['default', 'en', 'de', 'fr', 'it'];

// Adresse de la requête Photon : texte saisi, langue des libellés, 8 résultats au plus.
export function photonUrl(base, q, lang) {
  const l = PHOTON_LANGS.includes(lang) ? lang : 'default';
  return `${String(base || PHOTON_DEFAULT).replace(/\/$/, '')}/api/?q=${encodeURIComponent(String(q || '').slice(0, 120))}&limit=8&lang=${l}`;
}

// Réponse Photon (GeoJSON) → adresses simples, filtrées par pays (code ISO à deux lettres) quand il est donné.
// Ne garde que les résultats qui ont au moins une ville ou un code postal ; 5 au plus, sans doublon.
export function normalizePhoton(geojson, country) {
  const cc = String(country || '').toUpperCase();
  const seen = new Set();
  const out = [];
  for (const f of (geojson && geojson.features) || []) {
    const p = f.properties || {};
    const code = String(p.countrycode || '').toUpperCase();
    if (cc && code !== cc) continue;
    const city = p.city || p.town || p.village || p.locality || p.district || p.county || '';
    const street = [p.street || (p.type === 'street' ? p.name : ''), p.housenumber].filter(Boolean).join(' ');
    const name = p.type === 'house' || p.type === 'street' ? '' : (p.name || '');
    if (!city && !p.postcode) continue;
    const line1 = [name, street].filter(Boolean).join(', ');
    const label = [line1, [p.postcode, city].filter(Boolean).join(' '), code].filter(Boolean).join(', ');
    if (seen.has(label)) continue;
    seen.add(label);
    out.push({ label, line1, postcode: p.postcode || '', city, country: code });
    if (out.length === 5) break;
  }
  return out;
}

// Texte de l'adresse tel qu'il est rempli dans le formulaire : rue, puis code postal et ville.
export function addressText(a) {
  return [a.line1, [a.postcode, a.city].filter(Boolean).join(' ')].filter(Boolean).join('\n');
}
