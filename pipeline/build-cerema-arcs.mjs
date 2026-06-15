/**
 * build-cerema-arcs.mjs — importe TOUS les polygones Cerema (sans filtre taux
 * ni amenagement) et génère un arc pour chaque commune côtière ayant au moins
 * un segment mesuré.
 *
 * Logique inversée par rapport à l'ancienne approche :
 *   Avant  : on part des communes connues (décret + nodecret) → on cherche Cerema
 *   Maintenant : on part des polygones Cerema → on cherche la commune (all_communes_cache)
 *
 * Usage : node pipeline/build-cerema-arcs.mjs
 */

import shapefile from 'shapefile';
import proj4     from 'proj4';
import * as turf from '@turf/turf';
import { readFile, writeFile } from 'fs/promises';
import { resolve, dirname }    from 'path';
import { fileURLToPath }       from 'url';

const __dir          = dirname(fileURLToPath(import.meta.url));
const SHP            = resolve(__dir, 'erosion_shp/N_evolution_trait_cote_fr_epsg2154_S.shp');
const GEOJSON        = resolve(__dir, '../data/communes_littorales.geojson');
const NODECRET       = resolve(__dir, '../data/communes_nodecret.geojson');
const COASTAL_ARCS   = resolve(__dir, '../data/coastal_arcs.geojson');
const COASTAL_ZONES  = resolve(__dir, '../data/coastal_zones.geojson');
const ALL_COMMUNES_CACHE = resolve(__dir, 'all_communes_cache.json');

const L93 = '+proj=lcc +lat_1=49 +lat_2=44 +lat_0=46.5 +lon_0=3 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';
proj4.defs('EPSG:2154', L93);
const toWGS84 = proj4('EPSG:2154', 'WGS84');

function reprojCoords(c) {
  if (!Array.isArray(c)) return c;
  if (typeof c[0] === 'number') return toWGS84.forward(c);
  return c.map(reprojCoords);
}
function reprojGeom(g) {
  return g ? { ...g, coordinates: reprojCoords(g.coordinates) } : null;
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function classifyTaux(taux) {
  if (taux == null) return null;
  if (taux < -1.5) return 'fort';
  if (taux < 0)    return 'moyen';
  if (taux > 0)    return 'accretion';
  return 'stable';
}

function exteriorRing(feat) {
  const g = feat.geometry ?? feat;
  if (g.type === 'Polygon') return g.coordinates[0];
  if (g.type === 'MultiPolygon') {
    let maxArea = -Infinity, coords = null;
    for (const pc of g.coordinates) {
      const a = turf.area(turf.polygon(pc));
      if (a > maxArea) { maxArea = a; coords = pc[0]; }
    }
    return coords;
  }
  return null;
}

async function main() {
  console.log('\n🌊 Build arcs Cerema — toutes données, approche commune-from-polygons\n');

  // ── 1. Charger TOUS les polygones Cerema (aucun filtre) ──────
  console.log('Chargement shapefile Cerema…');
  const src = await shapefile.open(SHP);
  const allSegs = [];
  while (true) {
    const { value, done } = await src.read();
    if (done) break;
    const g = reprojGeom(value.geometry);
    if (!g) continue;
    allSegs.push({
      taux:       value.properties?.taux ?? null,
      amenagemen: value.properties?.amenagemen ?? 0,
      geom:       g,
      bbox:       turf.bbox({ type: 'Feature', geometry: g }),
    });
  }
  console.log(`  ${allSegs.length} polygones Cerema chargés (sans filtre)\n`);

  // ── 2. Noms des communes depuis les fichiers existants ────────
  const gjson   = JSON.parse(await readFile(GEOJSON, 'utf8'));
  const ncGjson = JSON.parse(await readFile(NODECRET, 'utf8'));
  const nomMap  = new Map();
  for (const f of [...gjson.features, ...ncGjson.features]) {
    nomMap.set(f.properties.code_insee, f.properties.nom);
  }

  // ── 3. Toutes les communes côtières ──────────────────────────
  const allCommunes = JSON.parse(await readFile(ALL_COMMUNES_CACHE, 'utf8'));
  console.log(`  ${allCommunes.length} communes côtières en cache`);
  console.log('  Traitement en cours…\n');

  // ── 4. Pour chaque commune : clip → union → exterior ring ────
  const arcs = [], zones = [];
  let withData = 0, noData = 0;

  for (const commune of allCommunes) {
    const [minLon, minLat, maxLon, maxLat] = commune.bbox;

    // Filtre bbox (rapide)
    const candidates = allSegs.filter(s =>
      s.bbox[2] >= minLon && s.bbox[0] <= maxLon &&
      s.bbox[3] >= minLat && s.bbox[1] <= maxLat
    );
    if (!candidates.length) { noData++; continue; }

    // Intersection spatiale
    const communeFeat = { type: 'Feature', geometry: commune.geometry };
    const clips = [];
    const tauxValid = [];

    for (const seg of candidates) {
      try {
        const inter = turf.intersect(turf.featureCollection([
          communeFeat,
          { type: 'Feature', geometry: seg.geom },
        ]));
        if (!inter) continue;
        const t = inter.geometry?.type;
        if (t === 'Polygon' || t === 'MultiPolygon') {
          clips.push(inter);
          if (seg.taux != null && seg.taux !== -9999) tauxValid.push(seg.taux);
        }
      } catch { /* ignorer les intersections invalides */ }
    }

    if (!clips.length) { noData++; continue; }

    // Union de tous les polygones clippés
    let merged = clips[0];
    for (let i = 1; i < clips.length; i++) {
      try {
        merged = turf.union(turf.featureCollection([merged, clips[i]]));
      } catch { /* garder merged tel quel */ }
    }

    // Anneau extérieur → LineString
    const ring = exteriorRing(merged);
    if (!ring || ring.length < 3) { noData++; continue; }

    const simplified = turf.simplify(
      turf.lineString(ring.slice(0, -1)),  // retirer le point de fermeture
      { tolerance: 0.00005, highQuality: false }
    );
    const arcCoords = simplified.geometry.coordinates;
    if (arcCoords.length < 2) { noData++; continue; }

    // Statistiques taux
    const medTaux     = tauxValid.length ? median(tauxValid) : null;
    const erosionRate = (medTaux != null && medTaux < 0)
      ? Math.round(-medTaux * 100) / 100
      : null;
    const erosionClass = classifyTaux(medTaux);

    const nom = nomMap.get(commune.code) ?? commune.code;
    arcs.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: arcCoords },
      properties: {
        code_insee:    commune.code,
        nom,
        taux:          medTaux != null ? Math.round(medTaux * 100) / 100 : null,
        erosion_rate:  erosionRate,
        erosion_class: erosionClass,
        taux_segments: tauxValid.length,
      },
    });

    if (erosionRate > 0) {
      const simplifiedPoly = turf.simplify(merged, { tolerance: 0.0002, highQuality: false });
      zones.push({
        type: 'Feature',
        geometry: simplifiedPoly.geometry,
        properties: {
          code_insee:    commune.code,
          nom,
          erosion_rate:  erosionRate,
          erosion_class: erosionClass,
          taux_segments: tauxValid.length,
        },
      });
    }

    withData++;
    process.stdout.write(withData % 50 === 0 ? `\n  [${withData}] ` : '.');
  }

  console.log(`\n\n  ${withData} arcs générés`);
  console.log(`  ${noData} communes sans intersection Cerema`);

  // ── 5. Écriture ───────────────────────────────────────────────
  await Promise.all([
    writeFile(COASTAL_ARCS,  JSON.stringify({ type: 'FeatureCollection', features: arcs }),  'utf8'),
    writeFile(COASTAL_ZONES, JSON.stringify({ type: 'FeatureCollection', features: zones }), 'utf8'),
  ]);
  console.log(`\n✅ coastal_arcs.geojson (${arcs.length} arcs) + coastal_zones.geojson (${zones.length} zones) mis à jour.\n`);

  // ── Résumé par classe ─────────────────────────────────────────
  const byClass = {};
  for (const f of arcs) {
    const c = f.properties.erosion_class ?? 'null';
    byClass[c] = (byClass[c] ?? 0) + 1;
  }
  console.log('  Répartition par classe :');
  for (const [c, n] of Object.entries(byClass).sort()) {
    console.log(`    ${c.padEnd(12)} ${n}`);
  }
}

main().catch(err => { console.error('\n❌', err.message, '\n', err.stack); process.exit(1); });
