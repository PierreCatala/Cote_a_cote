/**
 * fix-marseille-dvf.mjs — re-fetch tous les millésimes DVF pour Marseille.
 *
 * Problème : le DVF indexe les transactions de Marseille sous les codes
 * d'arrondissement (13201-13216), pas sous 13055. Ce script agrège ces
 * transactions sous 13055 et met à jour communes_littorales.geojson.
 *
 * Usage : node pipeline/fix-marseille-dvf.mjs
 */

import { createGunzip }        from 'zlib';
import { Readable }            from 'stream';
import { pipeline }            from 'stream/promises';
import { parse }               from 'csv-parse';
import { readFile, writeFile } from 'fs/promises';
import { resolve, dirname }    from 'path';
import { fileURLToPath }       from 'url';

const __dir  = dirname(fileURLToPath(import.meta.url));
const GEOJSON = resolve(__dir, '../data/communes_littorales.geojson');

const DVF_BASE = 'https://files.data.gouv.fr/geo-dvf/latest/csv';
const YEARS    = [2021, 2022, 2023, 2024, 2025];
const SEMESTERS = ['2021-S1','2021-S2','2022-S1','2022-S2','2023-S1','2023-S2',
                   '2024-S1','2024-S2','2025-S1','2025-S2'];

// Codes arrondissements Marseille → 13055
const MARSEILLE_ARRS = new Set(
  Array.from({ length: 16 }, (_, i) => `${13201 + i}`)
);

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

console.log('\nFix Marseille DVF — tous millésimes\n');

// ── 1. Collecter les transactions par semestre ────────────────
const bySem = {}; // sem → number[]

for (const year of YEARS) {
  const url = `${DVF_BASE}/${year}/departements/13.csv.gz`;
  process.stdout.write(`  ${year}/13… `);
  try {
    const res = await fetch(url);
    if (!res.ok) { console.log(`skip (${res.status})`); continue; }

    let rows = 0;
    const gunzip    = createGunzip();
    const csvStream = parse({ columns: true, skip_empty_lines: true,
                              relax_column_count: true, encoding: 'utf8' });

    csvStream.on('data', (row) => {
      if (!MARSEILLE_ARRS.has(row['code_commune'])) return;

      const type = row['type_local'] ?? '';
      if (type !== 'Appartement' && type !== 'Maison') return;

      const surface = parseFloat(row['surface_reelle_bati']);
      const price   = parseFloat((row['valeur_fonciere'] ?? '').replace(',', '.'));
      if (!surface || surface <= 0 || !price || price <= 0) return;

      const ppm2 = price / surface;
      if (ppm2 < 100 || ppm2 > 30000) return;

      const d = new Date(row['date_mutation']);
      if (isNaN(d)) return;
      const sem = dateToSem(row['date_mutation']);
      if (!SEMESTERS.includes(sem)) return;

      if (!bySem[sem]) bySem[sem] = [];
      bySem[sem].push(ppm2);
      rows++;
    });

    await pipeline(Readable.fromWeb(res.body), gunzip, csvStream);
    console.log(`${rows} transactions`);
  } catch (err) {
    console.log(`ERREUR: ${err.message}`);
  }
  await delay(400);
}

// ── 2. Calculer médiane / stats par semestre ──────────────────
const pricesBySem = {}, statsBySem = {};
let totalTx = 0;

for (const sem of SEMESTERS) {
  const arr = bySem[sem] ?? [];
  if (arr.length < 3) continue;
  const sorted = [...arr].sort((a, b) => a - b);
  pricesBySem[sem] = Math.round(median(sorted));
  statsBySem[sem]  = {
    q1: Math.round(sorted[Math.floor((sorted.length - 1) * 0.25)]),
    q3: Math.round(sorted[Math.floor((sorted.length - 1) * 0.75)]),
    n:  sorted.length,
  };
  totalTx += sorted.length;
  console.log(`  ${sem} : médiane ${pricesBySem[sem]} €/m² (n=${sorted.length})`);
}

// ── 3. Mettre à jour communes_littorales.geojson ─────────────
const gjson = JSON.parse(await readFile(GEOJSON, 'utf8'));
const feat  = gjson.features.find(f => f.properties.code_insee === '13055');

if (!feat) {
  console.error('\nMarseille (13055) introuvable dans le GeoJSON.');
  process.exit(1);
}

const p = feat.properties;
p.price_by_semester       = pricesBySem;
p.price_by_semester_stats = statsBySem;
p.n_transactions          = totalTx;

const allPrices = Object.values(pricesBySem);
p.price_median_m2 = allPrices.length ? Math.round(median(allPrices)) : 0;

await writeFile(GEOJSON, JSON.stringify(gjson, null, 2));
console.log(`\nMarseille mise à jour : ${p.price_median_m2} €/m² (${totalTx} transactions, ${Object.keys(pricesBySem).length} semestres)\n`);
