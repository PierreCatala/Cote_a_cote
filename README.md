# Littoral & Immo

Site statique interactif visualisant la relation entre le risque d'érosion côtière et les prix de l'immobilier le long du littoral français.

## Vues

| Vue | Description |
|-----|-------------|
| **Carte** | Choroplèthe prix/m² (5 quintiles YlOrRd) + couche érosion superposable (fort/moyen) |
| **Signal de marché** | Scatter plot — taux de recul côtier (m/an) vs variation prix post-janv. 2023 (%) |
| **Comparer** | Deux communes côte à côte avec graphique d'évolution des prix par semestre |

## Démarrage rapide

```bash
npx serve .
```

Ouvrez http://localhost:3000 dans votre navigateur.

> Les données doivent être générées en amont (voir ci-dessous).

## Pipeline de données

### Données de démo (30 communes, quelques secondes)

```bash
cd pipeline
npm install
node sample.mjs
```

Génère `data/communes_littorales.geojson` et `data/scatter.json` depuis des données pré-renseignées et les vraies géométries communales.

### Données réelles (25 départements côtiers, 30–90 min)

```bash
cd pipeline
npm install
node fetch.mjs
```

Télécharge et agrège les données depuis les sources officielles :

| Source | Données |
|--------|---------|
| [data.gouv.fr — Cerema](https://www.data.gouv.fr/fr/datasets/communes-soumises-a-obligation-de-diagnostic-de-recul-du-trait-de-cote/) | Décret érosion 2024 — communes fort/moyen |
| [files.data.gouv.fr — DVF](https://files.data.gouv.fr/geo-dvf/latest/csv/) | Transactions immobilières 2021–2024 (CSV.gz par département) |
| [geo.api.gouv.fr](https://geo.api.gouv.fr/communes) | Géométries des communes (polygones) |

#### Étapes du pipeline

1. **Décret érosion** — téléchargement CSV Cerema, parsing colonnes `code_insee`, `exposition`, `recul` (m/an)
2. **Géométries** — requêtes par département sur `geo.api.gouv.fr` avec `geometry=contour`
3. **DVF** — streaming des fichiers `.csv.gz` par année × département, filtrage Appartements/Maisons, calcul prix/m², agrégation par semestre (minimum 3 transactions)
4. **Assemblage** — delta avant/après janv. 2023, médiane globale, export GeoJSON + scatter

## Format des données

### `data/communes_littorales.geojson`

```json
{
  "type": "FeatureCollection",
  "features": [{
    "type": "Feature",
    "geometry": { "type": "Polygon", "coordinates": [...] },
    "properties": {
      "code_insee": "33234",
      "nom": "Lacanau",
      "departement": "33",
      "erosion_class": "fort",
      "erosion_rate": 2.1,
      "price_median_m2": 3170,
      "price_by_semester": {
        "2021-S1": 2800, "2021-S2": 2970,
        "2022-S1": 3100, "2022-S2": 3200,
        "2023-S1": 3230, "2023-S2": 3190, "2024-S1": 3170
      },
      "price_delta_pct": 5.1,
      "n_transactions": 74
    }
  }]
}
```

`price_delta_pct` = variation médiane(2023-S1 → 2024-S1) vs médiane(2021-S1 → 2022-S2).  
Découpage avant/après janvier 2023 : date d'entrée en vigueur de l'obligation d'information sur le recul du trait de côte (loi Climat & Résilience).

### `data/scatter.json`

```json
[{
  "code_insee": "33234",
  "nom": "Lacanau",
  "erosion_rate": 2.1,
  "price_delta_pct": 5.1,
  "erosion_class": "fort",
  "price_median_m2": 3170
}]
```

Contient uniquement les communes ayant à la fois un `erosion_rate` et un `price_delta_pct`.

## Stack technique

- **[MapLibre GL JS 4.5.0](https://maplibre.org/)** — rendu carte vectorielle
- **[OpenFreeMap](https://openfreemap.org/)** (style Positron) — tuiles sans token
- **[Chart.js 4.4.3](https://www.chartjs.org/)** — graphiques prix et scatter
- **[chartjs-plugin-annotation](https://www.chartjs.org/chartjs-plugin-annotation/)** — ligne verticale janv. 2023
- **Node.js 18+** — pipeline de données (scripts `.mjs`)
- **[csv-parse](https://csv.js.org/parse/)** — parsing streaming des DVF

Pas de backend, pas de build step, pas de Mapbox.
