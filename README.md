# Cote à côte

Site statique interactif explorant la relation entre recul du trait de côte et prix de l'immobilier sur le littoral français métropolitain.

## Vues

| Vue | Description |
|-----|-------------|
| **Carte** | Choroplèthe prix/m² ou variation avant/après décret, arcs d'érosion côtiers colorés par vitesse de recul |
| **Nuage de points** | Taux de recul Cerema (m/an) vs variation des prix avant/après obligation d'information, avec droite de tendance MCO |
| **Comparer** | Communes côte à côte — courbes semestrielles avec intervalle de confiance à 95 % sur la médiane |

## Démarrage rapide

```bash
npx serve .
```

Ouvre http://localhost:3000. Les fichiers `data/` sont déjà générés dans le dépôt.

---

## Pipeline de données

Les scripts sont dans `pipeline/`. Ils nécessitent Node.js 18+ et `npm install` (dans `pipeline/`).

### Scripts courants

| Script | Usage | Durée |
|--------|-------|-------|
| `patch-2025s2.mjs` | Ajoute un nouveau semestre DVF à `communes_littorales.geojson` | 3–8 min |
| `enrich-obligation.mjs` | Recalcule `obligation_date` + `price_delta_pct` per-commune au sortir d'un nouveau décret | < 1 min |
| `build-cerema-communes.mjs` | Intègre de nouvelles mesures Cerema : met à jour les taux d'érosion, détecte les communes en recul non couvertes par un décret | 5–15 min |
| `enrich-prices-nodecret.mjs` | Enrichit les communes sans décret qui n'ont pas encore de données DVF | 30–60 min |
| `build-cerema-arcs.mjs` | Reconstruit `coastal_arcs.geojson` depuis tous les polygones Cerema (à relancer après mise à jour du shapefile) | 5–10 min |
| `fix-arcs-erosion.mjs` | Corrections manuelles pour les communes à géographie complexe (estuaires, golfes fermés, frontières étrangères) | < 1 min |

### Ordre de lancement après un nouveau décret

```bash
node pipeline/enrich-obligation.mjs      # 1. dates d'obligation + price_delta_pct
# → rebuild scatter.json manuellement ou via build-cerema-communes.mjs
```

### Ordre de lancement après mise à jour du shapefile Cerema

```bash
node pipeline/build-cerema-communes.mjs  # 1. taux d'érosion + nouvelles communes nodecret
node pipeline/enrich-prices-nodecret.mjs # 2. DVF pour les communes nodecret sans prix
node pipeline/build-cerema-arcs.mjs      # 3. arcs côtiers depuis les polygones Cerema
node pipeline/fix-arcs-erosion.mjs       # 4. corrections manuelles (communes complexes)
```

### Sources de données

| Source | Données |
|--------|---------|
| [data.gouv.fr — Cerema / DGFiP](https://www.data.gouv.fr/fr/datasets/liste-des-communes-volontaires-pour-sadapter-au-recul-du-trait-de-cote/) | Décrets d'obligation d'information (vagues 1–4), dates par commune |
| [files.data.gouv.fr — DVF géolocalisées](https://files.data.gouv.fr/geo-dvf/latest/csv/) | Transactions immobilières 2021–2025, CSV.gz par année × département |
| [GéoLittoral — Cerema](https://geolittoral.din.developpement-durable.gouv.fr) | Shapefile d'évolution du trait de côte (taux de recul en m/an, édition 2018) |
| [geo.api.gouv.fr](https://geo.api.gouv.fr/communes) | Géométries des communes (polygones IGN) |

---

## Format des données

### `data/communes_littorales.geojson`

Communes soumises à l'obligation d'information sur le recul du trait de côte (décrets 2022-750, 2023-698, 2024-531, 2026-95). **320 communes.**

```json
{
  "type": "Feature",
  "geometry": { "type": "Polygon", "coordinates": ["..."] },
  "properties": {
    "code_insee": "11145",
    "nom": "Fleury",
    "departement": "11",
    "erosion_class": "fort | moyen | null",
    "erosion_rate": 0.36,
    "taux_segments": 18,
    "obligation_date": "2023-01-01",
    "decret": "2022-750",
    "vague": 1,
    "price_median_m2": 3526,
    "price_by_semester": { "2021-S1": 2968, "2021-S2": 2981, "...": "..." },
    "price_by_semester_stats": {
      "2021-S1": { "q1": 2333, "q3": 3568, "n": 213 }
    },
    "price_delta_pct": 18.7,
    "n_transactions": 1647,
    "arrow_lng": 3.20966,
    "arrow_lat": 43.19179,
    "arrow_bearing": -53
  }
}
```

- `erosion_rate` : moyenne des taux de recul Cerema (m/an, positif) sur tous les segments intersectant la commune ; `null` si aucune mesure Cerema disponible
- `taux_segments` : nombre de segments Cerema contribuant à la moyenne
- `price_delta_pct` : variation de la médiane des prix au m² entre les semestres avant et après `obligation_date` (pivot individuel par commune)
- `price_by_semester_stats` : pour chaque semestre, `q1`, `q3` et `n` (transactions) — utilisés pour l'IC 95 % sur la médiane : `±1,57 × IQR / √n`
- `arrow_*` : point d'origine et cap de la flèche d'érosion sur la carte (milieu de l'arc côtier)

### `data/communes_nodecret.geojson`

Communes présentant un recul du trait de côte mesuré par Cerema mais **non couvertes par un décret d'obligation**. **294 communes.**

Mêmes champs que `communes_littorales.geojson`, avec `obligation_date`, `decret` et `vague` à `null`, et `price_delta_pct` à `null` (pas de date pivot).

### `data/coastal_arcs.geojson`

Arcs côtiers affichés sur la carte, colorés par vitesse de recul. Un arc par commune ayant au moins un segment Cerema mesuré. **667 arcs.**

```json
{
  "type": "Feature",
  "geometry": { "type": "LineString", "coordinates": ["..."] },
  "properties": {
    "code_insee": "11145",
    "nom": "Fleury",
    "taux": -0.36,
    "erosion_rate": 0.36,
    "erosion_class": "moyen",
    "taux_segments": 18
  }
}
```

- `taux` : taux médian Cerema signé (négatif = recul, positif = accrétion)

### `data/scatter.json`

Points du nuage de corrélation — communes ayant à la fois un `erosion_rate` et un `price_delta_pct`. **195 points.**

```json
{
  "code_insee": "11145",
  "nom": "Fleury",
  "erosion_rate": 0.36,
  "taux_segments": 18,
  "price_delta_pct": 18.7,
  "erosion_class": "moyen",
  "price_median_m2": 3526
}
```

---

## Stack technique

- **[MapLibre GL JS 4.5.0](https://maplibre.org/)** — rendu carte vectorielle
- **[OpenFreeMap](https://openfreemap.org/)** (style Positron) — tuiles open source sans token
- **[Chart.js 4.4.3](https://www.chartjs.org/)** — graphiques de prix par semestre et nuage de points
- **[chartjs-plugin-annotation](https://www.chartjs.org/chartjs-plugin-annotation/)** — ligne verticale date de décret par commune
- **Node.js 18+** + **[csv-parse](https://csv.js.org/parse/)** — pipeline de données (streaming DVF)
- **[Turf.js](https://turfjs.org/)** + **[proj4js](https://proj4js.org/)** + **[shapefile](https://github.com/mbostock/shapefile)** — géotraitement (intersection spatiale, reprojection Lambert 93 → WGS84)

Pas de backend, pas de build step, pas de Mapbox token.
