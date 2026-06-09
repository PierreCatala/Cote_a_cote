/**
 * fetch-coastal.mjs — génère data/communes_nodecret.geojson
 *
 * Communes côtières qui ont des données d'érosion GéoLittoral (taux < 0)
 * mais qui ne figurent pas dans les décrets d'obligation d'information.
 *
 * Prérequis : enrich-erosion.mjs doit avoir été lancé au moins une fois
 *             (le shapefile doit être présent dans pipeline/erosion_shp/).
 *
 * Usage : node pipeline/fetch-coastal.mjs
 * Durée : 20–50 min (téléchargement DVF)
 */

import shapefile    from 'shapefile';
import proj4        from 'proj4';
import * as turf    from '@turf/turf';
import { createGunzip }       from 'zlib';
import { Readable }           from 'stream';
import { pipeline }           from 'stream/promises';
import { parse }              from 'csv-parse';
import { readFile, writeFile } from 'fs/promises';
import { existsSync }         from 'fs';
import { resolve, dirname }   from 'path';
import { fileURLToPath }      from 'url';

const __dir   = dirname(fileURLToPath(import.meta.url));
const SHP     = resolve(__dir, 'erosion_shp/N_evolution_trait_cote_fr_epsg2154_S.shp');
const DECREE  = resolve(__dir, '../data/communes_littorales.geojson');
const OUT     = resolve(__dir, '../data/communes_nodecret.geojson');

const COASTAL_DEPTS = [
  '06','11','13','14','17','22','29','30','33','34',
  '35','40','44','50','56','59','62','64','66','76',
  '80','83','85','2A','2B',
];
const DVF_YEARS = ['2021','2022','2023','2024','2025'];
const SEMESTERS = ['2021-S1','2021-S2','2022-S1','2022-S2','2023-S1','2023-S2','2024-S1','2024-S2','2025-S1','2025-S2'];
const DVF_BASE  = 'https://files.data.gouv.fr/geo-dvf/latest/csv';
const GEO_API   = 'https://geo.api.gouv.fr';

// ── Proj4 : Lambert 93 → WGS84 ────────────────────────────────
const L93 = '+proj=lcc +lat_1=49 +lat_2=44 +lat_0=46.5 +lon_0=3 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';
proj4.defs('EPSG:2154', L93);
const toWGS84 = proj4('EPSG:2154', 'WGS84');

function reprojCoords(c) {
  if (!Array.isArray(c)) return c;
  if (typeof c[0] === 'number') return toWGS84.forward(c);
  return c.map(reprojCoords);
}
function reprojGeom(g) { return g ? { ...g, coordinates: reprojCoords(g.coordinates) } : null; }

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m-1]+s[m])/2;
}
function dateSem(str) {
  const d = new Date(str);
  return isNaN(d) ? null : `${d.getFullYear()}-${d.getMonth()<6?'S1':'S2'}`;
}
const delay = ms => new Promise(r => setTimeout(r, ms));

// ── Étape 1 : charger le shapefile érosion ────────────────────
async function loadSegments() {
  console.log('\n── Chargement shapefile érosion ──');
  if (!existsSync(SHP)) throw new Error(`Shapefile introuvable : ${SHP}\nLancez d'abord enrich-erosion.mjs.`);
  const src  = await shapefile.open(SHP);
  const segs = [];
  while (true) {
    const { value, done } = await src.read();
    if (done) break;
    const taux = value.properties?.taux;
    if (!taux || taux === -9999 || taux >= 0) continue;   // uniquement érosion
    if (value.properties?.amenagemen === 1) continue;      // pas artificiel
    const geom = reprojGeom(value.geometry);
    if (geom) segs.push({ taux, geom });
  }
  console.log(`  ${segs.length} segments d'érosion`);
  return segs;
}

// ── Jointure spatiale + direction de flèche (identique à enrich-erosion.mjs) ──
function enrichCommune(communeFeat, segments) {
  const communeGeom = communeFeat.geometry;
  if (!communeGeom) return null;

  const bbox = turf.bbox(communeFeat);
  const matchTaux = [], matchGeoms = [];

  for (const seg of segments) {
    const sb = turf.bbox({ type: 'Feature', geometry: seg.geom });
    if (sb[2]<bbox[0]||sb[0]>bbox[2]||sb[3]<bbox[1]||sb[1]>bbox[3]) continue;
    try {
      if (turf.intersect(turf.featureCollection([turf.feature(communeGeom), turf.feature(seg.geom)])))
        { matchTaux.push(seg.taux); matchGeoms.push(seg.geom); }
    } catch { }
  }

  if (!matchTaux.length) return null;

  const medTaux     = median(matchTaux);
  const erosionRate = medTaux < 0 ? Math.round(-medTaux * 100) / 100 : null;
  const erosionClass = medTaux < -1.5 ? 'fort' : medTaux < 0 ? 'moyen' : null;

  // Direction de flèche (même logique que enrich-erosion.mjs)
  let arrowLng = null, arrowLat = null, arrowBearing = null;

  if (erosionRate > 0 && matchGeoms.length > 0) {
    const segCentroids = matchGeoms.map(
      g => turf.centroid({ type: 'Feature', geometry: g }).geometry.coordinates
    );

    // Médoïde
    const anchorIdx = segCentroids.length === 1 ? 0 :
      segCentroids
        .map((c, i) => ({
          i, score: segCentroids.reduce(
            (sum, o, j) => j!==i ? sum+(c[0]-o[0])**2+(c[1]-o[1])**2 : sum, 0),
        }))
        .sort((a, b) => a.score - b.score)[0].i;
    const origin   = segCentroids[anchorIdx];
    const originPt = turf.point(origin);
    const cfeat    = turf.feature(communeGeom);

    // Centroïde du plus grand polygone
    let centroidCoords;
    if (communeGeom.type === 'Polygon') {
      centroidCoords = turf.centroid(cfeat).geometry.coordinates;
    } else {
      let maxArea = -Infinity, largestPoly = null;
      for (const pc of communeGeom.coordinates) {
        const poly = turf.polygon(pc);
        const area = turf.area(poly);
        if (area > maxArea) { maxArea = area; largestPoly = poly; }
      }
      centroidCoords = turf.centroid(largestPoly).geometry.coordinates;
    }
    const centroidBearing = turf.bearing(originPt, turf.point(centroidCoords));

    // Vertices des 7 segments les plus proches
    const N = Math.min(7, segCentroids.length);
    const nearVerts = segCentroids
      .map((c, i) => ({ i, d: (c[0]-origin[0])**2+(c[1]-origin[1])**2 }))
      .sort((a, b) => a.d - b.d).slice(0, N)
      .flatMap(({ i }) => {
        const g = matchGeoms[i];
        return g.type==='LineString'      ? g.coordinates :
               g.type==='MultiLineString' ? g.coordinates.flat() : [];
      });

    const angDiff = (a, b) => { const d=((a-b+360)%360); return d>180?360-d:d; };
    let inlandBearing;
    if (segCentroids.length >= 2 && nearVerts.length >= 2) {
      const sv = [...nearVerts].sort((a,b) => a[0]!==b[0]?a[0]-b[0]:a[1]-b[1]);
      const cb = turf.bearing(turf.point(sv[0]), turf.point(sv[sv.length-1]));
      const p1 = ((cb+90)%360+360)%360;
      const p2 = ((cb-90)%360+360)%360;
      inlandBearing = angDiff(p1,centroidBearing)<=angDiff(p2,centroidBearing) ? p1 : p2;
    } else {
      inlandBearing = centroidBearing;
    }

    arrowBearing = Math.round(inlandBearing);
    arrowLng     = +origin[0].toFixed(5);
    arrowLat     = +origin[1].toFixed(5);
  }

  return { erosionRate, erosionClass, arrowLng, arrowLat, arrowBearing };
}

// ── Étape 2 : identifier les communes côtières hors décret ────
async function findCoastalCommunes(decreeSet, segments) {
  console.log('\n── Identification des communes côtières hors décret ──');
  const result = new Map(); // code → { nom, geom, dep, erosion }

  for (const dept of COASTAL_DEPTS) {
    process.stdout.write(`  dept ${dept}… `);
    try {
      const url = `${GEO_API}/communes?codeDepartement=${dept}&fields=code,nom,contour&format=geojson&geometry=contour`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      let found = 0;
      for (const feat of data.features ?? []) {
        const code = feat.properties?.code;
        if (!code || decreeSet.has(code)) continue;
        const geom = feat.properties?.contour ?? feat.geometry;
        if (!geom) continue;

        const mockFeat = { type: 'Feature', geometry: geom, properties: {} };
        const erosion  = enrichCommune(mockFeat, segments);
        if (!erosion) continue;

        result.set(code, { nom: feat.properties.nom, geom, dep: dept, erosion });
        found++;
        process.stdout.write('.');
      }
      console.log(` → ${found} communes`);
    } catch (err) {
      console.log(`ERREUR: ${err.message}`);
    }
    await delay(300);
  }

  return result;
}

// ── Étape 3 : téléchargement DVF ─────────────────────────────
async function fetchDVF(coastalCodes) {
  console.log('\n── Téléchargement DVF ──');
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
          if (!surface||surface<=0||!price||price<=0) return;
          const ppm2 = price / surface;
          if (ppm2 < 100 || ppm2 > 30000) return;
          const sem = dateSem(row['date_mutation']);
          if (!sem || !SEMESTERS.includes(sem)) return;
          ensure(code, sem).push(ppm2);
          rows++;
        });

        await pipeline(Readable.fromWeb(res.body), gunzip, csvStream);
        console.log(`${rows} lignes`);
      } catch (err) {
        console.log(`ERREUR: ${err.message}`);
      }
      await delay(500);
    }
  }
  return byCommune;
}

// ── Étape 4 : assemblage ──────────────────────────────────────
function assemble(coastalMap, dvfMap) {
  const features = [];
  for (const [code, info] of coastalMap) {
    const dvf = dvfMap.get(code);
    const bySem = {}, bySemStats = {};

    for (const sem of SEMESTERS) {
      const arr = dvf?.get(sem) ?? [];
      if (arr.length >= 3) {
        const sorted = [...arr].sort((a, b) => a - b);
        bySem[sem] = Math.round(median(sorted));
        bySemStats[sem] = {
          q1: Math.round(sorted[Math.floor((sorted.length-1)*0.25)]),
          q3: Math.round(sorted[Math.floor((sorted.length-1)*0.75)]),
          n:  sorted.length,
        };
      }
    }

    const priceVals = Object.values(bySem).filter(Boolean);
    const priceMed  = priceVals.length ? Math.round(median(priceVals)) : 0;

    features.push({
      type: 'Feature',
      geometry: info.geom,
      properties: {
        code_insee:              code,
        nom:                     info.nom,
        departement:             info.dep,
        erosion_class:           info.erosion.erosionClass,
        erosion_rate:            info.erosion.erosionRate,
        arrow_lng:               info.erosion.arrowLng,
        arrow_lat:               info.erosion.arrowLat,
        arrow_bearing:           info.erosion.arrowBearing,
        price_median_m2:         priceMed,
        price_by_semester:       bySem,
        price_by_semester_stats: bySemStats,
        obligation_date:         null,
        decret:                  null,
        vague:                   null,
      },
    });
  }
  return { type: 'FeatureCollection', features };
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  console.log('\n🌊 Pipeline — Communes côtières sans décret\n');

  if (!existsSync(DECREE)) {
    console.error(`❌ ${DECREE} introuvable. Lancez d'abord fetch.mjs.`);
    process.exit(1);
  }

  const gjson     = JSON.parse(await readFile(DECREE, 'utf8'));
  const decreeSet = new Set(gjson.features.map(f => f.properties.code_insee));
  console.log(`  ${decreeSet.size} communes à décret chargées`);

  const segments   = await loadSegments();
  const coastalMap = await findCoastalCommunes(decreeSet, segments);
  console.log(`\n  → ${coastalMap.size} communes côtières hors décret trouvées`);

  if (!coastalMap.size) { console.log('Rien à générer.'); process.exit(0); }

  const dvfMap = await fetchDVF(new Set(coastalMap.keys()));
  const output = assemble(coastalMap, dvfMap);

  const withPrices = output.features.filter(f => f.properties.price_median_m2 > 0).length;
  console.log(`\n  ${output.features.length} communes (${withPrices} avec prix)`);

  await writeFile(OUT, JSON.stringify(output, null, 2));
  console.log('\n✅ communes_nodecret.geojson généré !\n');
}

main().catch(err => { console.error('\n❌', err); process.exit(1); });
