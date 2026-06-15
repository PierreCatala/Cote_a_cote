/**
 * enrich-prices-nodecret.mjs — enrichit les communes de communes_nodecret.geojson
 * qui n'ont pas encore de données de prix (price_by_semester === null) en
 * téléchargeant les DVF (geo-dvf) pour leurs départements uniquement.
 *
 * Complément de build-cerema-communes.mjs : ce script s'exécute après pour
 * ajouter les graphiques de prix aux nouvelles communes.
 *
 * Usage : node pipeline/enrich-prices-nodecret.mjs
 */

import { createGunzip }             from 'zlib';
import { Readable }                 from 'stream';
import { pipeline as pipelineStr }  from 'stream/promises';
import { parse }                    from 'csv-parse';
import { readFile, writeFile }      from 'fs/promises';
import { resolve, dirname }         from 'path';
import { fileURLToPath }            from 'url';

const __dir    = dirname(fileURLToPath(import.meta.url));
const NODECRET = resolve(__dir, '../data/communes_nodecret.geojson');

const SEMESTERS = ['2021-S1','2021-S2','2022-S1','2022-S2','2023-S1','2023-S2','2024-S1','2024-S2','2025-S1','2025-S2'];
const DVF_YEARS = ['2021','2022','2023','2024','2025'];
const DVF_BASE  = 'https://files.data.gouv.fr/geo-dvf/latest/csv';

const delay = ms => new Promise(r => setTimeout(r, ms));

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function dateSem(str) {
  const d = new Date(str);
  return isNaN(d) ? null : `${d.getFullYear()}-${d.getMonth() < 6 ? 'S1' : 'S2'}`;
}

async function main() {
  console.log('\n💶 Enrichissement prix — communes_nodecret sans données foncières\n');

  const ncGjson  = JSON.parse(await readFile(NODECRET, 'utf8'));

  // ── 1. Communes sans données de prix ─────────────────────────
  const toEnrich = ncGjson.features.filter(f => f.properties.price_by_semester === null);
  if (!toEnrich.length) {
    console.log('✅ Toutes les communes ont déjà des données de prix.');
    return;
  }
  const targetCodes = new Set(toEnrich.map(f => f.properties.code_insee));
  const depts = [...new Set(toEnrich.map(f => f.properties.departement))].sort();

  console.log(`  ${toEnrich.length} communes sans prix → départements : ${depts.join(', ')}\n`);

  // ── 2. Téléchargement DVF ─────────────────────────────────────
  // code → Map<sem, number[]>
  const byCommune = new Map();
  const ensure = (code, sem) => {
    if (!byCommune.has(code)) byCommune.set(code, new Map());
    const bySem = byCommune.get(code);
    if (!bySem.has(sem)) bySem.set(sem, []);
    return bySem.get(sem);
  };

  for (const year of DVF_YEARS) {
    for (const dept of depts) {
      const url = `${DVF_BASE}/${year}/departements/${dept}.csv.gz`;
      process.stdout.write(`  ${year}/${dept}… `);
      try {
        const res = await fetch(url);
        if (!res.ok) { console.log(`skip (${res.status})`); continue; }

        let rows = 0;
        const gunzip    = createGunzip();
        const csvStream = parse({
          columns: true, skip_empty_lines: true,
          relax_column_count: true, encoding: 'utf8',
        });

        csvStream.on('data', (row) => {
          const code = row['code_commune'];
          if (!targetCodes.has(code)) return;
          const type = row['type_local'] ?? '';
          if (type !== 'Appartement' && type !== 'Maison') return;
          const surface = parseFloat(row['surface_reelle_bati']);
          const price   = parseFloat((row['valeur_fonciere'] ?? '').replace(',', '.'));
          if (!surface || surface <= 0 || !price || price <= 0) return;
          const ppm2 = price / surface;
          if (ppm2 < 100 || ppm2 > 30000) return;
          const sem = dateSem(row['date_mutation']);
          if (!sem || !SEMESTERS.includes(sem)) return;
          ensure(code, sem).push(ppm2);
          rows++;
        });

        await pipelineStr(Readable.fromWeb(res.body), gunzip, csvStream);
        console.log(`${rows} lignes`);
      } catch (err) {
        console.log(`ERREUR: ${err.message}`);
      }
      await delay(300);
    }
  }

  // ── 3. Application des prix aux communes ─────────────────────
  console.log('\n  Application des données…');
  let withData = 0, noData = 0;

  for (const feat of toEnrich) {
    const code = feat.properties.code_insee;
    const dvf  = byCommune.get(code);
    const bySem = {}, bySemStats = {};

    for (const sem of SEMESTERS) {
      const arr = dvf?.get(sem) ?? [];
      if (arr.length >= 3) {
        const sorted = [...arr].sort((a, b) => a - b);
        bySem[sem]      = Math.round(median(sorted));
        bySemStats[sem] = {
          q1: Math.round(sorted[Math.floor((sorted.length - 1) * 0.25)]),
          q3: Math.round(sorted[Math.floor((sorted.length - 1) * 0.75)]),
          n:  sorted.length,
        };
      }
    }

    const priceVals = Object.values(bySem).filter(Boolean);
    if (priceVals.length) {
      feat.properties.price_by_semester       = bySem;
      feat.properties.price_by_semester_stats = bySemStats;
      feat.properties.price_median_m2         = Math.round(median(priceVals));
      withData++;
      process.stdout.write('.');
    } else {
      // Garder null pour signaler l'absence de données
      noData++;
      process.stdout.write('×');
    }
  }

  console.log(`\n\n  ${withData} communes enrichies avec données DVF`);
  if (noData) console.log(`  ${noData} communes sans transactions enregistrées (zones peu actives)`);

  // ── 4. Sauvegarde ─────────────────────────────────────────────
  await writeFile(NODECRET, JSON.stringify(ncGjson, null, 2), 'utf8');
  console.log('\n✅ communes_nodecret.geojson mis à jour — rechargez le site.\n');
}

main().catch(err => { console.error('\n❌', err.message, '\n', err.stack); process.exit(1); });
