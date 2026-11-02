// API d'offres en direct (ADR 0024) : mise en forme des offres de Central.Parts (catalog_offers en base) dans les
// formats que les plateformes de chiffrage savent déjà lire. Sans réseau ni base ; testé par tools/test-catalog.mjs.
//
//   - format natif : celui de la base (offer_id, stock, moq, price_breaks, source_category, ship_from…), page /api/ ;
//   - format compatible DigiKey (Product Information v4 : ProductDetails, KeywordSearch) ;
//   - format compatible Texas Instruments (TI store, inventory and pricing v2).
// DigiKey ProductPricing (v4) : structure d'une réponse réelle (tools/fixtures/digikey-productpricing.json).
// TI store : structure d'un exemple de la réponse « prix et stock » (camelCase, tiPartNumber), pas encore d'une capture
// réelle (tools/fixtures/ti-product.json, à remplacer). La fiche produit TI /v1 (PascalCase, Identifier…), que les
// connecteurs fusionnent sous productInformation, n'est pas servie : faute d'exemple, rien n'est inventé. Le fournisseur n'apparaît jamais : « Supplier » vaut
// toujours Central.Parts, et l'identifiant de l'offre remplace le numéro de produit du distributeur.

export const SOURCE_CATEGORIES = ['manufacturer', 'authorized_distributor', 'broker_surplus'];

// Paramètres de GET /v1/offers. Renvoie { args } ou { error, field }.
export function parseOffersQuery(sp) {
  const mpn = (sp.get('mpn') || '').trim();
  if (!mpn) return { error: 'mpn is required', field: 'mpn' };
  const qtyRaw = sp.get('qty') ?? sp.get('quantity');
  let qty = null;
  if (qtyRaw != null && qtyRaw !== '') {
    if (!/^\d{1,9}$/.test(qtyRaw) || Number(qtyRaw) < 1) return { error: 'qty must be a positive integer', field: 'qty' };
    qty = Number(qtyRaw);
  }
  const src = (sp.get('source_category') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (src.some((s) => !SOURCE_CATEGORIES.includes(s))) return { error: 'Unknown source_category', field: 'source_category' };
  return { args: { p_mpn: mpn, p_manufacturer: sp.get('manufacturer') || null, p_qty: qty, p_currency: sp.get('currency') || null, p_sources: src.length ? src : null } };
}

// Extension propre à Central.Parts, ajoutée aux formats compatibles : ce que ces formats n'ont pas.
const extension = (o) => ({
  offerId: o.offer_id, sourceCategory: o.source_category, priceStatus: o.price_status, shipFrom: o.ship_from,
  dateCode: o.date_code ?? null, leadTimeDays: o.lead_time_days ?? null, currency: o.currency ?? null,
  priceValidUntil: o.price_valid_until ?? null, packaging: o.packaging ?? null, countryOfOrigin: o.country_of_origin ?? null,
  manufacturerId: o.manufacturer_id ?? null,
});

const round2 = (x) => Math.round(x * 100) / 100;

// Page publique de la référence chez Central.Parts : seul lien donné (jamais la fiche du fournisseur).
export const productUrl = (mpn) => 'https://central.parts/recherche/?q=' + encodeURIComponent(mpn);

// Variante DigiKey d'une offre (champs vérifiés sur ProductPricing), avec l'extension CentralParts.
const digiKeyVariation = (o) => ({
  DigiKeyProductNumber: o.offer_id,
  PackageType: { Id: 0, Name: packLabel(o) },
  MinimumOrderQuantity: o.moq,
  QuantityAvailableforPackageType: o.stock,
  StandardPricing: (o.price_breaks || []).map((b) => ({ BreakQuantity: b.quantity, UnitPrice: b.price, TotalPrice: round2(b.quantity * b.price) })),
  MyPricing: [],
  MarketPlace: o.source_category === 'broker_surplus',
  TariffActive: false,
  Supplier: { Id: 0, Name: 'Central.Parts' },
  MaxQuantityForDistribution: 0,
  StandardPackage: o.standard_pack_quantity || 0,
  DigiReelFee: 0,
  CentralParts: extension(o),
});
const standardPackage = (offers) => Math.max(0, ...offers.map((o) => o.standard_pack_quantity || 0));
const leadWeeks = (offers) => {
  const lead = offers.map((o) => o.lead_time_days).filter((d) => d != null);
  return lead.length ? String(Math.ceil(Math.min(...lead) / 7)) : '';
};

// Réponse native (products[].offers[]) → liste d'offres à plat, avec les champs du produit, pour les formats
// compatibles. Les paliers natifs {quantity, unit_price} deviennent {quantity, price}.
export function flattenProducts(products) {
  const out = [];
  for (const p of products || []) {
    for (const o of p.offers || []) {
      out.push({ ...o, mpn: p.mpn, manufacturer: p.manufacturer?.name || '', manufacturer_id: p.manufacturer?.id || null,
        description: p.description, datasheet_url: p.datasheet_url, package_case: p.package_case, lifecycle: p.lifecycle,
        eccn: p.eccn, hts_code: p.hts_code,
        price_breaks: (o.price_breaks || []).map((b) => ({ quantity: b.quantity, price: b.unit_price ?? b.price })) });
    }
  }
  return out;
}

// Cycle de vie : libellés DigiKey (ProductStatus) et TI (lifeCycle) ; inconnu : texte vide.
const DK_STATUS = { active: 'Active', nrnd: 'Not For New Designs', last_time_buy: 'Last Time Buy', obsolete: 'Obsolete' };
const TI_LIFECYCLE = { active: 'ACTIVE', nrnd: 'NRND', last_time_buy: 'LIFEBUY', obsolete: 'OBSOLETE' };
const packLabel = (o) => o.packaging_label || o.packaging || '';

// Offres utilisables dans un format à devise unique : sur demande, ou dans la devise de la réponse.
export function offersInCurrency(offers, currency) {
  return offers.filter((o) => o.price_status === 'on_request' || o.currency === currency);
}


// Regroupe les offres d'une référence par fabricant (DigiKey : un produit par fabricant et référence).
export function groupByManufacturer(offers) {
  const groups = new Map();
  for (const o of offers) {
    const k = (o.manufacturer || '').toLowerCase();
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(o);
  }
  return [...groups.values()].sort((a, b) => b.reduce((s, o) => s + o.stock, 0) - a.reduce((s, o) => s + o.stock, 0));
}

// Produit au format DigiKey Product Information v4.
export function toDigiKeyProduct(mpn, offers) {
  const priced = offers.filter((o) => o.price_status === 'priced' && o.price_breaks.length);
  const first = offers[0] || {};
  return {
    Description: { ProductDescription: first.description || mpn, DetailedDescription: first.description || '' },
    Manufacturer: { Id: 0, Name: first.manufacturer || '' },
    ManufacturerProductNumber: mpn,
    UnitPrice: priced.length ? Math.min(...priced.map((o) => o.price_breaks[0].price)) : 0,
    ProductUrl: productUrl(mpn),
    DatasheetUrl: offers.map((o) => o.datasheet_url).find(Boolean) || null,
    PhotoUrl: null,
    ProductVariations: offers.map(digiKeyVariation),
    QuantityAvailable: offers.reduce((s, o) => s + o.stock, 0),
    ProductStatus: { Id: 0, Status: DK_STATUS[first.lifecycle] || '' },
    BackOrderNotAllowed: true,
    NormallyStocking: true,
    Discontinued: first.lifecycle === 'obsolete',
    EndOfLife: first.lifecycle === 'obsolete' || first.lifecycle === 'last_time_buy',
    Ncnr: false,
    ManufacturerLeadWeeks: leadWeeks(offers),
    ManufacturerPublicQuantity: 0,
    Parameters: [],
    OtherNames: [],
  };
}

export const digiKeyLocale = (currency) => ({ Site: 'Central.Parts', Language: 'en', Currency: currency });

// Erreur au format DigiKey.
export const digiKeyError = (status, message) => ({ ErrorResponseVersion: '3.0.0', StatusCode: status, ErrorMessage: message, ErrorDetails: '', RequestId: '' });

// Réponse ProductPricing (GET /products/v4/search/{productNumber}/pricing) : un élément par fabricant, comme sur
// la réponse réelle de DigiKey (ProductPricings[].ProductVariations[].StandardPricing[]).
// excludeMarketplace : sans les offres de broker et de surplus ; inStock : avec du stock seulement.
export function toDigiKeyPricing(mpn, offers, { excludeMarketplace = false, inStock = false, limit = 5, offset = 0 } = {}) {
  const kept = offers.filter((o) => (!excludeMarketplace || o.source_category !== 'broker_surplus') && (!inStock || o.stock > 0));
  const items = groupByManufacturer(kept).map((g) => ({
    ManufacturerProductNumber: mpn,
    Manufacturer: { Id: 0, Name: g[0].manufacturer || '' },
    Description: { ProductDescription: g[0].description || mpn },
    ProductUrl: productUrl(mpn),
    ManufacturerLeadWeeks: leadWeeks(g),
    StandardPackage: standardPackage(g),
    ProductVariations: g.map(digiKeyVariation),
  }));
  return { ProductPricings: items.slice(offset, offset + limit), ProductsCount: items.length };
}

// Réponse KeywordSearch : un produit par fabricant ; la recherche porte sur la référence exacte.
export function toDigiKeyKeyword(mpn, offers, currency, limit = 50, offset = 0) {
  const products = groupByManufacturer(offers).map((g) => toDigiKeyProduct(mpn, g));
  return { Products: products.slice(offset, offset + limit), ProductsCount: products.length, ExactMatches: products.slice(0, 1),
    FilterOptions: {}, SearchLocaleUsed: digiKeyLocale(currency), AppliedParametricFiltersDto: [] };
}

// Format TI store (inventory and pricing) : une offre, la première chiffrée (les offres arrivent triées par prix).
export function toTiProduct(mpn, offers, currency) {
  const o = offers.find((x) => x.price_status === 'priced') || offers[0];
  if (!o) return null;
  // Champs et types de l'exemple de réponse du TI store (vérifiés par tools/test-catalog.mjs) : un texte vide ou 0 plutôt
  // que null quand Central.Parts ne connaît pas la valeur, pour ne pas casser un connecteur typé.
  return {
    tiPartNumber: mpn,
    genericPartNumber: mpn,
    description: o.description || mpn,
    buyNowUrl: productUrl(mpn),
    quantity: o.stock,
    limit: o.stock,
    minimumOrderQuantity: o.moq,
    standardPackQuantity: o.standard_pack_quantity || 0, // « standardPackQuantity », et non « standardPackageQuantity »
    packageType: o.package_case || '',
    packageCarrier: packLabel(o),
    customReel: false,
    lifeCycle: TI_LIFECYCLE[o.lifecycle] || '',
    pinCount: 0,
    exportControlClassificationNumber: o.eccn || '',
    htsCode: o.hts_code || '',
    pricing: o.price_status === 'priced'
      ? [{ currency, priceBreaks: o.price_breaks.map((b) => ({ priceBreakQuantity: b.quantity, price: b.price })) }]
      : [],
    // Aucune prévision de réapprovisionnement chez Central.Parts : liste vide.
    futureInventory: [],
    centralParts: { ...extension(o), otherOffers: offers.filter((x) => x !== o).map(extension) },
  };
}
