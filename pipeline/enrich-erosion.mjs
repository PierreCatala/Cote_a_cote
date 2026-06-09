/**
 * enrich-erosion.mjs — enrichit communes_littorales.geojson avec les
 * données réelles d'évolution du trait de côte (GéoLittoral / Cerema 2018).
 *
 * Source shapefile : N_evolution_trait_cote_S_fr_epsg2154_062018_shape.zip
 * Téléchargé depuis : https://geolittoral.din.developpement-durable.gouv.fr
 *
 * Doit être lancé après fetch.mjs (ou sample.mjs) :
 *   node pipeline/enrich-erosion.mjs
 *
 * Nécessite : npm install (shapefile proj4 @turf/turf déjà dans package.json)
 */

import shapefile from 'shapefile';
import proj4      from 'proj4';
import * as turf  from '@turf/turf';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath }    from 'url';

const __dir   = dirname(fileURLToPath(import.meta.url));
const SHP     = resolve(__dir, 'erosion_shp/N_evolution_trait_cote_fr_epsg2154_S.shp');
const GEOJSON = resolve(__dir, '../data/communes_littorales.geojson');
const SCATTER = resolve(__dir, '../data/scatter.json');
const ZIP_URL = 'https://geolittoral.din.developpement-durable.gouv.fr/telechargement/couches_sig/N_evolution_trait_cote_S_fr_epsg2154_062018_shape.zip';

// ── Proj4 : EPSG:2154 (Lambert 93) → WGS84 ───────────────────
const L93 = '+proj=lcc +lat_1=49 +lat_2=44 +lat_0=46.5 +lon_0=3 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';
proj4.defs('EPSG:2154', L93);
const toWGS84 = proj4('EPSG:2154', 'WGS84');

function reprojectCoords(coords) {
  if (!Array.isArray(coords)) return coords;
  if (typeof coords[0] === 'number') {
    return toWGS84.forward(coords);
  }
  return coords.map(reprojectCoords);
}

function reprojectGeometry(geom) {
  if (!geom) return null;
  return { ...geom, coordinates: reprojectCoords(geom.coordinates) };
}

// ── Helpers ───────────────────────────────────────────────────
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function classifyTaux(taux) {
  if (!taux || taux === -9999) return null;
  if (taux < -1.5) return 'fort';
  if (taux < 0)    return 'moyen';
  return null; // stable or accretion
}

// ── Étape 1 — Vérifier / télécharger le shapefile ─────────────
async function ensureShapefile() {
  if (existsSync(SHP)) {
    console.log('  Shapefile déjà présent.');
    return;
  }
  console.log(`  Téléchargement depuis GéoLittoral (~1 Mo)…`);
  const res = await fetch(ZIP_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status} lors du téléchargement du ZIP`);
  const buf = Buffer.from(await res.arrayBuffer());

  const zipPath = resolve(__dir, 'erosion.zip');
  await writeFile(zipPath, buf);

  // Extraction via PowerShell (Windows)
  const { execSync } = await import('child_process');
  const outDir = resolve(__dir, 'erosion_shp');
  await mkdir(outDir, { recursive: true });
  execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${outDir}' -Force"`);
  console.log('  Extraction terminée.');
}

// ── Étape 2 — Lire le shapefile et reprojeter ─────────────────
async function loadErosionSegments() {
  console.log('\n── Lecture du shapefile érosion ──');
  const src = await shapefile.open(SHP);
  const segments = [];
  let skipped = 0;

  while (true) {
    const { value, done } = await src.read();
    if (done) break;

    const taux = value.properties?.taux;
    if (!taux || taux === -9999) { skipped++; continue; }   // no data
    if (value.properties?.amenagemen === 1) { skipped++; continue; } // artificially stabilized

    const geomWGS84 = reprojectGeometry(value.geometry);
    if (!geomWGS84) continue;

    segments.push({ taux, geom: geomWGS84 });
  }

  console.log(`  ${segments.length} segments valides (${skipped} ignorés — sans données ou artificiels)`);
  return segments;
}

// ── Étape 3 — Jointure spatiale ───────────────────────────────
function enrichCommune(communeFeature, segments) {
  const communeGeom = communeFeature.geometry;
  if (!communeGeom) return null;

  const bbox = turf.bbox(communeFeature);

  const matchingTaux  = [];
  const matchingGeoms = [];
  for (const seg of segments) {
    const segBbox = turf.bbox({ type: 'Feature', geometry: seg.geom });
    if (segBbox[2] < bbox[0] || segBbox[0] > bbox[2] ||
        segBbox[3] < bbox[1] || segBbox[1] > bbox[3]) continue;
    try {
      const inter = turf.intersect(
        turf.featureCollection([turf.feature(communeGeom), turf.feature(seg.geom)])
      );
      if (inter) { matchingTaux.push(seg.taux); matchingGeoms.push(seg.geom); }
    } catch { }
  }

  if (!matchingTaux.length) return null;

  const medianTaux  = median(matchingTaux);
  const erosionRate = medianTaux < 0 ? Math.round(-medianTaux * 100) / 100 : null;

  // Arrow : origine sur le littoral mesuré, perpendiculaire au trait de côte vers l'intérieur
  let arrowLng = null, arrowLat = null, arrowBearing = null;
  if (erosionRate != null && erosionRate > 0 && matchingGeoms.length > 0) {
    // Centroïdes par segment
    const segCentroids = matchingGeoms.map(
      g => turf.centroid({ type: 'Feature', geometry: g }).geometry.coordinates
    );

    // Médoïde : segment dont la somme des distances aux autres est minimale.
    // Pour les communes multi-façades (presqu'îles, baies), ancre la flèche
    // sur la face qui concentre le plus de segments (face dominante d'érosion).
    const anchorIdx = segCentroids.length === 1 ? 0 :
      segCentroids
        .map((c, i) => ({
          i,
          score: segCentroids.reduce(
            (sum, o, j) => j !== i ? sum + (c[0]-o[0])**2 + (c[1]-o[1])**2 : sum,
            0
          ),
        }))
        .sort((a, b) => a.score - b.score)[0].i;
    const origin = segCentroids[anchorIdx];

    const communeFeat = turf.feature(communeGeom);
    const originPt    = turf.point(origin);

    // Référence intérieure : centroïde du plus grand polygone
    let centroidCoords;
    if (communeGeom.type === 'Polygon') {
      centroidCoords = turf.centroid(communeFeat).geometry.coordinates;
    } else {
      let maxArea = -Infinity, largestPoly = null;
      for (const polyCoords of communeGeom.coordinates) {
        const poly = turf.polygon(polyCoords);
        const area = turf.area(poly);
        if (area > maxArea) { maxArea = area; largestPoly = poly; }
      }
      centroidCoords = turf.centroid(largestPoly).geometry.coordinates;
    }
    const centroidBearing = turf.bearing(originPt, turf.point(centroidCoords));

    // Écart angulaire normalisé [0, 180]
    const angDiff = (a, b) => {
      const d = ((a - b + 360) % 360);
      return d > 180 ? 360 - d : d;
    };

    let inlandBearing;
    if (segCentroids.length >= 2) {
      // Direction côtière locale : vertices des 7 segments les plus proches de l'ancrage
      const N_LOCAL = Math.min(7, segCentroids.length);
      const nearVerts = segCentroids
        .map((c, i) => ({ i, d: (c[0]-origin[0])**2 + (c[1]-origin[1])**2 }))
        .sort((a, b) => a.d - b.d)
        .slice(0, N_LOCAL)
        .flatMap(({ i }) => {
          const g = matchingGeoms[i];
          return g.type === 'LineString'      ? g.coordinates :
                 g.type === 'MultiLineString' ? g.coordinates.flat() : [];
        });

      let coastBearing;
      if (nearVerts.length >= 2) {
        const sv = [...nearVerts].sort((a, b) => a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]);
        coastBearing = turf.bearing(turf.point(sv[0]), turf.point(sv[sv.length - 1]));
      } else {
        const sc = [...segCentroids].sort((a, b) => a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]);
        coastBearing = turf.bearing(turf.point(sc[0]), turf.point(sc[sc.length - 1]));
      }

      const perp1 = ((coastBearing + 90) % 360 + 360) % 360;
      const perp2 = ((coastBearing - 90) % 360 + 360) % 360;

      // Toujours trancher via le centroïde (toujours à l'intérieur de la commune).
      // Supprime les faux positifs de booleanPointInPolygon sur communes multi-polygones.
      const diff1 = ((perp1 - centroidBearing + 360) % 360);
      const angDiff1 = diff1 > 180 ? 360 - diff1 : diff1;
      const diff2 = ((perp2 - centroidBearing + 360) % 360);
      const angDiff2 = diff2 > 180 ? 360 - diff2 : diff2;
      inlandBearing = angDiff1 <= angDiff2 ? perp1 : perp2;
    } else {
      inlandBearing = centroidBearing;
    }

    arrowBearing = Math.round(inlandBearing);
    arrowLng     = +origin[0].toFixed(5);
    arrowLat     = +origin[1].toFixed(5);
  }

  return {
    erosion_class: classifyTaux(medianTaux),
    erosion_rate:  erosionRate,
    arrow_lng:     arrowLng,
    arrow_lat:     arrowLat,
    arrow_bearing: arrowBearing,
  };
}

// ── Étape 4 — Mise à jour du GeoJSON ─────────────────────────
async function enrichGeoJSON(segments) {
  console.log('\n── Mise à jour du GeoJSON ──');
  const raw    = await readFile(GEOJSON, 'utf8');
  const gjson  = JSON.parse(raw);
  const BEFORE = new Set(['2021-S1','2021-S2','2022-S1','2022-S2']);

  let enriched = 0;
  const scatter = [];

  for (const feat of gjson.features) {
    const result = enrichCommune(feat, segments);

    if (result) {
      feat.properties.erosion_class  = result.erosion_class;
      feat.properties.erosion_rate   = result.erosion_rate;
      feat.properties.arrow_lng      = result.arrow_lng;
      feat.properties.arrow_lat      = result.arrow_lat;
      feat.properties.arrow_bearing  = result.arrow_bearing;
      if (result.erosion_class) enriched++;
    }

    // Recompute scatter eligibility
    const p = feat.properties;
    if (p.erosion_rate && p.price_delta_pct !== null) {
      scatter.push({
        code_insee:      p.code_insee,
        nom:             p.nom,
        erosion_rate:    p.erosion_rate,
        price_delta_pct: p.price_delta_pct,
        erosion_class:   p.erosion_class,
        price_median_m2: p.price_median_m2,
      });
    }

    process.stdout.write('.');
  }

  console.log(`\n  ${enriched} communes enrichies avec données érosion réelles`);

  await writeFile(GEOJSON, JSON.stringify(gjson, null, 2));
  await writeFile(SCATTER, JSON.stringify(scatter, null, 2));

  console.log(`  scatter.json mis à jour : ${scatter.length} points`);
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  console.log('\n🌊 Enrichissement érosion côtière (GéoLittoral 2018)\n');

  if (!existsSync(GEOJSON)) {
    console.error(`❌ ${GEOJSON} introuvable. Lancez d'abord fetch.mjs ou sample.mjs.`);
    process.exit(1);
  }

  await ensureShapefile();
  const segments = await loadErosionSegments();
  await enrichGeoJSON(segments);

  console.log('\n✅ Enrichissement terminé !');
  console.log('   Rechargez le site pour voir les données érosion réelles.\n');
}

main().catch(err => { console.error('\n❌', err); process.exit(1); });
