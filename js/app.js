// ── Config ────────────────────────────────────────────────────
const MAP_STYLE  = 'https://tiles.openfreemap.org/styles/positron';
const DATA_GEOJSON      = 'data/communes_littorales.geojson';
const DATA_NODECRET     = 'data/communes_nodecret.geojson';
const DATA_SCATTER      = 'data/scatter.json';
const DATA_COASTAL_ZONES = 'data/coastal_zones.geojson';

const DECRET_URLS = {
  '2022-750': 'https://www.legifrance.gouv.fr/jorf/id/JORFTEXT000045726134',
  '2023-698': 'https://www.legifrance.gouv.fr/jorf/id/JORFTEXT000047911613',
  '2024-531': 'https://www.legifrance.gouv.fr/jorf/id/JORFTEXT000049690164',
  '2026-95':  'https://www.legifrance.gouv.fr/jorf/id/JORFTEXT000053493953',
};

const COLORS = {
  quintiles: ['#ffffb2', '#fecc5c', '#fd8d3c', '#f03b20', '#bd0026'],
  dot:   { decret: '#0ea5e9', none: '#94a3b8' },
};

const SEMESTERS = ['2021-S1','2021-S2','2022-S1','2022-S2','2023-S1','2023-S2','2024-S1','2024-S2','2025-S1','2025-S2'];
const BEFORE_2023 = ['2021-S1','2021-S2','2022-S1','2022-S2'];

const DELTA_COLORS = ['#15803d','#86efac','#f8fafc','#fca5a5','#b91c1c'];
const DELTA_STOPS  = [-15, -5, 0, 5, 15];


function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a,b) => a-b);
  const m = Math.floor(s.length/2);
  return s.length%2 ? s[m] : (s[m-1]+s[m])/2;
}
function dateToSem(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()<6?'S1':'S2'}`;
}
function windowDelta(bySem, obligationDate, n) {
  if (!obligationDate) return null;
  const pi = SEMESTERS.indexOf(dateToSem(obligationDate));
  if (pi < 0) return null;
  const before = SEMESTERS.slice(Math.max(0,pi-n), pi).map(s=>bySem[s]).filter(Boolean);
  const after  = SEMESTERS.slice(pi, pi+n).map(s=>bySem[s]).filter(Boolean);
  if (!before.length || !after.length) return null;
  const mb = median(before), ma = median(after);
  return (mb && ma) ? Math.round((ma-mb)/mb*1000)/10 : null;
}

// ── State ─────────────────────────────────────────────────────
const COMPARE_COLORS = ['#0ea5e9','#a855f7','#f97316','#22c55e','#ef4444','#eab308'];
const COMPARE_MAX = 6;

let map, priceChart, scatterChart;
let compareCharts = new Map(); // code_insee → Chart
let compareOverlayChart = null;
let geojson = null, nodecretGeojson = null, scatterData = [], coastalZonesGeojson = null;
let compareSelections = []; // array of props objects
let showChoropleth = true;
let compareViewMode = 'side'; // 'side' | 'overlay'
let _scatterGroups, _buildDataset;
let mapMode = 'delta2y';
let priceYearFrom = 2021, priceYearTo = 2025;
let scatterLogX = false, scatterLogY = false;

// ── Init ──────────────────────────────────────────────────────
async function init() {
  await loadData();
  initMap();
  initScatter();
  bindNav();
  bindSearch('#search-input', '#search-results', onSearchSelect);
  bindCompare();
  initSidebarTooltips();
  initOnboarding();
}

function initOnboarding() {
  if (localStorage.getItem('cac_onboarded')) return;
  const el = document.getElementById('onboarding');
  if (!el) return;
  el.classList.remove('hidden');
  document.getElementById('onboarding-close').addEventListener('click', () => {
    el.classList.add('hidden');
    localStorage.setItem('cac_onboarded', '1');
  });
}

function initSidebarTooltips() {
  const tip = document.getElementById('tooltip-global');

  function bindTooltips(container) {
    let current = null;
    container.addEventListener('mouseover', (e) => {
      const nd = e.target.closest('.nd-info');
      if (nd === current) return;
      current = nd;
      if (!nd) { tip.style.display = 'none'; return; }
      tip.textContent = nd.dataset.tooltip ?? '';
      tip.style.display = 'block';
      const r   = nd.getBoundingClientRect();
      const w   = 230;
      const th  = tip.offsetHeight;
      let x = r.left + r.width / 2 - w / 2;
      x = Math.max(8, Math.min(x, window.innerWidth - w - 8));
      const below = r.bottom + 8 + th > window.innerHeight;
      tip.style.left = x + 'px';
      tip.style.top  = below ? (r.top - th - 8) + 'px' : (r.bottom + 8) + 'px';
    });
    container.addEventListener('mouseleave', () => {
      tip.style.display = 'none';
      current = null;
    });
  }

  bindTooltips(document.getElementById('sidebar'));
  bindTooltips(document.getElementById('map-legend'));
}

// ── Data loading ──────────────────────────────────────────────
async function loadData() {
  try {
    const [geoRes, scatRes, ncRes, zonesRes] = await Promise.all([
      fetch(DATA_GEOJSON),
      fetch(DATA_SCATTER),
      fetch(DATA_NODECRET).catch(() => null),
      fetch(DATA_COASTAL_ZONES).catch(() => null),
    ]);
    geojson     = await geoRes.json();
    scatterData = await scatRes.json();
    if (ncRes?.ok)   nodecretGeojson  = await ncRes.json();
    if (zonesRes?.ok) coastalZonesGeojson = await zonesRes.json();

    // Pré-calcul des deltas fenêtrés ±1 an et ±2 ans par commune
    for (const f of geojson.features) {
      const p = f.properties;
      const bySem = typeof p.price_by_semester === 'string'
        ? JSON.parse(p.price_by_semester) : (p.price_by_semester ?? {});
      const d1 = windowDelta(bySem, p.obligation_date, 2);
      const d2 = windowDelta(bySem, p.obligation_date, 4);
      if (d1 !== null) p.delta_1y = d1;
      if (d2 !== null) p.delta_2y = d2;
    }

    // Aligne le scatter sur la même méthode que la sidebar :
    // delta_2y = fenêtre symétrique 4 sem. avant/après l'obligation_date propre à chaque commune.
    // price_delta_pct dans scatter.json utilise une coupure fixe 2021-2022 / 2023-2025 — incorrect
    // pour les communes dont le décret date de 2022 ou 2024.
    const delta2yMap = new Map(
      geojson.features
        .filter(f => f.properties.delta_2y != null)
        .map(f => [f.properties.code_insee, f.properties.delta_2y])
    );
    scatterData = scatterData
      .map(d => {
        const d2 = delta2yMap.get(d.code_insee);
        return d2 != null ? { ...d, price_delta_pct: d2 } : d;
      })
      .filter(d => d.price_delta_pct != null);
  } catch (err) {
    document.getElementById('map-loading').innerHTML =
      `<p style="color:#ef4444;padding:20px;text-align:center">Erreur de chargement des données.<br>
       <small>${err.message}</small></p>`;
    throw err;
  }
}

// ── Map ───────────────────────────────────────────────────────
function initMap() {
  map = new maplibregl.Map({
    container: 'map',
    style: MAP_STYLE,
    center: [2.0, 46.8],
    zoom: 5.2,
    attributionControl: { compact: true },
  });

  map.addControl(new maplibregl.NavigationControl(), 'top-left');

  map.on('load', () => {
    addCommuneLayers();
    updateMapMode('delta2y');
    document.getElementById('map-loading').style.display = 'none';
    const urlCode = new URLSearchParams(location.search).get('commune');
    if (urlCode) {
      const feat =
        geojson?.features.find(f => f.properties.code_insee === urlCode) ??
        nodecretGeojson?.features.find(f => f.properties.code_insee === urlCode);
      if (feat) openSidebar(feat.properties);
    }
  });

  map.on('click', 'communes-fill', (e) => {
    const code = e.features[0]?.properties?.code_insee;
    if (!code) return;
    const feat = geojson?.features.find(f => f.properties.code_insee === code);
    if (feat) openSidebar(feat.properties);
  });
  map.on('click', 'communes-nc-fill', (e) => {
    const code = e.features[0]?.properties?.code_insee;
    if (!code || !nodecretGeojson) return;
    // Look up raw properties from in-memory GeoJSON to avoid MapLibre's nested-object serialization
    const feat = nodecretGeojson.features.find(f => f.properties.code_insee === code);
    if (feat) openSidebar(feat.properties);
  });

  map.on('mouseenter', 'communes-fill',    () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'communes-fill',    () => { map.getCanvas().style.cursor = ''; });
  map.on('mouseenter', 'communes-nc-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'communes-nc-fill', () => { map.getCanvas().style.cursor = ''; });
}

function allPriceValues() {
  const a = geojson.features.map(f => f.properties.price_median_m2).filter(v => v > 0);
  const b = (nodecretGeojson?.features ?? []).map(f => f.properties.price_median_m2).filter(v => v > 0);
  return [...a, ...b].sort((x, y) => x - y);
}

function addCommuneLayers() {
  const prices = allPriceValues();

  const q = (pct) => prices[Math.floor(prices.length * pct)] ?? prices[prices.length - 1];
  const breaks = [q(.2), q(.4), q(.6), q(.8)];

  // Store breaks globally for legend
  window._quintileBreaks = breaks;
  window._priceMin = prices[0];
  window._priceMax = prices[prices.length - 1];

  // Hatch pattern — commune sous décret (diagonales grises, fond transparent)
  const HS = 16;
  const hc = document.createElement('canvas');
  hc.width = HS; hc.height = HS;
  const hCtx = hc.getContext('2d');
  hCtx.strokeStyle = 'rgba(55,65,81,0.85)';
  hCtx.lineWidth = 1.5;
  for (let i = -HS; i <= HS * 2; i += HS / 2) {
    hCtx.beginPath(); hCtx.moveTo(i, HS); hCtx.lineTo(i + HS, 0); hCtx.stroke();
  }
  map.addImage('decret-hatch', { width: HS, height: HS, data: hCtx.getImageData(0, 0, HS, HS).data });

  map.addSource('communes', { type: 'geojson', data: geojson });

  // Choropleth fill
  map.addLayer({
    id: 'communes-fill',
    type: 'fill',
    source: 'communes',
    paint: {
      'fill-color': [
        'case',
        ['==', ['get', 'price_median_m2'], 0], '#e2e8f0',
        ['step',
          ['get', 'price_median_m2'],
          COLORS.quintiles[0],
          breaks[0], COLORS.quintiles[1],
          breaks[1], COLORS.quintiles[2],
          breaks[2], COLORS.quintiles[3],
          breaks[3], COLORS.quintiles[4],
        ],
      ],
      'fill-opacity': 0.72,
    },
  });

  // Commune borders
  map.addLayer({
    id: 'communes-outline',
    type: 'line',
    source: 'communes',
    paint: {
      'line-color': '#ffffff',
      'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.3, 9, 1.2],
      'line-opacity': 0.6,
    },
  });

  // Hover highlight
  map.addLayer({
    id: 'communes-hover',
    type: 'line',
    source: 'communes',
    paint: {
      'line-color': '#0ea5e9',
      'line-width': 2,
    },
    filter: ['==', ['get', 'code_insee'], ''],
  });

  map.on('mousemove', 'communes-fill', (e) => {
    const code = e.features[0]?.properties?.code_insee ?? '';
    map.setFilter('communes-hover', ['==', ['get', 'code_insee'], code]);
  });
  map.on('mouseleave', 'communes-fill', () => {
    map.setFilter('communes-hover', ['==', ['get', 'code_insee'], '']);
  });

  // Erosion overlay — communes sous décret (hachuré diagonal gris)
  map.addLayer({
    id: 'erosion-decret-fill',
    type: 'fill',
    source: 'communes',
    filter: ['in', ['get', 'erosion_class'], ['literal', ['fort', 'moyen']]],
    paint: { 'fill-pattern': 'decret-hatch' },
  });
  map.addLayer({
    id: 'erosion-decret-outline',
    type: 'line',
    source: 'communes',
    filter: ['in', ['get', 'erosion_class'], ['literal', ['fort', 'moyen']]],
    paint: { 'line-color': 'rgba(55,65,81,0.75)', 'line-width': 2 },
  });

  // ── Communes côtières sans décret ──────────────────────────
  if (nodecretGeojson) {
    map.addSource('communes-nc', { type: 'geojson', data: nodecretGeojson });

    map.addLayer({
      id: 'communes-nc-fill',
      type: 'fill',
      source: 'communes-nc',
      paint: {
        'fill-color': [
          'case',
          ['==', ['get', 'price_median_m2'], 0], '#e2e8f0',
          ['step', ['get', 'price_median_m2'],
            COLORS.quintiles[0],
            breaks[0], COLORS.quintiles[1],
            breaks[1], COLORS.quintiles[2],
            breaks[2], COLORS.quintiles[3],
            breaks[3], COLORS.quintiles[4],
          ],
        ],
        'fill-opacity': 0,   // transparent par défaut (mode delta au démarrage)
      },
    }, 'communes-fill');   // insérer SOUS la couche décret

    map.addLayer({
      id: 'communes-nc-outline',
      type: 'line',
      source: 'communes-nc',
      paint: {
        'line-color': '#94a3b8',
        'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.8, 9, 1.8],
        'line-opacity': 0.7,
      },
    }, 'communes-fill');

    map.addLayer({
      id: 'communes-nc-hover',
      type: 'line',
      source: 'communes-nc',
      paint: { 'line-color': '#0ea5e9', 'line-width': 2 },
      filter: ['==', ['get', 'code_insee'], ''],
    });

    map.on('mousemove', 'communes-nc-fill', (e) => {
      const code = e.features[0]?.properties?.code_insee ?? '';
      map.setFilter('communes-nc-hover', ['==', ['get', 'code_insee'], code]);
    });
    map.on('mouseleave', 'communes-nc-fill', () => {
      map.setFilter('communes-nc-hover', ['==', ['get', 'code_insee'], '']);
    });
  }

  try { addCoastalZoneLayer(); } catch (e) { console.warn('addCoastalZoneLayer:', e); }

  // Bind map mode buttons
  document.querySelectorAll('.legend-mode-btn').forEach(btn =>
    btn.addEventListener('click', () => updateMapMode(btn.dataset.mode)));

  // Populate year selects and bind
  const YEARS = [...new Set(SEMESTERS.map(s => parseInt(s)))];
  ['year-from','year-to'].forEach(id => {
    const sel = document.getElementById(id);
    YEARS.forEach(y => {
      const opt = document.createElement('option');
      opt.value = opt.textContent = y;
      if ((id === 'year-from' && y === YEARS[0]) || (id === 'year-to' && y === YEARS[YEARS.length-1]))
        opt.selected = true;
      sel.appendChild(opt);
    });
  });
  const onYearChange = () => {
    let from = parseInt(document.getElementById('year-from').value);
    let to   = parseInt(document.getElementById('year-to').value);
    if (from > to) { to = from; document.getElementById('year-to').value = from; }
    updateMapPrice(from, to);
  };
  document.getElementById('year-from').addEventListener('change', onYearChange);
  document.getElementById('year-to').addEventListener('change', onYearChange);

  // Toggle communes sans décret
  document.getElementById('toggle-nodecret').addEventListener('change', (e) => {
    const vis = e.target.checked ? 'visible' : 'none';
    ['communes-nc-fill','communes-nc-outline','communes-nc-hover'].forEach(id => {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
    });
  });

  // Toggle valeurs foncières (choropleth)
  document.getElementById('toggle-choropleth').addEventListener('change', (e) => {
    showChoropleth = e.target.checked;
    updateMapMode(mapMode);
  });

  // Toggle erosion contours
  document.getElementById('toggle-erosion').addEventListener('change', (e) => {
    const vis = e.target.checked ? 'visible' : 'none';
    ['erosion-decret-fill','erosion-decret-outline']
      .forEach(id => map.setLayoutProperty(id, 'visibility', vis));
  });

  // Toggle zones de recul
  document.getElementById('toggle-arrows').addEventListener('change', (e) => {
    const vis = e.target.checked ? 'visible' : 'none';
    ['coastal-zones-fill', 'coastal-zones-outline']
      .forEach(id => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis); });
  });
}

// Couleurs du spectre érosion : jaune → orange → rouge (échelle log)
const ARC_COLOR_EXPR = [
  'interpolate', ['linear'], ['ln', ['max', ['get', 'erosion_rate'], 0.01]],
  -2.303, '#fde047',   // ln(0.1) — jaune
  -0.693, '#f97316',   // ln(0.5) — orange
   0.693, '#dc2626',   // ln(2)   — rouge
];

function addCoastalZoneLayer() {
  if (!coastalZonesGeojson) return;

  map.addSource('coastal-zones', { type: 'geojson', data: coastalZonesGeojson });

  // Aplat semi-transparent coloré par vitesse de recul — au-dessus de tout
  map.addLayer({
    id: 'coastal-zones-fill',
    type: 'fill',
    source: 'coastal-zones',
    paint: {
      'fill-color':   ARC_COLOR_EXPR,
      'fill-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.7, 10, 0.55],
    },
  });

  // Contour sombre pour faire ressortir les zones sur l'aplat
  map.addLayer({
    id: 'coastal-zones-outline',
    type: 'line',
    source: 'coastal-zones',
    paint: {
      'line-color': [
        'interpolate', ['linear'], ['ln', ['max', ['get', 'erosion_rate'], 0.01]],
        -2.303, '#b45309',   // jaune → brun-ambré
        -0.693, '#c2410c',   // orange → orange foncé
         0.693, '#991b1b',   // rouge → rouge sombre
      ],
      'line-width':   ['interpolate', ['linear'], ['zoom'], 5, 6, 8, 2.5, 12, 1.2],
      'line-opacity': 1,
    },
  });

  // Tooltip au survol
  const popup = new maplibregl.Popup({
    closeButton: false, closeOnClick: false, className: 'zone-popup',
  });

  map.on('mousemove', 'coastal-zones-fill', (e) => {
    const p = e.features[0]?.properties;
    if (!p) return;
    const segsStr = (p.taux_segments ?? 1) > 1
      ? `<span class="zone-popup-segs">${p.taux_segments} tronçons</span>` : '';
    popup.setLngLat(e.lngLat)
      .setHTML(`<strong>${p.nom}</strong><br>${p.erosion_rate} m/an ${segsStr}`)
      .addTo(map);
  });

  map.on('mouseleave', 'coastal-zones-fill', () => {
    map.getCanvas().style.cursor = '';
    popup.remove();
  });

  map.on('click', 'coastal-zones-fill', (e) => {
    const code = e.features[0]?.properties?.code_insee;
    if (!code) return;
    popup.remove();
    const feat =
      geojson?.features.find(f => f.properties.code_insee === code) ??
      nodecretGeojson?.features.find(f => f.properties.code_insee === code);
    if (feat) openSidebar(feat.properties);
  });
  map.on('mouseenter', 'coastal-zones-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
}

function recomputePrice(features, sems) {
  return features.map(f => {
    const p = f.properties;
    const bySem = typeof p.price_by_semester === 'string'
      ? JSON.parse(p.price_by_semester) : (p.price_by_semester ?? {});
    const vals = sems.map(s => bySem[s]).filter(Boolean);
    const med  = vals.length ? Math.round(median(vals)) : 0;
    return { ...f, properties: { ...p, price_median_m2: med } };
  });
}

function updateMapPrice(fromYear, toYear) {
  priceYearFrom = fromYear;
  priceYearTo   = toYear;

  const sems = SEMESTERS.filter(s => {
    const y = parseInt(s);
    return y >= fromYear && y <= toYear;
  });

  const features   = recomputePrice(geojson.features, sems);
  const featuresNC = nodecretGeojson ? recomputePrice(nodecretGeojson.features, sems) : [];

  // Quintiles sur les deux jeux de données combinés
  const prices = [...features, ...featuresNC]
    .map(f => f.properties.price_median_m2).filter(v => v > 0).sort((a,b) => a-b);
  const q = pct => prices[Math.floor(prices.length * pct)] ?? prices[prices.length-1];
  window._quintileBreaks = [q(.2), q(.4), q(.6), q(.8)];
  window._priceMin = prices[0];
  window._priceMax = prices[prices.length-1];

  const priceExpr = [
    'case',
    ['==', ['get', 'price_median_m2'], 0], '#e2e8f0',
    ['step', ['get', 'price_median_m2'],
      COLORS.quintiles[0],
      window._quintileBreaks[0], COLORS.quintiles[1],
      window._quintileBreaks[1], COLORS.quintiles[2],
      window._quintileBreaks[2], COLORS.quintiles[3],
      window._quintileBreaks[3], COLORS.quintiles[4],
    ],
  ];

  map.getSource('communes').setData({ ...geojson, features });
  map.setPaintProperty('communes-fill', 'fill-color', priceExpr);

  if (nodecretGeojson && map.getLayer('communes-nc-fill')) {
    map.getSource('communes-nc').setData({ ...nodecretGeojson, features: featuresNC });
    map.setPaintProperty('communes-nc-fill', 'fill-color', priceExpr);
  }
  buildLegendPrice();
}

function buildLegend() { buildLegendPrice(); }

function buildLegendPrice() {
  const explain = document.getElementById('legend-delta-explain');
  if (explain) {
    explain.textContent = 'Chaque couleur = 20 % des communes (quintiles)';
    explain.classList.remove('hidden');
  }
  document.getElementById('legend-gradient').style.background =
    `linear-gradient(to right, ${COLORS.quintiles.join(', ')})`;
  document.getElementById('legend-price-title').innerHTML =
    `Prix médian au m² <span class="legend-unit">€/m²</span>`;

  const min = window._priceMin, max = window._priceMax;
  const breaks = window._quintileBreaks;
  const range = max - min;
  document.getElementById('legend-ticks').innerHTML = breaks.map(b => {
    const pct = Math.round((b - min) / range * 100);
    return `<span class="legend-tick" style="left:${pct}%"></span>`;
  }).join('');
  const fmtK = v => v >= 1000 ? `${(v/1000).toFixed(0)}k` : `${v}`;
  document.getElementById('legend-labels').innerHTML =
    [min, ...breaks, max].map(v => `<span>${fmtK(v)}</span>`).join('');
}

function buildLegendDelta(mode) {
  document.getElementById('legend-gradient').style.background =
    `linear-gradient(to right, ${DELTA_COLORS.join(', ')})`;
  document.getElementById('legend-price-title').innerHTML = mode === 'delta1y'
    ? `Variation des prix <span class="legend-unit">1 an avant·après le décret</span>`
    : `Variation des prix <span class="legend-unit">2 ans avant·après le décret</span>`;
  document.getElementById('legend-ticks').innerHTML =
    [25, 50, 75].map(p =>
      `<span class="legend-tick${p === 50 ? ' legend-tick-zero' : ''}" style="left:${p}%"></span>`
    ).join('');
  document.getElementById('legend-labels').innerHTML =
    DELTA_STOPS.map(v => {
      if (v === -15) return `<span>−15%<span class="legend-label-ext">ou moins</span></span>`;
      if (v ===  15) return `<span>+15%<span class="legend-label-ext">ou plus</span></span>`;
      if (v ===   0) return `<span class="legend-label-zero">0%</span>`;
      return `<span>${v > 0 ? '+' : ''}${v}%</span>`;
    }).join('');
  const explain = document.getElementById('legend-delta-explain');
  if (explain) {
    explain.textContent = 'Variation du prix médian au m² dans la fenêtre temporelle sélectionnée';
    explain.classList.remove('hidden');
  }
}

function updateMapMode(mode) {
  mapMode = mode;
  document.querySelectorAll('.legend-mode-btn').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.mode === mode));

  const yearRange = document.getElementById('legend-year-range');

  const choroplethOpacity = showChoropleth ? 0.72 : 0;

  if (mode === 'price') {
    yearRange.classList.remove('hidden');
    updateMapPrice(priceYearFrom, priceYearTo);
    map.setPaintProperty('communes-fill', 'fill-opacity', choroplethOpacity);
    if (map.getLayer('communes-nc-fill'))
      map.setPaintProperty('communes-nc-fill', 'fill-opacity', choroplethOpacity);
  } else {
    yearRange.classList.add('hidden');
    const prop = mode === 'delta1y' ? 'delta_1y' : 'delta_2y';
    map.setPaintProperty('communes-fill', 'fill-color', [
      'case',
      ['!', ['has', prop]], '#e2e8f0',
      ['interpolate', ['linear'], ['get', prop],
        ...DELTA_STOPS.flatMap((v,i) => [v, DELTA_COLORS[i]]),
      ],
    ]);
    map.setPaintProperty('communes-fill', 'fill-opacity', choroplethOpacity);
    // Communes sans décret : transparentes en mode delta (pas de décret de référence)
    if (map.getLayer('communes-nc-fill'))
      map.setPaintProperty('communes-nc-fill', 'fill-opacity', 0);
    buildLegendDelta(mode);
  }
}

// ── Sidebar ───────────────────────────────────────────────────
function openSidebar(props) {
  const sidebar = document.getElementById('sidebar');
  sidebar.classList.remove('hidden');
  history.replaceState(null, '', `?commune=${props.code_insee}`);

  document.getElementById('sb-name').textContent = props.nom ?? '—';
  document.getElementById('sb-dept').textContent = `Dép. ${props.departement ?? '??'}`;

  // Badge décret cliquable
  const badge = document.getElementById('sb-erosion-badge');
  if (props.decret) {
    const dateStr = props.obligation_date
      ? new Date(props.obligation_date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })
      : '';
    badge.textContent = `Décret n° ${props.decret}${dateStr ? ' · ' + dateStr : ''}`;
    badge.href = DECRET_URLS[props.decret]
      ?? `https://www.legifrance.gouv.fr/jorf/search/#jorf?query=${props.decret}`;
    badge.className = 'badge badge-decret';
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }

  // KPIs
  const rate    = props.erosion_rate;
  const rateEl  = document.getElementById('sb-rate');
  const rateNd  = document.getElementById('sb-rate-nd');
  const rateAvg = document.getElementById('sb-rate-avg');
  if (rate > 0) {
    rateEl.textContent = `${rate} m/an`;
    rateNd.hidden = true;
  } else if (props.obligation_date) {
    rateEl.textContent = 'N/D';
    rateNd.dataset.tooltip = "La commune est classée en zone d'exposition à l'érosion par le décret, mais les mesures terrain du Cerema (GéoLittoral 2018) ne couvrent pas ce secteur ou ne fournissent pas de taux précis en m/an pour ce linéaire côtier.";
    rateNd.hidden = false;
  } else {
    rateEl.textContent = '—';
    rateNd.dataset.tooltip = "Aucune mesure de recul du trait de côte disponible pour cette commune dans les données Cerema (GéoLittoral 2018).";
    rateNd.hidden = false;
  }
  const segs = props.taux_segments ?? 1;
  if (rate > 0 && segs > 1) {
    rateAvg.dataset.tooltip = `Moyenne calculée sur ${segs} tronçons mesurés par le Cerema sur ce littoral.`;
    rateAvg.hidden = false;
  } else {
    rateAvg.hidden = true;
  }

  const price = props.price_median_m2;
  document.getElementById('sb-price').textContent = price > 0 ? `${fmt(price)} €/m²` : '—';

  const delta = props.delta_2y ?? null;
  const deltaEl = document.getElementById('sb-delta');
  if (delta != null && delta !== 0) {
    deltaEl.textContent = `${delta > 0 ? '+' : ''}${delta.toFixed(1)} %`;
    deltaEl.className = 'kpi-value ' + (delta >= 0 ? 'pos' : 'neg');
  } else {
    deltaEl.textContent = '—';
    deltaEl.className = 'kpi-value';
  }

  // Price chart — MapLibre serializes nested objects as JSON strings
  const byS = typeof props.price_by_semester === 'string'
    ? JSON.parse(props.price_by_semester)
    : (props.price_by_semester ?? {});
  const semStats = typeof props.price_by_semester_stats === 'string'
    ? JSON.parse(props.price_by_semester_stats)
    : (props.price_by_semester_stats ?? {});

  const labels = SEMESTERS.map(s => s.replace('-', ' '));
  const data   = SEMESTERS.map(s => byS?.[s] ?? null);

  // IC 95% pour la médiane : médiane ± 1.57 × IQR / √n  (Kendall & Stuart)
  const upperBand = SEMESTERS.map(s => {
    const med = byS[s], st = semStats[s];
    if (med == null || !st) return null;
    return Math.round(med + 1.57 * (st.q3 - st.q1) / Math.sqrt(st.n));
  });
  const lowerBand = SEMESTERS.map(s => {
    const med = byS[s], st = semStats[s];
    if (med == null || !st) return null;
    return Math.round(Math.max(0, med - 1.57 * (st.q3 - st.q1) / Math.sqrt(st.n)));
  });

  // Ligne de décret : position dynamique selon la date réelle de la commune
  const obligSemIdx = props.obligation_date
    ? SEMESTERS.indexOf(dateToSem(props.obligation_date))
    : -1;
  const lawLineValue   = obligSemIdx >= 0 ? obligSemIdx - 0.5 : -1;
  const lawLineVisible = obligSemIdx >= 0;
  const lawDateStr     = props.obligation_date
    ? new Date(props.obligation_date).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })
    : null;

  const lawLabelEl = document.querySelector('.chart-law-label');
  if (lawLabelEl) {
    lawLabelEl.innerHTML = lawDateStr
      ? `◀ avant&nbsp;·&nbsp;${lawDateStr}&nbsp;·&nbsp;après ▶`
      : `◀ avant&nbsp;·&nbsp;après ▶`;
  }

  if (priceChart) priceChart.destroy();
  priceChart = new Chart(document.getElementById('price-chart').getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          // Borne supérieure IC — remplit jusqu'à la borne inférieure
          data: upperBand,
          borderColor: 'transparent',
          borderWidth: 0,
          backgroundColor: 'rgba(14,165,233,0.15)',
          pointRadius: 0,
          fill: '+1',
          tension: 0.3,
          spanGaps: true,
        },
        {
          // Borne inférieure IC
          data: lowerBand,
          borderColor: 'transparent',
          borderWidth: 0,
          backgroundColor: 'transparent',
          pointRadius: 0,
          fill: false,
          tension: 0.3,
          spanGaps: true,
        },
        {
          // Médiane
          data,
          borderColor: '#0ea5e9',
          backgroundColor: 'transparent',
          borderWidth: 2,
          fill: false,
          tension: 0.3,
          pointRadius: 4,
          pointHoverRadius: 6,
          spanGaps: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          filter: (item) => item.datasetIndex === 2,
          callbacks: {
            label: (ctx) => {
              if (ctx.raw == null) return 'N/D';
              const s = SEMESTERS[ctx.dataIndex];
              const st = semStats[s];
              const base = `${fmt(ctx.raw)} €/m²`;
              if (!st) return base;
              const h = Math.round(1.57 * (st.q3 - st.q1) / Math.sqrt(st.n));
              return `${base}  ±${fmt(h)} (n=${st.n})`;
            },
          },
        },
        annotation: {
          annotations: {
            lawLine: {
              type: 'line',
              scaleID: 'x',
              value: lawLineValue,
              display: lawLineVisible,
              borderColor: '#f97316',
              borderWidth: 1.5,
              borderDash: [4, 3],
              label: {
                content: lawDateStr ? `Décret ${lawDateStr}` : 'Décret',
                display: false,
              },
            },
          },
        },
      },
      scales: {
        x: { ticks: { font: { size: 10 } }, grid: { display: false } },
        y: {
          ticks: {
            font: { size: 10 },
            callback: (v) => v >= 1000
              ? `${(v / 1000).toFixed(1).replace(/\.0$/, '')}k€`
              : `${v}€`,
          },
        },
      },
    },
  });

  // Store current feature for comparison
  sidebar._currentProps = props;

  document.getElementById('compare-add-btn').onclick = () => {
    addToCompare(props);
  };
}

document.getElementById('sidebar-close').onclick = () => {
  document.getElementById('sidebar').classList.add('hidden');
  history.replaceState(null, '', location.pathname);
};

document.getElementById('legend-toggle').addEventListener('click', () => {
  const legend = document.getElementById('map-legend');
  const btn    = document.getElementById('legend-toggle');
  const collapsed = legend.classList.toggle('legend-collapsed');
  btn.setAttribute('aria-expanded', String(!collapsed));
});

// Collapse legend by default on small screens
if (window.innerWidth <= 640) {
  const legend = document.getElementById('map-legend');
  const btn    = document.getElementById('legend-toggle');
  legend.classList.add('legend-collapsed');
  btn.setAttribute('aria-expanded', 'false');
}

// ── Scatter ───────────────────────────────────────────────────
function initScatter() {
  const ctx = document.getElementById('scatter-chart').getContext('2d');

  _scatterGroups = [
    { label: 'Communes sous décret', color: COLORS.dot.decret },
  ];
  const SCATTER_GROUPS = _scatterGroups;

  const symlog    = y => Math.sign(y) * Math.log10(1 + Math.abs(y));
  const symlogInv = v => Math.sign(v) * (Math.pow(10, Math.abs(v)) - 1);

  _buildDataset = (group, logX = false, logY = false, animated = false) => ({
    label: group.label,
    order: 1,
    data: scatterData
      .filter(d => !logX || (d.erosion_rate > 0))
      .map(d => ({
        x: d.erosion_rate,
        y: animated ? 0 : (logY ? symlog(d.price_delta_pct) : d.price_delta_pct),
        nom: d.nom,
        orig: d.price_delta_pct,
        segs: d.taux_segments ?? 1,
      })),
    backgroundColor: group.color + 'cc',
    borderColor: group.color,
    borderWidth: 1.5,
    pointRadius: 6,
    pointHoverRadius: 9,
  });
  const buildDataset = _buildDataset;

  // ── Régression linéaire avec IC 95% ─────────────────────────
  function linRegressionFull(pts) {
    const n = pts.length;
    if (n < 4) return null;
    const xMean = pts.reduce((s, p) => s + p.x, 0) / n;
    const yMean = pts.reduce((s, p) => s + p.y, 0) / n;
    const Sxx   = pts.reduce((s, p) => s + Math.pow(p.x - xMean, 2), 0);
    const Sxy   = pts.reduce((s, p) => s + (p.x - xMean) * (p.y - yMean), 0);
    if (!Sxx) return null;
    const slope     = Sxy / Sxx;
    const intercept = yMean - slope * xMean;
    const RSS  = pts.reduce((s, p) => s + Math.pow(p.y - (slope * p.x + intercept), 2), 0);
    const sRes = Math.sqrt(RSS / (n - 2));
    return { slope, intercept, sRes, xMean, Sxx, n };
  }

  const TREND_IDX    = SCATTER_GROUPS.length;      // 1
  const CI_UPPER_IDX = SCATTER_GROUPS.length + 1;  // 2
  const CI_LOWER_IDX = SCATTER_GROUPS.length + 2;  // 3

  // Régression toujours en espace brut (jamais symlog ni log10).
  // logX : espace les points de la courbe en log10(x) pour une couverture uniforme sur axe log
  //        (sans ça, les points s'entassent à droite et un gouffre apparaît < 0.1 m/an).
  //        La régression reste inchangée — seule la grille d'échantillonnage change.
  // logY : transforme y en symlog pour l'affichage ; orig garde la valeur brute pour le tooltip.
  function computeTrendData(logX = false, logY = false) {
    const pts = scatterData
      .filter(d => d.erosion_rate != null && d.price_delta_pct != null && d.erosion_rate > 0)
      .map(d => ({ x: d.erosion_rate, y: d.price_delta_pct }));
    const reg = linRegressionFull(pts);
    if (!reg) return { lineData: [], upperData: [], lowerData: [] };
    const { slope, intercept, sRes, xMean, Sxx, n } = reg;
    const xs  = pts.map(p => p.x);
    const xMin = Math.min(...xs), xMax = Math.max(...xs);
    const N = 60;
    const lineData = [], upperData = [], lowerData = [];
    for (let i = 0; i <= N; i++) {
      // échantillonnage uniforme en log10 si logX, linéaire sinon
      const xf = logX
        ? Math.pow(10, Math.log10(xMin) + (Math.log10(xMax) - Math.log10(xMin)) * i / N)
        : xMin + (xMax - xMin) * i / N;
      const yRaw = slope * xf + intercept;
      const ci   = 1.96 * sRes * Math.sqrt(1 / n + Math.pow(xf - xMean, 2) / Sxx);
      lineData.push({  x: +xf.toFixed(4), y: +(logY ? symlog(yRaw)      : yRaw).toFixed(4),      orig: +yRaw.toFixed(2) });
      upperData.push({ x: +xf.toFixed(4), y: +(logY ? symlog(yRaw + ci) : yRaw + ci).toFixed(4) });
      lowerData.push({ x: +xf.toFixed(4), y: +(logY ? symlog(yRaw - ci) : yRaw - ci).toFixed(4) });
    }
    return { lineData, upperData, lowerData };
  }

  function applyTrend(logX, logY) {
    const { lineData, upperData, lowerData } = computeTrendData(logX, logY);
    scatterChart.data.datasets[TREND_IDX].data    = lineData;
    scatterChart.data.datasets[CI_UPPER_IDX].data = upperData;
    scatterChart.data.datasets[CI_LOWER_IDX].data = lowerData;
  }

  // Visibilité via le méta interne Chart.js — évite les désyncros avec dataset.hidden
  function setTrendVisible(show) {
    [TREND_IDX, CI_UPPER_IDX, CI_LOWER_IDX].forEach(idx => {
      scatterChart.getDatasetMeta(idx).hidden = !show;
    });
  }

  const { lineData: ld0, upperData: ud0, lowerData: lod0 } = computeTrendData(false, false);
  const datasets = [
    buildDataset(SCATTER_GROUPS[0]),
    { type: 'line', label: 'Tendance', hidden: true, tension: 0,
      pointRadius: 0, hitRadius: 8, fill: false, order: 2,
      data: ld0, borderColor: '#ef4444', borderWidth: 2, borderDash: [6, 3] },
    { type: 'line', label: '_ci_upper', hidden: true, tension: 0,
      pointRadius: 0, hitRadius: 0, fill: '+1', order: 0,
      data: ud0, borderColor: 'transparent', backgroundColor: 'rgba(239,68,68,0.12)' },
    { type: 'line', label: '_ci_lower', hidden: true, tension: 0,
      pointRadius: 0, hitRadius: 0, fill: false, order: 0,
      data: lod0, borderColor: 'transparent', backgroundColor: 'transparent' },
  ];

  scatterChart = new Chart(ctx, {
    type: 'scatter',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        tooltip: {
          filter: item => item.datasetIndex <= SCATTER_GROUPS.length,
          callbacks: {
            label: (ctx) => {
              if (ctx.datasetIndex < SCATTER_GROUPS.length) {
                const d = ctx.raw;
                const yReal = d.orig ?? (scatterLogY ? symlogInv(d.y) : d.y);
                const avgNote = d.segs > 1 ? ` (moy. ${d.segs} tronçons)` : '';
                return `${d.nom} — recul: ${d.x} m/an${avgNote}, variation: ${yReal > 0 ? '+' : ''}${yReal?.toFixed(1) ?? '?'}%`;
              }
              const xR = ctx.raw.x;
              const yReal = ctx.raw.orig ?? ctx.raw.y;
              return `Tendance à ${xR.toFixed(2)} m/an : ${yReal > 0 ? '+' : ''}${yReal.toFixed(1)} %`;
            },
          },
        },
        legend: { display: false },
      },
      scales: {
        x: {
          type: 'linear',
          title: { display: true, text: 'Taux de recul côtier (m/an)', font: { size: 12 } },
          ticks: {
            maxRotation: 0,
            callback: (v) => {
              if (scatterLogX) {
                if (v <= 0) return null;
                const frac = Math.log10(v) - Math.floor(Math.log10(v));
                const atNice = [0, Math.log10(2), Math.log10(5)]
                  .some(n => Math.abs(frac - n) < 0.015);
                return atNice ? `${v} m/an` : null;
              }
              return `${v} m/an`;
            },
          },
          grid: { color: '#f1f5f9' },
        },
        y: {
          title: { display: true, text: 'Variation prix médian post-décret (%)', font: { size: 12 } },
          ticks: {
            callback: v => {
              const orig = scatterLogY ? symlogInv(v) : v;
              return `${orig > 0 ? '+' : ''}${orig.toFixed(scatterLogY ? 1 : 0)}%`;
            },
          },
          grid: { color: '#f1f5f9' },
        },
      },
    },
  });

  document.getElementById('toggle-log-x').addEventListener('change', (e) => {
    scatterLogX = e.target.checked;
    scatterChart.options.scales.x.type = scatterLogX ? 'logarithmic' : 'linear';
    scatterChart.data.datasets[0].data = buildDataset(SCATTER_GROUPS[0], scatterLogX, scatterLogY).data;
    applyTrend(scatterLogX, scatterLogY);
    scatterChart.update();
  });

  document.getElementById('toggle-log-y').addEventListener('change', (e) => {
    scatterLogY = e.target.checked;
    scatterChart.data.datasets[0].data = buildDataset(SCATTER_GROUPS[0], scatterLogX, scatterLogY).data;
    applyTrend(scatterLogX, scatterLogY);
    scatterChart.update();
  });

  document.getElementById('toggle-trend').addEventListener('change', (e) => {
    const show = e.target.checked;
    if (show) applyTrend(scatterLogX, scatterLogY);
    setTrendVisible(show);
    scatterChart.update();
  });
}

// ── Comparison ────────────────────────────────────────────────
function addToCompare(props) {
  setView('compare');
  addToCompareSelection(props);
}

function addToCompareSelection(props) {
  const code = props.code_insee;
  if (compareSelections.some(p => p.code_insee === code)) return;
  if (compareSelections.length >= COMPARE_MAX) return;
  compareSelections.push(props);
  renderCompareChips();
  renderComparePanels();
  renderOverlayChart();
}

function removeFromCompare(code) {
  compareSelections = compareSelections.filter(p => p.code_insee !== code);
  const ch = compareCharts.get(code);
  if (ch) { ch.destroy(); compareCharts.delete(code); }
  renderCompareChips();
  renderComparePanels();
  renderOverlayChart();
}

function renderCompareChips() {
  const container = document.getElementById('compare-chips');
  if (!container) return;
  container.innerHTML = compareSelections.map((p, i) => {
    const color = COMPARE_COLORS[i % COMPARE_COLORS.length];
    return `<span class="compare-chip" style="--chip-color:${color}" data-code="${p.code_insee}">
      <span class="chip-dot" style="background:${color}"></span>
      ${p.nom}
      <button class="chip-remove" aria-label="Retirer">×</button>
    </span>`;
  }).join('');
  container.querySelectorAll('.chip-remove').forEach(btn => {
    btn.addEventListener('click', () => removeFromCompare(btn.closest('.compare-chip').dataset.code));
  });
  const box = document.getElementById('compare-search-box');
  if (box) box.style.display = compareSelections.length >= COMPARE_MAX ? 'none' : '';
}

function renderComparePanels() {
  // Destroy charts for communes no longer selected
  for (const [code, ch] of compareCharts) {
    if (!compareSelections.some(p => p.code_insee === code)) {
      ch.destroy(); compareCharts.delete(code);
    }
  }

  const container = document.getElementById('compare-panels');
  if (!container) return;

  if (!compareSelections.length) {
    container.innerHTML = '<p class="compare-empty-hint">Ajoutez des communes via la recherche ou en cliquant sur la carte.</p>';
    return;
  }

  // Remove panels for deselected communes
  container.querySelectorAll('.compare-panel[data-code]').forEach(panel => {
    if (!compareSelections.some(p => p.code_insee === panel.dataset.code)) panel.remove();
  });

  // Add/refresh panels in selection order
  const existing = [...container.querySelectorAll('.compare-panel[data-code]')];
  compareSelections.forEach((props, i) => {
    const color = COMPARE_COLORS[i % COMPARE_COLORS.length];
    let panel = container.querySelector(`.compare-panel[data-code="${props.code_insee}"]`);
    if (!panel) {
      panel = document.createElement('div');
      panel.className = 'compare-panel';
      panel.dataset.code = props.code_insee;
      container.appendChild(panel);
    }
    renderSingleComparePanel(panel, props, color);
  });
}

function renderSingleComparePanel(panel, props, color) {
  const code = props.code_insee;
  const byS  = typeof props.price_by_semester === 'string'
    ? JSON.parse(props.price_by_semester)
    : (props.price_by_semester ?? {});
  const labels = SEMESTERS.map(s => s.replace('-', ' '));
  const data   = SEMESTERS.map(s => byS[s] ?? null);

  const badgeHtml = props.erosion_class
    ? `<span class="badge badge-decret">Commune sous décret</span>`
    : '<span class="badge badge-neutral">Sans décret</span>';
  const delta = props.delta_2y ?? null;
  const deltaStr = (delta != null && delta !== 0)
    ? `<span style="color:${delta >= 0 ? '#dc2626' : '#16a34a'}">${delta > 0 ? '+' : ''}${delta.toFixed(1)}%</span>`
    : '—';

  panel.innerHTML = `
    <div class="compare-panel-header" style="border-left:3px solid ${color};padding-left:10px">
      <p class="compare-commune-name">${props.nom ?? '—'}</p>
      <div class="badges" style="margin-top:6px">${badgeHtml}</div>
    </div>
    <div class="kpi-row">
      <div class="kpi"><span class="kpi-label">Recul</span><span class="kpi-value">${props.erosion_rate > 0 ? props.erosion_rate + ' m/an' : '—'}</span></div>
      <div class="kpi"><span class="kpi-label">Prix médian</span><span class="kpi-value">${props.price_median_m2 > 0 ? fmt(props.price_median_m2) + ' €/m²' : '—'}</span></div>
      <div class="kpi"><span class="kpi-label">Variation ±2 ans</span><span class="kpi-value">${deltaStr}</span></div>
    </div>
    <div class="compare-canvas-wrap"><canvas id="compare-chart-${code}"></canvas></div>
  `;

  const old = compareCharts.get(code);
  if (old) { old.destroy(); compareCharts.delete(code); }

  if (compareViewMode === 'side') {
    const canvas = document.getElementById(`compare-chart-${code}`);
    if (!canvas) return;
    const ch = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: { labels, datasets: [{ data, borderColor: color, backgroundColor: color + '18',
        borderWidth: 2, fill: true, tension: 0.3, pointRadius: 4, spanGaps: true }] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: false },
          tooltip: { callbacks: { label: (c) => c.raw != null ? `${fmt(c.raw)} €/m²` : 'N/D' } } },
        scales: {
          x: { ticks: { font: { size: 9 } }, grid: { display: false } },
          y: { ticks: { font: { size: 9 }, callback: (v) => v >= 1000 ? `${(v/1000).toFixed(1).replace(/\.0$/,'')}k€` : `${v}€` } },
        },
      },
    });
    compareCharts.set(code, ch);
  }
}

function setCompareViewMode(mode) {
  compareViewMode = mode;
  document.getElementById('btn-compare-side').classList.toggle('active', mode === 'side');
  document.getElementById('btn-compare-overlay').classList.toggle('active', mode === 'overlay');
  const panels  = document.getElementById('compare-panels');
  const overlay = document.getElementById('compare-overlay');
  if (mode === 'overlay') {
    panels.classList.add('overlay-mode');
    overlay.classList.remove('hidden');
    renderOverlayChart();
  } else {
    panels.classList.remove('overlay-mode');
    overlay.classList.add('hidden');
    if (compareOverlayChart) { compareOverlayChart.destroy(); compareOverlayChart = null; }
    renderComparePanels(); // recreate individual charts now that canvases are visible
  }
}

function renderOverlayChart() {
  if (compareViewMode !== 'overlay') return;

  const labels   = SEMESTERS.map(s => s.replace('-', ' '));
  const datasets = compareSelections.map((props, i) => {
    const color = COMPARE_COLORS[i % COMPARE_COLORS.length];
    const byS   = typeof props.price_by_semester === 'string'
      ? JSON.parse(props.price_by_semester)
      : (props.price_by_semester ?? {});
    return {
      label: props.nom,
      data:  SEMESTERS.map(s => byS[s] ?? null),
      borderColor: color, backgroundColor: 'transparent',
      borderWidth: 2.5, fill: false, tension: 0.3, pointRadius: 3, spanGaps: true,
    };
  });

  const legendEl = document.getElementById('compare-overlay-legend');
  if (legendEl) {
    legendEl.innerHTML = compareSelections.map((p, i) => {
      const color = COMPARE_COLORS[i % COMPARE_COLORS.length];
      return `<span class="overlay-legend-item" style="--legend-color:${color}">${p.nom}</span>`;
    }).join('');
  }

  const canvas = document.getElementById('compare-overlay-chart');
  if (!canvas) return;
  if (compareOverlayChart) { compareOverlayChart.destroy(); compareOverlayChart = null; }
  if (!datasets.length) return;

  compareOverlayChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => c.raw != null
          ? `${c.dataset.label} : ${fmt(c.raw)} €/m²`
          : `${c.dataset.label} : N/D` } },
      },
      scales: {
        x: { ticks: { font: { size: 9 } }, grid: { display: false } },
        y: { ticks: { font: { size: 10 }, callback: (v) => v >= 1000
          ? `${(v/1000).toFixed(1).replace(/\.0$/,'')}k€` : `${v}€` } },
      },
    },
  });
}

function exportCompareCSV() {
  if (!compareSelections.length) return;
  const cols = ['Commune','Département','Classe érosion','Recul (m/an)','Prix médian (€/m²)','Variation post-décret (%)'];
  SEMESTERS.forEach(s => cols.push(s));

  const rows = compareSelections.map(p => {
    const byS = typeof p.price_by_semester === 'string'
      ? JSON.parse(p.price_by_semester) : (p.price_by_semester ?? {});
    const row = [
      p.nom ?? '',
      p.departement ?? '',
      p.erosion_class ?? '',
      p.erosion_rate > 0 ? p.erosion_rate : '',
      p.price_median_m2 > 0 ? p.price_median_m2 : '',
      p.price_delta_pct != null ? p.price_delta_pct.toFixed(1) : '',
    ];
    SEMESTERS.forEach(s => row.push(byS[s] ?? ''));
    return row;
  });

  const esc = v => `"${String(v).replace(/"/g, '""')}"`;
  const csv = [cols, ...rows].map(r => r.map(esc).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'comparaison_communes.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

function exportComparePDF() {
  window.print();
}

function bindCompare() {
  document.getElementById('btn-compare-side').addEventListener('click',    () => setCompareViewMode('side'));
  document.getElementById('btn-compare-overlay').addEventListener('click', () => setCompareViewMode('overlay'));
  document.getElementById('btn-export-csv').addEventListener('click', exportCompareCSV);
  document.getElementById('btn-export-pdf').addEventListener('click', exportComparePDF);

  // Search across decree + nc communes
  const input    = document.getElementById('compare-search-input');
  const dropdown = document.getElementById('compare-search-results');
  if (!input || !dropdown) return;

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (q.length < 2) { dropdown.classList.add('hidden'); return; }

    const allFeats = [
      ...(geojson?.features ?? []),
      ...(nodecretGeojson?.features ?? []),
    ];
    const matches = allFeats
      .filter(f => f.properties.nom?.toLowerCase().includes(q))
      .filter(f => !compareSelections.some(s => s.code_insee === f.properties.code_insee))
      .slice(0, 8);

    if (!matches.length) { dropdown.classList.add('hidden'); return; }

    dropdown.innerHTML = matches.map(f => {
      const p = f.properties;
      const cls = p.erosion_class;
      const badgeHtml = cls ? `<span class="item-badge badge-decret">Décret</span>` : '';
      return `<li data-code="${p.code_insee}">
        <span>${p.nom}</span>
        <span class="item-sub">${p.departement ?? ''} ${badgeHtml}</span>
      </li>`;
    }).join('');
    dropdown.classList.remove('hidden');

    dropdown.querySelectorAll('li').forEach(li => {
      li.addEventListener('click', () => {
        const code = li.dataset.code;
        const feat = [...(geojson?.features ?? []), ...(nodecretGeojson?.features ?? [])]
          .find(f => f.properties.code_insee === code);
        if (!feat) return;
        dropdown.classList.add('hidden');
        input.value = '';
        addToCompareSelection(feat.properties);
      });
    });
  });

  document.addEventListener('click', (e) => {
    if (!input.contains(e.target) && !dropdown.contains(e.target))
      dropdown.classList.add('hidden');
  });
}

// ── Search ────────────────────────────────────────────────────
function bindSearch(inputSel, dropdownSel, onSelect) {
  const input    = document.querySelector(inputSel);
  const dropdown = document.querySelector(dropdownSel);

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (q.length < 2) { dropdown.classList.add('hidden'); return; }

    const matches = geojson?.features
      .filter(f => f.properties.nom?.toLowerCase().includes(q))
      .slice(0, 8) ?? [];

    if (!matches.length) { dropdown.classList.add('hidden'); return; }

    dropdown.innerHTML = matches.map(f => {
      const p   = f.properties;
      const cls = p.erosion_class;
      const badgeTxt = cls === 'fort' ? 'Fort' : cls === 'moyen' ? 'Moyen' : '';
      const badgeCls = cls ? `item-badge badge-${cls}` : '';
      return `<li data-code="${p.code_insee}">
        <span>${p.nom}</span>
        <span class="item-sub">
          ${p.departement ?? ''} ${badgeTxt ? `<span class="${badgeCls}">${badgeTxt}</span>` : ''}
        </span>
      </li>`;
    }).join('');

    dropdown.classList.remove('hidden');

    dropdown.querySelectorAll('li').forEach(li => {
      li.addEventListener('click', () => {
        const code = li.dataset.code;
        const feat = geojson.features.find(f => f.properties.code_insee === code);
        if (!feat) return;
        dropdown.classList.add('hidden');
        input.value = feat.properties.nom;
        onSelect(feat.properties);
      });
    });
  });

  document.addEventListener('click', (e) => {
    if (!input.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.classList.add('hidden');
    }
  });
}

function onSearchSelect(props) {
  // Fly to commune on the map
  if (map) {
    const feat = geojson?.features.find(f => f.properties.code_insee === props.code_insee);
    if (feat?.geometry) {
      const coords = collectCoords(feat.geometry);
      if (coords.length) {
        const lngs = coords.map(c => c[0]);
        const lats = coords.map(c => c[1]);
        map.fitBounds(
          [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
          { padding: 80, maxZoom: 13, duration: 600 }
        );
      }
    }
  }
  setView('map');
  openSidebar(props);
  document.getElementById('search-input').value = '';
  document.getElementById('search-results').classList.add('hidden');
}

function collectCoords(geom) {
  if (geom.type === 'Polygon')      return geom.coordinates.flat();
  if (geom.type === 'MultiPolygon') return geom.coordinates.flat(2);
  return [];
}

// ── Navigation ────────────────────────────────────────────────
function bindNav() {
  document.getElementById('btn-map')    .addEventListener('click', () => setView('map'));
  document.getElementById('btn-scatter').addEventListener('click', () => setView('scatter'));
  document.getElementById('btn-compare').addEventListener('click', () => setView('compare'));
  document.getElementById('btn-about')  .addEventListener('click', () => setView('about'));
}

function setView(name) {
  ['map','scatter','compare','about'].forEach(v => {
    document.getElementById(`view-${v}`).classList.toggle('active',  v === name);
    document.getElementById(`view-${v}`).classList.toggle('hidden', v !== name);
    document.getElementById(`btn-${v}`).classList.toggle('active', v === name);
    document.getElementById(`btn-${v}`).setAttribute('aria-selected', v === name);
  });
  if (name === 'scatter') scatterChart?.resize();
}

// ── Helpers ───────────────────────────────────────────────────
function fmt(v) {
  return v != null ? Math.round(v).toLocaleString('fr-FR') : '—';
}

// ── Boot ──────────────────────────────────────────────────────
init().catch(console.error);
