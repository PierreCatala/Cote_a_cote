/**
 * sample.mjs — génère des données de démo en quelques secondes
 *
 * Récupère les vraies géométries de communes depuis geo.api.gouv.fr
 * et utilise des données de prix/érosion approximatives pour illustrer
 * toutes les fonctionnalités du site.
 *
 * Usage: node pipeline/sample.mjs
 */

import { writeFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir  = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dir, '../data');

// ── Données de démo ───────────────────────────────────────────
// Environ 30 communes côtières réelles avec données aproximatives.
// price_by_semester: prix médian au m² (€) par semestre observé.
// erosion_rate: recul mesuré en m/an (source Cerema).
// erosion_class: 'fort' | 'moyen' | null (décret 2024).

const SAMPLE = [
  // ── Côte Atlantique SW (Gironde / Landes) ──────────────────
  { code: '33234', nom: 'Lacanau',          dept: '33', erosion_class: 'fort',  erosion_rate: 2.1,
    prices: { '2021-S1': 2800,'2021-S2': 2970,'2022-S1': 3100,'2022-S2': 3200,'2023-S1': 3230,'2023-S2': 3190,'2024-S1': 3170 }, n: 74 },
  { code: '33481', nom: 'Soulac-sur-Mer',   dept: '33', erosion_class: 'fort',  erosion_rate: 1.7,
    prices: { '2021-S1': 2150,'2021-S2': 2280,'2022-S1': 2400,'2022-S2': 2460,'2023-S1': 2440,'2023-S2': 2390,'2024-S1': 2360 }, n: 38 },
  { code: '33339', nom: 'Le Porge',          dept: '33', erosion_class: 'fort',  erosion_rate: 1.4,
    prices: { '2021-S1': 2600,'2021-S2': 2750,'2022-S1': 2900,'2022-S2': 3000,'2023-S1': 2980,'2023-S2': 2940,'2024-S1': 2910 }, n: 22 },
  { code: '33009', nom: 'Arcachon',          dept: '33', erosion_class: null,   erosion_rate: null,
    prices: { '2021-S1': 5200,'2021-S2': 5550,'2022-S1': 5900,'2022-S2': 6150,'2023-S1': 6250,'2023-S2': 6350,'2024-S1': 6480 }, n: 152 },
  { code: '40192', nom: 'Mimizan',           dept: '40', erosion_class: 'moyen', erosion_rate: 0.8,
    prices: { '2021-S1': 2350,'2021-S2': 2500,'2022-S1': 2680,'2022-S2': 2800,'2023-S1': 2870,'2023-S2': 2930,'2024-S1': 2980 }, n: 55 },
  { code: '40149', nom: 'Labenne',           dept: '40', erosion_class: 'moyen', erosion_rate: 0.6,
    prices: { '2021-S1': 3200,'2021-S2': 3400,'2022-S1': 3600,'2022-S2': 3750,'2023-S1': 3800,'2023-S2': 3860,'2024-S1': 3910 }, n: 41 },
  // ── Pays Basque ────────────────────────────────────────────
  { code: '64122', nom: 'Biarritz',          dept: '64', erosion_class: 'moyen', erosion_rate: 0.4,
    prices: { '2021-S1': 5500,'2021-S2': 5850,'2022-S1': 6100,'2022-S2': 6350,'2023-S1': 6180,'2023-S2': 6050,'2024-S1': 5980 }, n: 298 },
  { code: '64024', nom: 'Anglet',            dept: '64', erosion_class: null,   erosion_rate: null,
    prices: { '2021-S1': 4200,'2021-S2': 4500,'2022-S1': 4750,'2022-S2': 4950,'2023-S1': 4980,'2023-S2': 5050,'2024-S1': 5100 }, n: 234 },
  { code: '64483', nom: 'Saint-Jean-de-Luz', dept: '64', erosion_class: null,   erosion_rate: null,
    prices: { '2021-S1': 4800,'2021-S2': 5100,'2022-S1': 5400,'2022-S2': 5650,'2023-S1': 5750,'2023-S2': 5850,'2024-S1': 5950 }, n: 182 },
  // ── Méditerranée ───────────────────────────────────────────
  { code: '06088', nom: 'Nice',              dept: '06', erosion_class: null,   erosion_rate: null,
    prices: { '2021-S1': 4150,'2021-S2': 4380,'2022-S1': 4600,'2022-S2': 4800,'2023-S1': 4850,'2023-S2': 4920,'2024-S1': 4980 }, n: 1320 },
  { code: '06029', nom: 'Cannes',            dept: '06', erosion_class: null,   erosion_rate: null,
    prices: { '2021-S1': 5800,'2021-S2': 6100,'2022-S1': 6450,'2022-S2': 6750,'2023-S1': 6900,'2023-S2': 7050,'2024-S1': 7150 }, n: 690 },
  { code: '34192', nom: 'Palavas-les-Flots', dept: '34', erosion_class: 'fort',  erosion_rate: 1.2,
    prices: { '2021-S1': 3150,'2021-S2': 3300,'2022-S1': 3480,'2022-S2': 3580,'2023-S1': 3530,'2023-S2': 3480,'2024-S1': 3450 }, n: 94 },
  { code: '34003', nom: 'Agde',              dept: '34', erosion_class: 'fort',  erosion_rate: 1.0,
    prices: { '2021-S1': 2550,'2021-S2': 2700,'2022-S1': 2870,'2022-S2': 2950,'2023-S1': 2900,'2023-S2': 2840,'2024-S1': 2800 }, n: 162 },
  { code: '11262', nom: 'Narbonne',          dept: '11', erosion_class: 'fort',  erosion_rate: 0.9,
    prices: { '2021-S1': 1950,'2021-S2': 2050,'2022-S1': 2200,'2022-S2': 2300,'2023-S1': 2280,'2023-S2': 2240,'2024-S1': 2210 }, n: 445 },
  { code: '66149', nom: 'Port-Barcarès',     dept: '66', erosion_class: 'fort',  erosion_rate: 0.7,
    prices: { '2021-S1': 2450,'2021-S2': 2580,'2022-S1': 2720,'2022-S2': 2810,'2023-S1': 2780,'2023-S2': 2730,'2024-S1': 2700 }, n: 82 },
  { code: '83137', nom: 'Saint-Tropez',      dept: '83', erosion_class: null,   erosion_rate: null,
    prices: { '2021-S1': 9200,'2021-S2': 9700,'2022-S1':10200,'2022-S2':10700,'2023-S1':10900,'2023-S2':11100,'2024-S1':11400 }, n: 92 },
  // ── Charente-Maritime ──────────────────────────────────────
  { code: '17300', nom: 'La Rochelle',       dept: '17', erosion_class: null,   erosion_rate: null,
    prices: { '2021-S1': 3500,'2021-S2': 3700,'2022-S1': 3920,'2022-S2': 4100,'2023-S1': 4180,'2023-S2': 4240,'2024-S1': 4290 }, n: 920 },
  { code: '17393', nom: 'Royan',             dept: '17', erosion_class: 'moyen', erosion_rate: 0.5,
    prices: { '2021-S1': 3200,'2021-S2': 3380,'2022-S1': 3600,'2022-S2': 3780,'2023-S1': 3850,'2023-S2': 3910,'2024-S1': 3960 }, n: 172 },
  { code: '17443', nom: 'La Tremblade',      dept: '17', erosion_class: 'moyen', erosion_rate: 0.6,
    prices: { '2021-S1': 2800,'2021-S2': 2950,'2022-S1': 3100,'2022-S2': 3220,'2023-S1': 3260,'2023-S2': 3300,'2024-S1': 3330 }, n: 58 },
  // ── Loire-Atlantique / Vendée ──────────────────────────────
  { code: '44055', nom: 'La Baule-Escoublac',dept: '44', erosion_class: 'moyen', erosion_rate: 0.3,
    prices: { '2021-S1': 4200,'2021-S2': 4500,'2022-S1': 4780,'2022-S2': 5020,'2023-S1': 5120,'2023-S2': 5200,'2024-S1': 5260 }, n: 238 },
  { code: '85194', nom: 'Les Sables-d\'Olonne',dept:'85', erosion_class: null,  erosion_rate: null,
    prices: { '2021-S1': 3450,'2021-S2': 3700,'2022-S1': 3980,'2022-S2': 4200,'2023-S1': 4300,'2023-S2': 4380,'2024-S1': 4440 }, n: 356 },
  // ── Bretagne ───────────────────────────────────────────────
  { code: '35288', nom: 'Saint-Malo',        dept: '35', erosion_class: null,   erosion_rate: null,
    prices: { '2021-S1': 3200,'2021-S2': 3400,'2022-S1': 3620,'2022-S2': 3780,'2023-S1': 3840,'2023-S2': 3900,'2024-S1': 3960 }, n: 468 },
  { code: '35093', nom: 'Dinard',            dept: '35', erosion_class: null,   erosion_rate: null,
    prices: { '2021-S1': 3550,'2021-S2': 3750,'2022-S1': 3980,'2022-S2': 4150,'2023-S1': 4250,'2023-S2': 4330,'2024-S1': 4400 }, n: 138 },
  { code: '56187', nom: 'Quiberon',          dept: '56', erosion_class: 'fort',  erosion_rate: 0.7,
    prices: { '2021-S1': 4500,'2021-S2': 4750,'2022-S1': 5020,'2022-S2': 5220,'2023-S1': 5100,'2023-S2': 5020,'2024-S1': 4980 }, n: 102 },
  { code: '29155', nom: 'Camaret-sur-Mer',   dept: '29', erosion_class: 'moyen', erosion_rate: 0.4,
    prices: { '2021-S1': 2200,'2021-S2': 2320,'2022-S1': 2480,'2022-S2': 2580,'2023-S1': 2640,'2023-S2': 2700,'2024-S1': 2750 }, n: 47 },
  // ── Normandie ─────────────────────────────────────────────
  { code: '14220', nom: 'Deauville',         dept: '14', erosion_class: null,   erosion_rate: null,
    prices: { '2021-S1': 4000,'2021-S2': 4220,'2022-S1': 4450,'2022-S2': 4650,'2023-S1': 4750,'2023-S2': 4820,'2024-S1': 4880 }, n: 184 },
  { code: '76259', nom: 'Étretat',           dept: '76', erosion_class: 'fort',  erosion_rate: 0.3,
    prices: { '2021-S1': 3000,'2021-S2': 3180,'2022-S1': 3380,'2022-S2': 3500,'2023-S1': 3440,'2023-S2': 3400,'2024-S1': 3380 }, n: 58 },
  { code: '76186', nom: 'Dieppe',            dept: '76', erosion_class: 'moyen', erosion_rate: 0.2,
    prices: { '2021-S1': 1900,'2021-S2': 2000,'2022-S1': 2100,'2022-S2': 2200,'2023-S1': 2260,'2023-S2': 2300,'2024-S1': 2330 }, n: 242 },
  // ── Nord / Pas-de-Calais ──────────────────────────────────
  { code: '62826', nom: 'Le Touquet-Paris-Plage', dept: '62', erosion_class: 'moyen', erosion_rate: 0.4,
    prices: { '2021-S1': 4200,'2021-S2': 4480,'2022-S1': 4760,'2022-S2': 4980,'2023-S1': 4880,'2023-S2': 4800,'2024-S1': 4760 }, n: 150 },
  { code: '62893', nom: 'Wimereux',          dept: '62', erosion_class: 'fort',  erosion_rate: 0.8,
    prices: { '2021-S1': 2500,'2021-S2': 2640,'2022-S1': 2800,'2022-S2': 2900,'2023-S1': 2840,'2023-S2': 2790,'2024-S1': 2760 }, n: 70 },
];

// ── Helpers ───────────────────────────────────────────────────
const BEFORE = ['2021-S1','2021-S2','2022-S1','2022-S2'];
const AFTER  = ['2023-S1','2023-S2','2024-S1','2024-S2','2025-S1'];

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a,b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2;
}

function priceDelta(prices) {
  const b = BEFORE.map(k => prices[k]).filter(Boolean);
  const a = AFTER .map(k => prices[k]).filter(Boolean);
  const mb = median(b), ma = median(a);
  if (!mb || !ma) return null;
  return Math.round((ma - mb) / mb * 1000) / 10; // 1 decimal
}

// ── Fetch geometries from geo.api.gouv.fr ────────────────────
async function fetchGeom(codes) {
  // Batch by department to minimize requests
  const byDept = {};
  for (const { code, dept } of codes) {
    (byDept[dept] ??= []).push(code);
  }

  const geomMap = {};
  for (const [dept, deptCodes] of Object.entries(byDept)) {
    const url = `https://geo.api.gouv.fr/communes?codeDepartement=${dept}&fields=code,nom,contour&format=geojson&geometry=contour`;
    process.stdout.write(`  → dept ${dept}… `);
    try {
      const res  = await fetch(url);
      const data = await res.json();
      for (const feat of data.features ?? []) {
        const code = feat.properties?.code;
        if (code && deptCodes.includes(code)) {
          // geo.api.gouv.fr: geometry = centroid, contour = polygon in properties
          geomMap[code] = feat.properties.contour ?? feat.geometry;
        }
      }
      console.log(`OK (${deptCodes.length} communes visées)`);
    } catch (err) {
      console.log(`ERREUR: ${err.message}`);
    }
    // Polite delay
    await new Promise(r => setTimeout(r, 300));
  }
  return geomMap;
}

// ── Build output ─────────────────────────────────────────────
async function build() {
  console.log('\n🌊 Littoral & Immo — Génération des données de démo\n');

  console.log('1/3 Récupération des géométries (geo.api.gouv.fr)…');
  const geomMap = await fetchGeom(SAMPLE.map(d => ({ code: d.code, dept: d.dept })));

  console.log('\n2/3 Construction du GeoJSON…');
  const features = [];
  const scatter  = [];

  for (const d of SAMPLE) {
    const geom = geomMap[d.code];
    if (!geom) {
      console.warn(`  ⚠ géométrie manquante pour ${d.nom} (${d.code})`);
    }

    const delta      = priceDelta(d.prices);
    const allPrices  = Object.values(d.prices).filter(Boolean);
    const priceNow   = d.prices['2024-S1'] ?? d.prices['2023-S2'] ?? median(allPrices);

    features.push({
      type: 'Feature',
      geometry: geom ?? null,
      properties: {
        code_insee:        d.code,
        nom:               d.nom,
        departement:       d.dept,
        erosion_class:     d.erosion_class,
        erosion_rate:      d.erosion_rate,
        price_median_m2:   Math.round(priceNow),
        price_by_semester: d.prices,
        price_delta_pct:   delta,
        n_transactions:    d.n,
      },
    });

    if (d.erosion_rate !== null && delta !== null) {
      scatter.push({
        code_insee:     d.code,
        nom:            d.nom,
        erosion_rate:   d.erosion_rate,
        price_delta_pct: delta,
        erosion_class:  d.erosion_class,
        price_median_m2: Math.round(priceNow),
      });
    }
  }

  const geojson = { type: 'FeatureCollection', features };

  console.log('3/3 Écriture des fichiers…');
  await writeFile(`${outDir}/communes_littorales.geojson`, JSON.stringify(geojson, null, 2));
  await writeFile(`${outDir}/scatter.json`, JSON.stringify(scatter, null, 2));

  console.log(`\n✅ Terminé !`);
  console.log(`   data/communes_littorales.geojson — ${features.length} communes`);
  console.log(`   data/scatter.json               — ${scatter.length} points`);
  console.log(`\nOuvrez index.html dans un serveur local (ex: npx serve .)\n`);
}

build().catch(err => { console.error('\n❌', err.message); process.exit(1); });
