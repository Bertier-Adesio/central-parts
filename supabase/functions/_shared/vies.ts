// Vérification d'un numéro de TVA intracommunautaire auprès du service VIES de la Commission européenne.
// Renvoie true, false, ou null si le service ne répond pas ou ne couvre pas le pays (Royaume-Uni, Suisse, Norvège…).
// Utilisée par les fonctions order (demande d'achat, panier) et sourcing (recherche payante).
export async function viesValid(vat: string): Promise<boolean | null> {
  const m = /^([A-Z]{2})([0-9A-Z]+)$/.exec(vat);
  if (!m || ['GB', 'CH', 'NO'].includes(m[1])) return null;
  try {
    const r = await fetch(`https://ec.europa.eu/taxation_customs/vies/rest-api/ms/${m[1]}/vat/${m[2]}`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const d = await r.json();
    return typeof d.isValid === 'boolean' ? d.isValid : null;
  } catch {
    return null;
  }
}
