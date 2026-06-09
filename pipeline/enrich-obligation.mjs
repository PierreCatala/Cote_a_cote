/**
 * enrich-obligation.mjs — ajoute obligation_date, decret, vague à chaque commune
 * et recalcule price_delta_pct avec le pivot individuel par commune.
 *
 * Source : CSV data.gouv.fr (liste des communes soumises au décret érosion)
 * Usage  : node pipeline/enrich-obligation.mjs
 */

import https    from 'https';
import { readFile, writeFile } from 'fs/promises';
import { resolve, dirname }   from 'path';
import { fileURLToPath }      from 'url';

const __dir   = dirname(fileURLToPath(import.meta.url));
const GEOJSON = resolve(__dir, '../data/communes_littorales.geojson');
const SCATTER = resolve(__dir, '../data/scatter.json');
const CSV_URL = 'https://static.data.gouv.fr/resources/liste-des-communes-volontaires-pour-sadapter-au-recul-du-trait-de-cote/20260218-105039/trait-de-cote-commune-2026-95.csv';

// ── Table de correspondance décret → obligation ───────────────
// Vague 4 absente des données : seuls 4 décrets existent dans le CSV.
const DECRET_MAP = {
  '2022_750': { vague: 1, obligation_date: '2023-01-01', decret: '2022-750' },
  '2023_698': { vague: 2, obligation_date: '2023-07-31', decret: '2023-698' },
  '2024_531': { vague: 3, obligation_date: '2024-06-10', decret: '2024-531' },
  '2026_95':  { vague: 5, obligation_date: '2026-02-13', decret: '2026-95'  },
};

const SEMESTERS = ['2021-S1','2021-S2','2022-S1','2022-S2','2023-S1','2023-S2','2024-S1','2024-S2','2025-S1','2025-S2'];

// ── Helpers ───────────────────────────────────────────────────
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Retourne le semestre contenant une date ISO
function dateToSemester(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth() < 6 ? 'S1' : 'S2'}`;
}

// Divise les prix par semestre en avant/après pivot
function splitByObligation(bySem, obligationDate) {
  const pivot    = dateToSemester(obligationDate);
  const pivotIdx = SEMESTERS.indexOf(pivot);

  // obligation_date dans un semestre hors de notre fenêtre → tout est "avant"
  if (pivotIdx < 0) {
    const before = SEMESTERS.map(s => bySem[s]).filter(Boolean);
    return { before, after: [], pivotSem: pivot };
  }

  const before = SEMESTERS.slice(0, pivotIdx).map(s => bySem[s]).filter(Boolean);
  const after  = SEMESTERS.slice(pivotIdx).map(s => bySem[s]).filter(Boolean);
  return { before, after, pivotSem: pivot };
}

// ── Étape 1 — Télécharger et parser le CSV ────────────────────
async function fetchDecreeMap() {
  console.log('── Étape 1 : Téléchargement du CSV décrets ──');
  const text = await new Promise((res, rej) => {
    https.get(CSV_URL, r => {
      let data = '';
      r.on('data', d => data += d);
      r.on('end', () => res(data));
    }).on('error', rej);
  });

  // Map<codeInsee, { vague, obligation_date, decret }>
  const result = new Map();

  for (const line of text.trim().split('\n').slice(1)) {
    // CSV: code_commune,nom_commune,...,trait_de_cote_historique
    const codeMatch = line.match(/^(\d{5})/);
    if (!codeMatch) continue;
    const code = codeMatch[1];

    // Extraire tous les numéros de décret depuis le champ historique
    const decretNums = [...line.matchAll(/'numero_decret':\s*'([^']+)'/g)]
      .map(m => m[1]);

    // Extraire les start_date correspondantes
    const startDates = [...line.matchAll(/'start_date':\s*'([^']+)'/g)]
      .map(m => m[1]);

    if (!decretNums.length) continue;

    // Trouver le premier décret (date de début la plus ancienne)
    let earliest = null;
    for (let i = 0; i < decretNums.length; i++) {
      const num  = decretNums[i];
      const date = startDates[i];
      if (!DECRET_MAP[num]) continue;
      if (!earliest || date < earliest.startDate) {
        earliest = { num, startDate: date };
      }
    }

    if (earliest) result.set(code, DECRET_MAP[earliest.num]);
  }

  console.log(`  ✅ ${result.size} communes avec décret identifié`);
  return result;
}

// ── Étape 2 — Enrichir le GeoJSON ────────────────────────────
async function enrichGeoJSON(decreeMap) {
  console.log('\n── Étape 2 : Enrichissement du GeoJSON ──');
  const raw   = await readFile(GEOJSON, 'utf8');
  const gjson = JSON.parse(raw);

  let matched = 0, unmatched = 0;

  for (const feat of gjson.features) {
    const code = feat.properties.code_insee;
    const info = decreeMap.get(code);

    if (!info) {
      feat.properties.obligation_date = null;
      feat.properties.decret          = null;
      feat.properties.vague           = null;
      unmatched++;
      continue;
    }

    feat.properties.obligation_date = info.obligation_date;
    feat.properties.decret          = info.decret;
    feat.properties.vague           = info.vague;
    matched++;

    // Recalculer price_delta_pct avec le pivot individuel
    const bySem = feat.properties.price_by_semester ?? {};
    if (typeof bySem === 'string') {
      feat.properties.price_by_semester = JSON.parse(bySem);
    }
    const { before, after } = splitByObligation(
      feat.properties.price_by_semester,
      info.obligation_date,
    );
    const mb = median(before), ma = median(after);
    feat.properties.price_delta_pct = (mb && ma)
      ? Math.round((ma - mb) / mb * 1000) / 10
      : null;
  }

  console.log(`  ${matched} communes enrichies, ${unmatched} sans décret`);
  await writeFile(GEOJSON, JSON.stringify(gjson, null, 2));
  return gjson;
}

// ── Étape 3 — Reconstruire scatter.json ──────────────────────
async function rebuildScatter(gjson) {
  console.log('\n── Étape 3 : Reconstruction du scatter ──');
  const scatter = [];

  for (const feat of gjson.features) {
    const p = feat.properties;
    if (!p.erosion_rate || p.obligation_date === null) continue;

    const bySem = typeof p.price_by_semester === 'string'
      ? JSON.parse(p.price_by_semester)
      : (p.price_by_semester ?? {});

    const { before, after } = splitByObligation(bySem, p.obligation_date);

    // Seuil de qualité : au moins 2 semestres de données de chaque côté
    const quality = (before.length >= 2 && after.length >= 2)
      ? 'ok'
      : 'insufficient';

    if (p.price_delta_pct === null && quality === 'ok') continue;

    scatter.push({
      code_insee:      p.code_insee,
      nom:             p.nom,
      erosion_rate:    p.erosion_rate,
      price_delta_pct: p.price_delta_pct,
      erosion_class:   p.erosion_class,
      price_median_m2: p.price_median_m2,
      obligation_date: p.obligation_date,
      decret:          p.decret,
      vague:           p.vague,
      data_quality:    quality,
    });
  }

  const ok           = scatter.filter(d => d.data_quality === 'ok').length;
  const insufficient = scatter.filter(d => d.data_quality === 'insufficient').length;
  console.log(`  ${scatter.length} points total (${ok} ok, ${insufficient} données insuffisantes)`);

  await writeFile(SCATTER, JSON.stringify(scatter, null, 2));
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  console.log('\n🌊 Enrichissement — dates d\'obligation par commune\n');
  const decreeMap = await fetchDecreeMap();
  const gjson     = await enrichGeoJSON(decreeMap);
  await rebuildScatter(gjson);
  console.log('\n✅ Terminé ! Rechargez le site.\n');
}

main().catch(err => { console.error('\n❌', err); process.exit(1); });
