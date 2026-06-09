/**
 * fetch.mjs — pipeline de données complet (production)
 *
 * Télécharge et agrège les données réelles depuis les sources officielles :
 *   - Décret érosion 2024 (data.gouv.fr / Cerema)
 *   - DVF géolocalisées par département côtier (files.data.gouv.fr)
 *   - Géométries de communes (geo.api.gouv.fr)
 *
 * Durée estimée : 30–90 min selon la connexion (téléchargement des CSVs DVF)
 * Nécessite Node.js 18+ et : npm install (dans ce dossier)
 *
 * Usage: node pipeline/fetch.mjs
 */

import { createGunzip }    from 'zlib';
import { Readable }        from 'stream';
import { pipeline }        from 'stream/promises';
import { parse }           from 'csv-parse';
import { writeFile, mkdir } from 'fs/promises';
import { createWriteStream } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath }    from 'url';

const __dir  = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dir, '../data');
await mkdir(outDir, { recursive: true });

// ── Constantes ────────────────────────────────────────────────

// Départements côtiers métropolitains
const COASTAL_DEPTS = [
  '06','11','13','14','17','22','29','30','33','34',
  '35','40','44','50','56','59','62','64','66','76',
  '80','83','85','2A','2B',
];

// Années DVF à télécharger (geo-dvf disponible à partir de 2021)
const DVF_YEARS = ['2021','2022','2023','2024','2025'];

const DVF_BASE = 'https://files.data.gouv.fr/geo-dvf/latest/csv';
const GEO_API  = 'https://geo.api.gouv.fr';

// Semesters
const SEMESTERS = ['2021-S1','2021-S2','2022-S1','2022-S2','2023-S1','2023-S2','2024-S1','2024-S2','2025-S1','2025-S2'];
const BEFORE    = new Set(['2021-S1','2021-S2','2022-S1','2022-S2']);

// ── Helpers ───────────────────────────────────────────────────
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function dateSemester(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  const y = d.getFullYear();
  const s = d.getMonth() < 6 ? 'S1' : 'S2';
  return `${y}-${s}`;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// Taux de recul connus (source Cerema, m/an) pour les communes les plus documentées
const KNOWN_EROSION_RATES = {
  '33234': 2.1, '33481': 1.7, '33339': 1.4, '40192': 0.8, '40149': 0.6,
  '64122': 0.4, '34192': 1.2, '34003': 1.0, '11262': 0.9, '66149': 0.7,
  '17393': 0.5, '17443': 0.6, '44055': 0.3, '56187': 0.7, '29155': 0.4,
  '76259': 0.3, '76186': 0.2, '62826': 0.4, '62893': 0.8, '14220': 0.2,
};

// ── Étape 1 — Décret érosion (data.gouv.fr) ──────────────────
/**
 * Retourne Map<codeInsee, { class: 'fort', rate: number|null }>
 *
 * Source : CSV des communes soumises à l'obligation d'information
 * sur le recul du trait de côte (loi Climat & Résilience).
 * Toutes les communes listées sont en "forte exposition" (recul < 30 ans).
 * Les taux de recul (m/an) viennent de KNOWN_EROSION_RATES.
 */
async function fetchErosionDecree() {
  console.log('\n── Étape 1 : Décret érosion (data.gouv.fr) ──');

  const URL = 'https://static.data.gouv.fr/resources/liste-des-communes-volontaires-pour-sadapter-au-recul-du-trait-de-cote/20260218-105039/trait-de-cote-commune-2026-95.csv';

  try {
    const res = await fetch(URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();

    const lines  = text.trim().split('\n');
    const header = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
    const colCode = header.indexOf('code_commune');

    if (colCode < 0) throw new Error('Colonne code_commune introuvable');

    const result = new Map();
    for (const line of lines.slice(1)) {
      const cells = line.split(',');
      const code  = cells[colCode]?.trim().replace(/"/g, '').padStart(5, '0');
      if (!code || code.length < 5) continue;
      result.set(code, {
        class: 'fort',
        rate:  KNOWN_EROSION_RATES[code] ?? null,
      });
    }

    console.log(`  ✅ ${result.size} communes chargées`);
    return result;
  } catch (err) {
    console.warn(`  ⚠  Décret érosion inaccessible : ${err.message}`);
    return new Map();
  }
}

// ── Étape 2 — Géométries de communes ─────────────────────────
async function fetchGeometries(coastalCodes) {
  console.log(`\n── Étape 2 : Géométries (${coastalCodes.size} communes) ──`);

  const geomMap = {};
  const nomMap  = {};

  for (const dept of COASTAL_DEPTS) {
    process.stdout.write(`  dept ${dept}… `);
    try {
      const url = `${GEO_API}/communes?codeDepartement=${dept}&fields=code,nom,contour&format=geojson&geometry=contour`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      let kept = 0;
      for (const feat of data.features ?? []) {
        const code = feat.properties?.code;
        if (code && coastalCodes.has(code)) {
          // geo.api.gouv.fr: geometry = centroid, contour = polygon in properties
          geomMap[code] = feat.properties.contour ?? feat.geometry;
          nomMap[code]  = feat.properties.nom;
          kept++;
        }
      }
      console.log(`${kept} communes côtières`);
    } catch (err) {
      console.log(`ERREUR: ${err.message}`);
    }
    await delay(250);
  }
  return { geomMap, nomMap };
}

// ── Étape 3 — DVF ─────────────────────────────────────────────
/**
 * Retourne Map<codeInsee, Map<semester, number[]>>  (prix au m²)
 */
async function fetchDVF(coastalCodes) {
  console.log(`\n── Étape 3 : DVF (${DVF_YEARS.join(', ')}) ──`);

  // Map<code, Map<semester, number[]>>
  const byCommune = new Map();
  const ensure = (code, sem) => {
    if (!byCommune.has(code)) byCommune.set(code, new Map());
    const m = byCommune.get(code);
    if (!m.has(sem)) m.set(sem, []);
    return m.get(sem);
  };

  for (const year of DVF_YEARS) {
    for (const dept of COASTAL_DEPTS) {
      const url = `${DVF_BASE}/${year}/departements/${dept}.csv.gz`;
      process.stdout.write(`  ${year}/${dept}… `);

      try {
        const res = await fetch(url);
        if (!res.ok) { console.log(`skip (${res.status})`); continue; }

        // Stream: HTTP body → gunzip → CSV parse
        let rows = 0;
        const gunzip = createGunzip();

        const csvStream = parse({
          columns:       true,
          skip_empty_lines: true,
          relax_column_count: true,
          encoding:      'utf8',
        });

        csvStream.on('data', (row) => {
          const code = row['code_commune'];
          if (!coastalCodes.has(code)) return;

          const type = row['type_local'] ?? '';
          if (type !== 'Appartement' && type !== 'Maison') return;

          const surface = parseFloat(row['surface_reelle_bati']);
          const price   = parseFloat((row['valeur_fonciere'] ?? '').replace(',', '.'));
          if (!surface || surface <= 0 || !price || price <= 0) return;

          const ppm2 = price / surface;
          // Sanity check: 100 – 30 000 €/m²
          if (ppm2 < 100 || ppm2 > 30000) return;

          const sem = dateSemester(row['date_mutation']);
          if (!sem || !SEMESTERS.includes(sem)) return;

          ensure(code, sem).push(ppm2);
          rows++;
        });

        // Pipe the response body through gunzip → csv
        await pipeline(
          Readable.fromWeb(res.body),
          gunzip,
          csvStream,
        );

        console.log(`${rows} lignes`);
      } catch (err) {
        console.log(`ERREUR: ${err.message}`);
      }

      await delay(500); // avoid hammering the server
    }
  }

  return byCommune;
}

// ── Étape 4 — Assemblage ──────────────────────────────────────
function assemble({ erosionMap, geomMap, nomMap, dvfMap }) {
  const features = [];
  const scatter  = [];

  // Union of all commune codes that have either geometry or DVF data
  const allCodes = new Set([...Object.keys(geomMap), ...dvfMap.keys()]);

  for (const code of allCodes) {
    const nom  = nomMap[code] ?? code;
    const geom = geomMap[code] ?? null;
    const ero  = erosionMap.get(code) ?? null;
    const dvf  = dvfMap.get(code);

    // Build semester prices + distribution stats (q1, q3, n) pour IC médiane
    const bySem = {}, bySemStats = {};
    let   hasData = false;
    for (const sem of SEMESTERS) {
      const arr = dvf?.get(sem) ?? [];
      if (arr.length >= 3) { // require at least 3 transactions
        const sorted = [...arr].sort((a,b) => a-b);
        bySem[sem] = Math.round(median(sorted));
        bySemStats[sem] = {
          q1: Math.round(sorted[Math.floor((sorted.length-1) * 0.25)]),
          q3: Math.round(sorted[Math.floor((sorted.length-1) * 0.75)]),
          n:  sorted.length,
        };
        hasData = true;
      }
    }

    if (!hasData && !ero) continue; // skip communes with no data at all

    const priceVals = Object.values(bySem).filter(Boolean);
    const priceMed  = priceVals.length ? Math.round(median(priceVals)) : 0;

    // Before / after delta
    const before = SEMESTERS.filter(s => BEFORE.has(s)).map(s => bySem[s]).filter(Boolean);
    const after  = SEMESTERS.filter(s => !BEFORE.has(s)).map(s => bySem[s]).filter(Boolean);
    const mb = median(before), ma = median(after);
    const delta = (mb && ma) ? Math.round((ma - mb) / mb * 1000) / 10 : null;

    features.push({
      type: 'Feature',
      geometry: geom,
      properties: {
        code_insee:        code,
        nom,
        departement:       code.slice(0, 2),
        erosion_class:     ero?.class  ?? null,
        erosion_rate:      ero?.rate   ?? null,
        price_median_m2:   priceMed,
        price_by_semester:       bySem,
        price_by_semester_stats: bySemStats,
        price_delta_pct:         delta,
        n_transactions:    [...(dvf?.values() ?? [])].flat().length,
      },
    });

    if (ero?.rate && delta !== null) {
      scatter.push({
        code_insee:      code,
        nom,
        erosion_rate:    ero.rate,
        price_delta_pct: delta,
        erosion_class:   ero.class,
        price_median_m2: priceMed,
      });
    }
  }

  return { features, scatter };
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  console.log('\n🌊 Littoral & Immo — Pipeline de données complet\n');
  console.log('Ce processus peut prendre 30 à 90 minutes.\n');

  const erosionMap = await fetchErosionDecree();
  const coastalCodes = new Set(erosionMap.keys());

  if (coastalCodes.size === 0) {
    console.error('❌ Aucune commune chargée depuis le décret érosion. Abandon.');
    process.exit(1);
  }

  console.log(`\n  → ${coastalCodes.size} communes à traiter`);

  const { geomMap, nomMap } = await fetchGeometries(coastalCodes);
  const dvfMap = await fetchDVF(coastalCodes);

  console.log(`\n── Étape 4 : Assemblage ──`);
  const { features, scatter } = assemble({
    erosionMap,
    geomMap,
    nomMap,
    dvfMap,
  });

  await writeFile(`${outDir}/communes_littorales.geojson`, JSON.stringify({ type: 'FeatureCollection', features }, null, 2));
  await writeFile(`${outDir}/scatter.json`, JSON.stringify(scatter, null, 2));

  console.log(`\n✅ Pipeline terminé !`);
  console.log(`   communes_littorales.geojson : ${features.length} communes`);
  console.log(`   scatter.json               : ${scatter.length} points\n`);
}

main().catch(err => { console.error('\n❌', err); process.exit(1); });
