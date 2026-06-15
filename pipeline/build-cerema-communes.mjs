/**
 * build-cerema-communes.mjs — détecte les communes avec recul du trait de côte
 * d'après le shapefile Cerema (taux < 0) et les ajoute à communes_nodecret.geojson
 * si elles n'y figurent pas encore.
 *
 * Pour les communes déjà connues (décret + nodecret) :
 *   - met à jour erosion_rate → moyenne des taux négatifs (et non plus médiane)
 *   - ajoute taux_segments = nombre de tronçons Cerema mesurés avec taux < 0
 *
 * Met également à jour coastal_arcs.geojson (erosion_rate, taux_segments)
 * et reconstruit scatter.json.
 *
 * Usage : node pipeline/build-cerema-communes.mjs
 */

import shapefile from 'shapefile';
import proj4     from 'proj4';
import * as turf from '@turf/turf';
import { readFile, writeFile } from 'fs/promises';
import { resolve, dirname }    from 'path';
import { fileURLToPath }       from 'url';

const __dir      = dirname(fileURLToPath(import.meta.url));
const SHP        = resolve(__dir, 'erosion_shp/N_evolution_trait_cote_fr_epsg2154_S.shp');
const GEOJSON    = resolve(__dir, '../data/communes_littorales.geojson');
const NODECRET   = resolve(__dir, '../data/communes_nodecret.geojson');
const COASTAL_ARCS = resolve(__dir, '../data/coastal_arcs.geojson');
const SCATTER    = resolve(__dir, '../data/scatter.json');
const ALL_COMMUNES_CACHE = resolve(__dir, 'all_communes_cache.json');

const L93 = '+proj=lcc +lat_1=49 +lat_2=44 +lat_0=46.5 +lon_0=3 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';
proj4.defs('EPSG:2154', L93);
const toWGS84 = proj4('EPSG:2154', 'WGS84');

function reprojCoords(c) {
  if (!Array.isArray(c)) return c;
  if (typeof c[0] === 'number') return toWGS84.forward(c);
  return c.map(reprojCoords);
}
function reprojGeom(g) { return g ? { ...g, coordinates: reprojCoords(g.coordinates) } : null; }

function meanOf(arr) {
  if (!arr.length) return null;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function classifyTaux(taux) {
  if (taux == null) return null;
  if (taux < -1.5) return 'fort';
  if (taux < 0)    return 'moyen';
  return null;
}

function deptFromCode(code) {
  return code.slice(0, 2); // '64', '2A', '2B', etc.
}

async function fetchNom(code) {
  try {
    const res = await fetch(`https://geo.api.gouv.fr/communes/${code}?fields=nom`);
    if (res.ok) { const d = await res.json(); return d.nom ?? code; }
  } catch { /* réseau indisponible */ }
  return code;
}

async function main() {
  console.log('\n🌊 Build communes Cerema — détection recul (taux < 0)\n');

  // ── 1. Charger uniquement les segments Cerema en recul ────────
  console.log('Chargement shapefile Cerema (taux < 0 uniquement)…');
  const src = await shapefile.open(SHP);
  const erosionSegs = [];
  while (true) {
    const { value, done } = await src.read();
    if (done) break;
    const taux = value.properties?.taux;
    // -9999 = valeur sentinelle "non mesuré"
    if (!taux || taux >= 0 || taux === -9999) continue;
    const g = reprojGeom(value.geometry);
    if (!g) continue;
    erosionSegs.push({ taux, geom: g, bbox: turf.bbox({ type: 'Feature', geometry: g }) });
  }
  console.log(`  ${erosionSegs.length} segments avec recul réel\n`);

  // ── 2. Charger les fichiers existants ─────────────────────────
  const gjson        = JSON.parse(await readFile(GEOJSON, 'utf8'));
  const ncGjson      = JSON.parse(await readFile(NODECRET, 'utf8'));
  const arcsGjson    = JSON.parse(await readFile(COASTAL_ARCS, 'utf8'));
  const allCommunes  = JSON.parse(await readFile(ALL_COMMUNES_CACHE, 'utf8'));

  const litMap  = new Map(gjson.features.map(f => [f.properties.code_insee, f]));
  const ncMap   = new Map(ncGjson.features.map(f => [f.properties.code_insee, f]));
  const cacheMap = new Map(allCommunes.map(c => [c.code, c]));
  const arcsMap  = new Map(arcsGjson.features.map(f => [f.properties.code_insee, f]));

  // Map nom pour les communes déjà connues
  const nomMap = new Map();
  for (const f of [...gjson.features, ...ncGjson.features])
    nomMap.set(f.properties.code_insee, f.properties.nom);

  // ── 3. Spatial join : commune → segments d'érosion ───────────
  console.log('Analyse spatiale…\n');

  // code → { tauxValues: number[], meanTaux, erosionRate, taux_segments, erosion_class }
  const communeErosion = new Map();

  for (const commune of allCommunes) {
    const [minLon, minLat, maxLon, maxLat] = commune.bbox;

    const candidates = erosionSegs.filter(s =>
      s.bbox[2] >= minLon && s.bbox[0] <= maxLon &&
      s.bbox[3] >= minLat && s.bbox[1] <= maxLat
    );
    if (!candidates.length) continue;

    const communeFeat = { type: 'Feature', geometry: commune.geometry };
    const tauxValues  = [];

    for (const seg of candidates) {
      try {
        const inter = turf.intersect(turf.featureCollection([
          communeFeat,
          { type: 'Feature', geometry: seg.geom },
        ]));
        if (!inter) continue;
        const t = inter.geometry?.type;
        if (t === 'Polygon' || t === 'MultiPolygon') tauxValues.push(seg.taux);
      } catch { /* géométrie invalide */ }
    }

    if (!tauxValues.length) continue;

    const meanTaux     = meanOf(tauxValues);
    const erosionRate  = Math.round(-meanTaux * 100) / 100; // positif
    const taux_segments = tauxValues.length;
    const erosion_class = classifyTaux(meanTaux);

    communeErosion.set(commune.code, { erosionRate, taux_segments, erosion_class });
    process.stdout.write(communeErosion.size % 50 === 0 ? `\n  [${communeErosion.size}] ` : '.');
  }

  console.log(`\n\n  ${communeErosion.size} communes avec recul détecté\n`);

  // ── 4. Mettre à jour communes existantes + collecter nouvelles ─
  let updatedLit = 0, updatedNc = 0, newCodes = [];

  for (const [code, info] of communeErosion) {
    const { erosionRate, taux_segments, erosion_class } = info;

    if (litMap.has(code)) {
      const p = litMap.get(code).properties;
      p.erosion_rate  = erosionRate;
      p.taux_segments = taux_segments;
      updatedLit++;
    } else if (ncMap.has(code)) {
      const p = ncMap.get(code).properties;
      p.erosion_rate  = erosionRate;
      p.taux_segments = taux_segments;
      p.erosion_class = erosion_class;
      updatedNc++;
    } else {
      newCodes.push(code);
    }

    // Mettre à jour l'arc correspondant
    if (arcsMap.has(code)) {
      const ap = arcsMap.get(code).properties;
      ap.erosion_rate  = erosionRate;
      ap.taux_segments = taux_segments;
      ap.erosion_class = erosion_class;
    }
  }

  // ── 5. Ajouter les nouvelles communes à communes_nodecret ─────
  console.log(`  Fetch noms pour ${newCodes.length} nouvelles communes…`);
  let added = 0;

  for (const code of newCodes) {
    const nom   = await fetchNom(code);
    const cache = cacheMap.get(code);
    if (!cache?.geometry) { console.warn(`  ⚠ géométrie absente pour ${code}`); continue; }

    const { erosionRate, taux_segments, erosion_class } = communeErosion.get(code);

    ncGjson.features.push({
      type: 'Feature',
      geometry: cache.geometry,
      properties: {
        code_insee:              code,
        nom,
        departement:             deptFromCode(code),
        erosion_rate:            erosionRate,
        taux_segments,
        erosion_class,
        price_median_m2:         0,
        price_by_semester:       null,
        price_by_semester_stats: null,
        obligation_date:         null,
        delta_2y:                null,
        price_delta_pct:         null,
      },
    });
    added++;
    process.stdout.write('+');
  }

  // ── 6. Reconstruire scatter.json ──────────────────────────────
  const scatter = [];
  for (const f of [...gjson.features, ...ncGjson.features]) {
    const p = f.properties;
    if (!(p.erosion_rate > 0) || p.price_delta_pct == null) continue;
    scatter.push({
      code_insee:      p.code_insee,
      nom:             p.nom,
      erosion_rate:    p.erosion_rate,
      taux_segments:   p.taux_segments ?? 1,
      price_delta_pct: p.price_delta_pct,
      erosion_class:   p.erosion_class,
      price_median_m2: p.price_median_m2,
    });
  }

  // ── 7. Écriture ───────────────────────────────────────────────
  arcsGjson.features = [...arcsMap.values()];
  await Promise.all([
    writeFile(GEOJSON, JSON.stringify(gjson, null, 2), 'utf8'),
    writeFile(NODECRET, JSON.stringify(ncGjson, null, 2), 'utf8'),
    writeFile(COASTAL_ARCS, JSON.stringify(arcsGjson), 'utf8'),
    writeFile(SCATTER, JSON.stringify(scatter), 'utf8'),
  ]);

  console.log(`\n\n  ${updatedLit} décret + ${updatedNc} nodecret mis à jour`);
  console.log(`  ${added} nouvelles communes ajoutées à communes_nodecret.geojson`);
  console.log(`  scatter.json : ${scatter.length} points`);
  console.log('\n✅ Terminé — rechargez le site.\n');
}

main().catch(err => { console.error('\n❌', err.message, '\n', err.stack); process.exit(1); });
