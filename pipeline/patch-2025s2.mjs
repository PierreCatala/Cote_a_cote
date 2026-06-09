/**
 * patch-2025s2.mjs — ajoute 2025-S2 au GeoJSON existant sans relancer fetch.mjs.
 * Télécharge uniquement les fichiers DVF 2025 (25 depts) et patche price_by_semester.
 * Durée estimée : 3–8 minutes.
 *
 * Usage: node pipeline/patch-2025s2.mjs
 */

import { createGunzip }     from 'zlib';
import { Readable }         from 'stream';
import { pipeline }         from 'stream/promises';
import { parse }            from 'csv-parse';
import { readFile, writeFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath }    from 'url';

const __dir  = dirname(fileURLToPath(import.meta.url));
const GEOJSON = resolve(__dir, '../data/communes_littorales.geojson');

const COASTAL_DEPTS = [
  '06','11','13','14','17','22','29','30','33','34',
  '35','40','44','50','56','59','62','64','66','76',
  '80','83','85','2A','2B',
];
const DVF_BASE = 'https://files.data.gouv.fr/geo-dvf/latest/csv';
const SEMESTERS = ['2021-S1','2021-S2','2022-S1','2022-S2','2023-S1','2023-S2','2024-S1','2024-S2','2025-S1','2025-S2'];
const delay = ms => new Promise(r => setTimeout(r, ms));

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function dateToSem(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth() < 6 ? 'S1' : 'S2'}`;
}

function splitByObligation(bySem, obligationDate) {
  const pivot    = dateToSem(obligationDate);
  const pivotIdx = SEMESTERS.indexOf(pivot);
  if (pivotIdx < 0) {
    const before = SEMESTERS.map(s => bySem[s]).filter(Boolean);
    return { before, after: [] };
  }
  const before = SEMESTERS.slice(0, pivotIdx).map(s => bySem[s]).filter(Boolean);
  const after  = SEMESTERS.slice(pivotIdx).map(s => bySem[s]).filter(Boolean);
  return { before, after };
}

// ── 1. Lire le GeoJSON existant ───────────────────────────────
console.log('\n🌊 Patch 2025-S2\n');
const gjson = JSON.parse(await readFile(GEOJSON, 'utf8'));

// Set des codes communes présents
const coastalCodes = new Set(gjson.features.map(f => f.properties.code_insee));
console.log(`  ${coastalCodes.size} communes chargées depuis le GeoJSON`);

// ── 2. Télécharger DVF 2025 et extraire S2 uniquement ─────────
console.log('\n── Téléchargement DVF 2025 (S2 uniquement) ──');
const s2Data = new Map(); // code_insee → number[]

for (const dept of COASTAL_DEPTS) {
  const url = `${DVF_BASE}/2025/departements/${dept}.csv.gz`;
  process.stdout.write(`  2025/${dept}… `);
  try {
    const res = await fetch(url);
    if (!res.ok) { console.log(`skip (${res.status})`); continue; }

    let rows = 0;
    const gunzip    = createGunzip();
    const csvStream = parse({ columns: true, skip_empty_lines: true, relax_column_count: true, encoding: 'utf8' });

    csvStream.on('data', (row) => {
      const code = row['code_commune'];
      if (!coastalCodes.has(code)) return;

      const type = row['type_local'] ?? '';
      if (type !== 'Appartement' && type !== 'Maison') return;

      const surface = parseFloat(row['surface_reelle_bati']);
      const price   = parseFloat((row['valeur_fonciere'] ?? '').replace(',', '.'));
      if (!surface || surface <= 0 || !price || price <= 0) return;

      const ppm2 = price / surface;
      if (ppm2 < 100 || ppm2 > 30000) return;

      // On ne garde que S2 (juillet–décembre)
      const d = new Date(row['date_mutation']);
      if (isNaN(d) || d.getMonth() < 6) return;

      if (!s2Data.has(code)) s2Data.set(code, []);
      s2Data.get(code).push(ppm2);
      rows++;
    });

    await pipeline(Readable.fromWeb(res.body), gunzip, csvStream);
    console.log(`${rows} lignes S2`);
  } catch (err) {
    console.log(`ERREUR: ${err.message}`);
  }
  await delay(400);
}

// ── 3. Patcher le GeoJSON ─────────────────────────────────────
console.log('\n── Mise à jour du GeoJSON ──');
let patched = 0;

for (const feat of gjson.features) {
  const p    = feat.properties;
  const code = p.code_insee;
  const arr  = s2Data.get(code);
  if (!arr || arr.length < 3) continue;  // pas assez de transactions

  const sorted = [...arr].sort((a, b) => a - b);
  const med = Math.round(median(sorted));
  const q1  = Math.round(sorted[Math.floor((sorted.length - 1) * 0.25)]);
  const q3  = Math.round(sorted[Math.floor((sorted.length - 1) * 0.75)]);

  const bySem = typeof p.price_by_semester === 'string'
    ? JSON.parse(p.price_by_semester)
    : (p.price_by_semester ?? {});
  const bySemStats = typeof p.price_by_semester_stats === 'string'
    ? JSON.parse(p.price_by_semester_stats)
    : (p.price_by_semester_stats ?? {});

  bySem['2025-S2']      = med;
  bySemStats['2025-S2'] = { q1, q3, n: sorted.length };

  p.price_by_semester       = bySem;
  p.price_by_semester_stats = bySemStats;

  // Recalculer price_delta_pct si la commune a une obligation_date
  if (p.obligation_date) {
    const { before, after } = splitByObligation(bySem, p.obligation_date);
    const mb = median(before), ma = median(after);
    p.price_delta_pct = (mb && ma) ? Math.round((ma - mb) / mb * 1000) / 10 : null;
  }

  // Recalculer price_median_m2 (médiane globale)
  const allPrices = SEMESTERS.map(s => bySem[s]).filter(Boolean);
  if (allPrices.length) p.price_median_m2 = Math.round(median(allPrices));

  patched++;
}

console.log(`  ${patched} communes enrichies avec 2025-S2`);

// ── 4. Écrire ─────────────────────────────────────────────────
await writeFile(GEOJSON, JSON.stringify(gjson, null, 2));
console.log('\n✅ Patch terminé ! Rechargez le site.\n');
