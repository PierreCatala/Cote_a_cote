/**
 * fix-arcs-erosion.mjs — recalcule les arcs côtiers des communes problématiques
 * en utilisant la logique de coastalBoundaryMidpoint() (frontières non partagées
 * avec les voisins = frontière maritime) + les centroides d'érosion pour choisir
 * le bon arc quand la commune a plusieurs faces aquatiques.
 *
 * C'est le même algorithme qu'enrich-erosion.mjs mais ciblé sur les 12 communes
 * signalées comme incorrectes.
 *
 * Usage : node pipeline/fix-arcs-erosion.mjs
 */

import shapefile from 'shapefile';
import proj4 from 'proj4';
import * as turf from '@turf/turf';
import { readFile, writeFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const SHP = resolve(__dir, 'erosion_shp/N_evolution_trait_cote_fr_epsg2154_S.shp');
const GEOJSON = resolve(__dir, '../data/communes_littorales.geojson');
const NODECRET = resolve(__dir, '../data/communes_nodecret.geojson');
const COASTAL_ARCS = resolve(__dir, '../data/coastal_arcs.geojson');
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

// Azimut (degrés) du centre de la commune VERS la mer.
// Sert à choisir le bon arc quand la commune a plusieurs faces aquatiques.
const SEA_BEARINGS = {
  '22251':  45,  // Pordic — Baie de Saint-Brieuc, mer au NE (côte intérieure du golfe)
  '85106': 270,  // La Guérinière — Atlantique à l'O (Noirmoutier)
  '64024': 270,  // Anglet — Atlantique à l'O
  '64122': 270,  // Biarritz — Atlantique à l'O
  '64125': 270,  // Bidart — Atlantique à l'O
  '64189': 280,  // Ciboure — Baie de Saint-Jean-de-Luz
  '64249': 270,  // Guéthary — Atlantique à l'O
  '64483': 310,  // Saint-Jean-de-Luz — Baie ouverte au NO
  '66053':  90,  // Collioure — Méditerranée à l'E
  '83065': 150,  // Gassin — Golfe de Saint-Tropez au SE
  '83068': 180,  // Grimaud — Golfe de Saint-Tropez au S
  '34301':  90,  // Sète — Méditerranée à l'E (et non Thau au SO)
  // Communes sans décret avec frontière étrangère non détectable par le cache
  '59260':   0,  // Ghyvelde — Mer du Nord au N (frontière belge à l'E ignorée)
};

const TARGET_CODES = new Set(Object.keys(SEA_BEARINGS));

// Comme enrich-erosion.mjs mais avec sélection par azimut marin
// quand plusieurs arcs sont détectés (plus fiable que le centroïde d'érosion).
function coastalBoundaryMidpoint(communeGeom, neighborLines, matchGeoms, seaBearingDeg) {
  let outerRing;
  if (communeGeom.type === 'Polygon') {
    outerRing = communeGeom.coordinates[0];
  } else {
    let maxArea = -Infinity;
    for (const pc of communeGeom.coordinates) {
      const a = turf.area(turf.polygon(pc));
      if (a > maxArea) { maxArea = a; outerRing = pc[0]; }
    }
  }
  const boundaryLine = turf.lineString(outerRing);
  const totalLen = turf.length(boundaryLine, { units: 'kilometers' });

  const STEP_KM = 0.05;   // 50 m (plus fin qu'enrich-erosion pour plus de précision)
  const SHARED_KM = 0.025; // 25 m — point "partagé" avec un voisin
  const coastDists = [];

  for (let d = 0; d <= totalLen; d += STEP_KM) {
    const pt = turf.along(boundaryLine, d, { units: 'kilometers' });
    const isShared = neighborLines.some(line => {
      try {
        return turf.nearestPointOnLine(line, pt, { units: 'kilometers' }).properties.dist < SHARED_KM;
      } catch { return false; }
    });
    if (!isShared) coastDists.push(d);
  }

  if (coastDists.length === 0) return null;

  const GAP = 2.5 * STEP_KM;
  const arcs = [[coastDists[0]]];
  for (let i = 1; i < coastDists.length; i++) {
    if (coastDists[i] - coastDists[i - 1] < GAP) {
      arcs[arcs.length - 1].push(coastDists[i]);
    } else {
      arcs.push([coastDists[i]]);
    }
  }

  if (arcs.length > 1) {
    const gapAcrossSeam = coastDists[0] + totalLen - coastDists[coastDists.length - 1];
    if (gapAcrossSeam < GAP) {
      const merged = [...arcs[arcs.length - 1], ...arcs[0].map(d => d + totalLen)];
      arcs.splice(arcs.length - 1, 1);
      arcs.splice(0, 1);
      arcs.unshift(merged);
    }
  }

  let chosenArc;
  if (arcs.length === 1) {
    chosenArc = arcs[0];
  } else if (seaBearingDeg != null) {
    // Priorité : azimut marin → prend l'arc dont le milieu est le plus dans la direction mer
    const seaRad = seaBearingDeg * Math.PI / 180;
    const sx = Math.sin(seaRad), sy = Math.cos(seaRad);
    let maxProj = -Infinity;
    chosenArc = arcs[0];
    for (const arc of arcs) {
      const midDist = arc[Math.floor(arc.length / 2)] % totalLen;
      const midPt = turf.along(boundaryLine, midDist, { units: 'kilometers' }).geometry.coordinates;
      const proj = sx * midPt[0] + sy * midPt[1];
      if (proj > maxProj) { maxProj = proj; chosenArc = arc; }
    }
  } else if (matchGeoms && matchGeoms.length > 0) {
    const segCentroids = matchGeoms
      .map(g => {
        try {
          const inter = turf.intersect(turf.featureCollection([
            turf.feature(communeGeom),
            turf.feature(g),
          ]));
          return inter ? turf.centroid(inter).geometry.coordinates : null;
        } catch { return null; }
      })
      .filter(Boolean);

    if (segCentroids.length > 0) {
      let minDist = Infinity;
      chosenArc = arcs[0];
      for (const arc of arcs) {
        const midDist = arc[Math.floor(arc.length / 2)] % totalLen;
        const midPt = turf.along(boundaryLine, midDist, { units: 'kilometers' });
        const d = Math.min(...segCentroids.map(sc =>
          turf.distance(midPt, turf.point(sc), { units: 'kilometers' })
        ));
        if (d < minDist) { minDist = d; chosenArc = arc; }
      }
    } else {
      chosenArc = arcs.reduce((max, a) => a.length > max.length ? a : max, arcs[0]);
    }
  } else {
    chosenArc = arcs.reduce((max, a) => a.length > max.length ? a : max, arcs[0]);
  }

  // Si un azimut marin est fourni, restreindre l'arc à la sous-section
  // la plus sea-facing (top 15 % de projection) — cela évite d'inclure
  // des tronçons de rivière ou de lagon dans un arc côtier mixte.
  let finalArc = chosenArc;
  if (seaBearingDeg != null && chosenArc.length > 6) {
    const seaRad = seaBearingDeg * Math.PI / 180;
    const sx = Math.sin(seaRad), sy = Math.cos(seaRad);

    const projected = chosenArc.map(d => {
      const [lng, lat] = turf.along(boundaryLine, d % totalLen, { units: 'kilometers' }).geometry.coordinates;
      return { d, proj: sx * lng + sy * lat };
    });

    const maxP = Math.max(...projected.map(p => p.proj));
    const minP = Math.min(...projected.map(p => p.proj));
    const thresh = maxP - 0.3 * (maxP - minP); // top 30 %

    const seaDists = projected.filter(p => p.proj >= thresh).map(p => p.d);
    if (seaDists.length >= 6) {
      // Regrouper et prendre le plus long sous-arc
      const subGap = 3 * STEP_KM;
      const subArcs = [[seaDists[0]]];
      for (let i = 1; i < seaDists.length; i++) {
        if (seaDists[i] - seaDists[i - 1] < subGap) subArcs[subArcs.length - 1].push(seaDists[i]);
        else subArcs.push([seaDists[i]]);
      }
      const longestSub = subArcs.reduce((mx, a) => a.length > mx.length ? a : mx, subArcs[0]);
      if (longestSub.length >= 6) finalArc = longestSub;
    }
  }

  const midDist = finalArc[Math.floor(finalArc.length / 2)] % totalLen;
  const midpoint = turf.along(boundaryLine, midDist, { units: 'kilometers' }).geometry.coordinates;

  const sub = Math.max(1, Math.round(0.3 / STEP_KM));
  const arcCoords = [];
  for (let i = 0; i < finalArc.length; i += sub) {
    arcCoords.push(turf.along(boundaryLine, finalArc[i] % totalLen, { units: 'kilometers' }).geometry.coordinates);
  }
  const lastCoord = turf.along(boundaryLine, finalArc[finalArc.length - 1] % totalLen, { units: 'kilometers' }).geometry.coordinates;
  if (arcCoords.length < 2) arcCoords.push(lastCoord);

  return { midpoint, arcCoords, arcCount: arcs.length };
}

function communeCentroid(geom) {
  if (geom.type === 'Polygon') return turf.centroid(turf.feature(geom)).geometry.coordinates;
  let maxArea = -Infinity, lp = null;
  for (const pc of geom.coordinates) {
    const p = turf.polygon(pc);
    const a = turf.area(p);
    if (a > maxArea) { maxArea = a; lp = p; }
  }
  return turf.centroid(lp).geometry.coordinates;
}

async function main() {
  console.log('\n🌊 Correction des arcs côtiers (méthode frontière)\n');

  // Charger le cache des communes pour les lignes voisines
  const allCommunes = JSON.parse(await readFile(ALL_COMMUNES_CACHE, 'utf8'));
  console.log(`  ${allCommunes.length} communes en cache`);

  // Charger les segments d'érosion
  const src = await shapefile.open(SHP);
  const allSegs = [];
  while (true) {
    const { value, done } = await src.read();
    if (done) break;
    const taux = value.properties?.taux;
    if (!taux || taux === -9999 || value.properties?.amenagemen === 1) continue;
    const g = reprojGeom(value.geometry);
    if (g) allSegs.push({ taux, geom: g });
  }
  console.log(`  ${allSegs.length} polygones d'érosion chargés\n`);

  const gjson = JSON.parse(await readFile(GEOJSON, 'utf8'));
  const ncGjson = JSON.parse(await readFile(NODECRET, 'utf8'));
  const arcsGjson = JSON.parse(await readFile(COASTAL_ARCS, 'utf8'));
  const arcsMap = new Map(arcsGjson.features.map(f => [f.properties.code_insee, f]));

  // Toutes les features (littorales + sans décret), sans doublons
  const allFeatures = [...gjson.features];
  const literalCodes = new Set(gjson.features.map(f => f.properties.code_insee));
  for (const f of ncGjson.features) {
    if (!literalCodes.has(f.properties.code_insee)) allFeatures.push(f);
  }

  let count = 0;

  for (const feat of allFeatures) {
    const code = feat.properties.code_insee;
    if (!TARGET_CODES.has(code)) continue;

    const commBbox = turf.bbox(feat);

    // Lignes des communes voisines
    const BUF = 0.002;
    const neighborLines = allCommunes
      .filter(c =>
        c.code !== code &&
        c.bbox[2] >= commBbox[0] - BUF && c.bbox[0] <= commBbox[2] + BUF &&
        c.bbox[3] >= commBbox[1] - BUF && c.bbox[1] <= commBbox[3] + BUF
      )
      .map(c => {
        try { return turf.polygonToLine({ type: 'Feature', geometry: c.geometry }); }
        catch { return null; }
      })
      .filter(Boolean);

    // Segments d'érosion intersectant la commune
    const matchGeoms = [];
    for (const seg of allSegs) {
      let sb;
      try { sb = turf.bbox({ type: 'Feature', geometry: seg.geom }); } catch { continue; }
      if (sb[2] < commBbox[0] || sb[0] > commBbox[2] || sb[3] < commBbox[1] || sb[1] > commBbox[3]) continue;
      try {
        if (turf.booleanIntersects(turf.feature(feat.geometry), turf.feature(seg.geom)))
          matchGeoms.push(seg.geom);
      } catch {}
    }

    const info = coastalBoundaryMidpoint(feat.geometry, neighborLines, matchGeoms, SEA_BEARINGS[code]);
    if (!info) {
      console.log(`  ⚠ ${feat.properties.nom}: aucun arc trouvé`);
      continue;
    }

    const { midpoint: origin, arcCoords, arcCount } = info;
    const centroid = communeCentroid(feat.geometry);
    const bearing = Math.round(turf.bearing(turf.point(origin), turf.point(centroid)));
    const oldBearing = feat.properties.arrow_bearing;

    const arcLons = arcCoords.map(c => c[0]);
    const arcLats = arcCoords.map(c => c[1]);
    console.log(
      `  ${feat.properties.nom.padEnd(26)} ${String(oldBearing).padStart(5)}° → ${String(bearing).padStart(5)}°` +
      `  (${arcCount} arc(s), ${arcCoords.length} pts, origin=[${origin[0].toFixed(3)}, ${origin[1].toFixed(3)}])`
    );

    // Ne mettre à jour les propriétés de flèche que pour les communes littorales
    // (les communes sans décret n'ont pas de flèche dans communes_littorales.geojson)
    if (literalCodes.has(code)) {
      feat.properties.arrow_lng = +origin[0].toFixed(5);
      feat.properties.arrow_lat = +origin[1].toFixed(5);
      feat.properties.arrow_bearing = bearing;
    }

    if (arcsMap.has(code)) {
      arcsMap.get(code).geometry.coordinates = arcCoords;
    } else {
      arcsMap.set(code, {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: arcCoords },
        properties: {
          code_insee: code,
          nom: feat.properties.nom,
          erosion_rate: feat.properties.erosion_rate,
          erosion_class: feat.properties.erosion_class,
        },
      });
    }
    count++;
  }

  await writeFile(GEOJSON, JSON.stringify(gjson, null, 2));
  await writeFile(NODECRET, JSON.stringify(ncGjson, null, 2));
  arcsGjson.features = [...arcsMap.values()];
  await writeFile(COASTAL_ARCS, JSON.stringify(arcsGjson, null, 2));
  console.log(`\n✅ ${count} communes corrigées — rechargez le site.\n`);
}

main().catch(err => { console.error('\n❌', err); process.exit(1); });
