// API d'offres en direct (ADR 0024) : formats de réponse (natif, compatible DigiKey, compatible TI) et paramètres.
// Les règles en base (offres publiables, prix, anonymat, compteur) : supabase/checks/17_api_offres.sql ; les routes de
// bout en bout : tools/test-rfq-e2e.mjs. Usage : node tools/test-catalog.mjs
import { readFileSync } from 'node:fs';
import * as C from '../supabase/functions/_shared/catalog.js';

let n = 0, bad = 0;
const ok = (cond, label) => { n++; if (!cond) { bad++; console.log('ÉCHEC ' + label); } };

// Deux offres de la même référence, comme les renvoie catalog_offers (déjà triées par prix).
const offers = [
  { offer_id: 'cpo_aaaaaaaaaaaaaaaaaaaa', mpn: 'NE555DR', manufacturer: 'Texas Instruments', description: 'Minuterie', source_category: 'manufacturer',
    price_status: 'priced', stock: 20000, moq: 1000, order_multiple: 1, currency: 'USD',
    price_breaks: [{ quantity: 1000, price: 0.105 }, { quantity: 10000, price: 0.0945 }], lead_time_days: 10, packaging: 'Bande et bobine',
    ship_from: 'CN', price_valid_until: '2026-11-03T10:00:00Z', datasheet_url: 'https://www.ti.com/lit/ds/symlink/ne555.pdf' },
  { offer_id: 'cpo_bbbbbbbbbbbbbbbbbbbb', mpn: 'NE555DR', manufacturer: 'Texas Instruments', source_category: 'broker_surplus',
    price_status: 'priced', stock: 5000, moq: 100, order_multiple: 1, currency: 'USD',
    price_breaks: [{ quantity: 100, price: 0.22 }, { quantity: 1000, price: 0.198 }], lead_time_days: 3, date_code: '2430', ship_from: 'HK' },
  { offer_id: 'cpo_cccccccccccccccccccc', mpn: 'NE555DR', manufacturer: 'Texas Instruments', source_category: 'authorized_distributor',
    price_status: 'on_request', stock: 300, moq: 1, price_breaks: [], ship_from: 'CN' },
  { offer_id: 'cpo_dddddddddddddddddddd', mpn: 'NE555DR', manufacturer: 'Texas Instruments', source_category: 'broker_surplus',
    price_status: 'priced', stock: 800, moq: 1, currency: 'CNH', price_breaks: [{ quantity: 1, price: 3.3 }], ship_from: 'CN' },
];

// ---------------------------------------------------------------- réponse native → offres à plat
const native = [{ mpn: 'NE555DR', manufacturer: { id: 'MFR-TI', name: 'Texas Instruments' }, description: 'Minuterie', package_case: 'SOIC-8',
  lifecycle: 'nrnd', eccn: 'EAR99', hts_code: '8542390001',
  offers: [{ offer_id: 'cpo_eeeeeeeeeeeeeeeeeeee', source_category: 'manufacturer', price_status: 'priced', stock: 2500, moq: 1, currency: 'USD',
    standard_pack_quantity: 2500, packaging: 'tape_reel', packaging_label: 'Tape & Reel', price_breaks: [{ quantity: 1, unit_price: 0.3 }], ship_from: 'CN' }] }];
const flat = C.flattenProducts(native);
ok(flat.length === 1 && flat[0].manufacturer === 'Texas Instruments' && flat[0].price_breaks[0].price === 0.3 && flat[0].package_case === 'SOIC-8', 'offres à plat : champs du produit repris, paliers unit_price → price');
const fdk = C.toDigiKeyProduct('NE555DR', flat);
ok(fdk.ProductStatus.Status === 'Not For New Designs' && fdk.ProductVariations[0].PackageType.Name === 'Tape & Reel' && fdk.ProductVariations[0].StandardPackage === 2500, 'DigiKey : cycle de vie, conditionnement, bobine complète');
const fti = C.toTiProduct('NE555DR', flat, 'USD');
ok(fti.packageType === 'SOIC-8' && fti.packageCarrier === 'Tape & Reel' && fti.standardPackQuantity === 2500 && fti.lifeCycle === 'NRND' && fti.exportControlClassificationNumber === 'EAR99' && fti.htsCode === '8542390001', 'TI : boîtier, conditionnement, bobine complète, cycle de vie, ECCN, HTS');
ok(C.toTiProduct('NE555DR', [{ ...flat[0], lifecycle: undefined }], 'USD').lifeCycle === '', 'TI : cycle de vie inconnu laissé vide (jamais « ACTIVE » supposé)');

// ---------------------------------------------------------------- paramètres
const q = (s) => C.parseOffersQuery(new URLSearchParams(s));
ok(q('').error && q('').field === 'mpn', 'paramètres : mpn obligatoire');
ok(q('mpn=NE555DR&qty=0').field === 'qty' && q('mpn=NE555DR&qty=1.5').field === 'qty', 'paramètres : quantité entière ≥ 1');
ok(q('mpn=NE555DR&source_category=agree').field === 'source_category', 'paramètres : catégorie inconnue refusée');
const a = q('mpn=NE555DR&qty=2000&currency=EUR&source_category=manufacturer,broker_surplus&manufacturer=TI').args;
ok(a.p_mpn === 'NE555DR' && a.p_qty === 2000 && a.p_currency === 'EUR' && a.p_manufacturer === 'TI' && a.p_sources.length === 2, 'paramètres : lus');

// ---------------------------------------------------------------- devise unique
const usd = C.offersInCurrency(offers, 'USD');
ok(usd.length === 3 && !usd.some((o) => o.currency === 'CNH'), 'devise unique : offres USD et sur demande, CNH écartée');

// ---------------------------------------------------------------- DigiKey
const p = C.toDigiKeyProduct('NE555DR', usd);
ok(p.ManufacturerProductNumber === 'NE555DR' && p.Manufacturer.Name === 'Texas Instruments', 'DigiKey : référence et fabricant');
ok(p.QuantityAvailable === 25300 && p.UnitPrice === 0.105, 'DigiKey : stock total et prix unitaire le plus bas');
ok(p.ProductVariations.length === 3 && p.ProductVariations[0].DigiKeyProductNumber === 'cpo_aaaaaaaaaaaaaaaaaaaa', 'DigiKey : une variante par offre, identifiant opaque');
const v = p.ProductVariations[1];
ok(JSON.stringify(v.StandardPricing) === JSON.stringify([{ BreakQuantity: 100, UnitPrice: 0.22, TotalPrice: 22 }, { BreakQuantity: 1000, UnitPrice: 0.198, TotalPrice: 198 }]), 'DigiKey : paliers BreakQuantity, UnitPrice, TotalPrice');
ok(v.MinimumOrderQuantity === 100 && v.QuantityAvailableforPackageType === 5000, 'DigiKey : MOQ et stock de la variante');
ok(v.MarketPlace === true && p.ProductVariations[0].MarketPlace === false, 'DigiKey : broker et surplus signalés (jamais présentés comme stock distributeur)');
ok(p.ProductVariations.every((x) => x.Supplier.Name === 'Central.Parts'), 'DigiKey : fournisseur toujours Central.Parts');
ok(v.CentralParts.sourceCategory === 'broker_surplus' && v.CentralParts.dateCode === '2430' && v.CentralParts.shipFrom === 'HK', 'DigiKey : extension CentralParts (catégorie, date code, expédition)');
ok(p.ProductVariations[2].StandardPricing.length === 0 && p.ProductVariations[2].CentralParts.priceStatus === 'on_request', 'DigiKey : offre sur demande sans prix');
ok(p.DatasheetUrl === 'https://www.ti.com/lit/ds/symlink/ne555.pdf' && p.ManufacturerLeadWeeks === '1', 'DigiKey : fiche technique, délai en semaines');
const kw = C.toDigiKeyKeyword('NE555DR', usd, 'USD');
ok(kw.ProductsCount === 1 && kw.Products[0].ProductVariations.length === 3 && kw.SearchLocaleUsed.Currency === 'USD', 'DigiKey : KeywordSearch');
const two = C.groupByManufacturer([...usd, { ...usd[0], offer_id: 'cpo_x', manufacturer: 'Onsemi', stock: 10 }]);
ok(two.length === 2 && two[0][0].manufacturer === 'Texas Instruments', 'DigiKey : un produit par fabricant, le plus gros stock d\'abord');
ok(C.digiKeyError(404, 'Product not found').StatusCode === 404, 'DigiKey : erreur au format DigiKey');

// ---------------------------------------------------------------- DigiKey ProductPricing : même structure qu'une réponse réelle
const real = JSON.parse(readFileSync(new URL('./fixtures/digikey-productpricing.json', import.meta.url), 'utf8'));
const pp = C.toDigiKeyPricing('NE555DR', usd);
// Chaque champ de la réponse réelle existe dans la nôtre, avec le même type (objet, tableau, nombre, texte).
const kind = (x) => (Array.isArray(x) ? 'array' : x === null ? 'null' : typeof x);
function sameShape(want, got, path, out) {
  for (const k of Object.keys(want)) {
    if (k.startsWith('_')) continue;
    if (!(k in got)) { out.push(path + k + ' absent'); continue; }
    if (kind(want[k]) !== kind(got[k])) { out.push(path + k + ' : ' + kind(got[k]) + ' au lieu de ' + kind(want[k])); continue; }
    if (kind(want[k]) === 'object') sameShape(want[k], got[k], path + k + '.', out);
    if (kind(want[k]) === 'array' && want[k].length && got[k].length && kind(want[k][0]) === 'object') sameShape(want[k][0], got[k][0], path + k + '[0].', out);
  }
  return out;
}
const diff = sameShape(real, pp, '', []);
ok(!diff.length, 'ProductPricing : mêmes champs et mêmes types que la réponse réelle de DigiKey ' + diff.join(', '));
ok(pp.ProductPricings.length === 1 && pp.ProductPricings[0].ProductVariations.length === 3, 'ProductPricing : un élément par fabricant, une variante par offre');
ok(pp.ProductPricings[0].ProductUrl === 'https://central.parts/recherche/?q=NE555DR', 'ProductPricing : lien vers la recherche Central.Parts, jamais vers le fournisseur');
ok(C.toDigiKeyPricing('NE555DR', usd, { excludeMarketplace: true }).ProductPricings[0].ProductVariations.every((v) => !v.MarketPlace), 'ProductPricing : excludeMarketplace écarte broker et surplus');
ok(C.toDigiKeyPricing('NE555DR', []).ProductPricings.length === 0, 'ProductPricing : aucune offre, liste vide');
ok(!diff.length && sameShape(real.ProductPricings[0].ProductVariations[0], C.toDigiKeyProduct('NE555DR', usd).ProductVariations[0], '', []).length === 0, 'ProductDetails : variantes de même structure');

// ---------------------------------------------------------------- TI
const t = C.toTiProduct('NE555DR', usd, 'USD');
ok(t.tiPartNumber === 'NE555DR' && t.quantity === 20000 && t.minimumOrderQuantity === 1000, 'TI : référence, quantité, minimum');
ok(JSON.stringify(t.pricing) === JSON.stringify([{ currency: 'USD', priceBreaks: [{ priceBreakQuantity: 1000, price: 0.105 }, { priceBreakQuantity: 10000, price: 0.0945 }] }]), 'TI : pricing[].priceBreaks[]');
ok(t.centralParts.offerId === 'cpo_aaaaaaaaaaaaaaaaaaaa' && t.centralParts.otherOffers.length === 2, 'TI : meilleure offre, autres offres en extension');
ok(C.toTiProduct('NE555DR', [], 'USD') === null, 'TI : aucune offre');
const realTi = JSON.parse(readFileSync(new URL('./fixtures/ti-product.json', import.meta.url), 'utf8'));
const tiDiff = sameShape(realTi, t, '', []);
ok(!tiDiff.length, 'TI : mêmes champs et mêmes types que l\'exemple de réponse du TI store ' + tiDiff.join(', '));
ok(t.buyNowUrl === 'https://central.parts/recherche/?q=NE555DR' && !('buyNowURL' in t), 'TI : buyNowUrl vers la recherche Central.Parts');
ok(Array.isArray(t.futureInventory) && t.futureInventory.length === 0, 'TI : aucune prévision de stock annoncée');
ok(C.toTiProduct('NE555DR', [offers[2]], 'USD').pricing.length === 0, 'TI : offre sur demande sans prix');

// ---------------------------------------------------------------- anonymat : aucun champ du fournisseur ne peut sortir
const leaky = offers.map((o) => ({ ...o, seller_id: 'ORG-0101', sku: 'SKU-SECRET', product_url: 'https://fournisseur.example/x', alias: 'V-9' }));
const out = JSON.stringify([C.toDigiKeyProduct('NE555DR', leaky), C.toTiProduct('NE555DR', leaky, 'USD')]);
ok(!/ORG-0101|SKU-SECRET|fournisseur\.example|V-9/.test(out), 'anonymat : les formats compatibles ne recopient aucun champ inconnu');

console.log(`${n - bad}/${n} vérifications réussies`);
process.exit(bad ? 1 : 0);
