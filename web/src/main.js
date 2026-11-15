import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet-draw/dist/leaflet.draw.css';
import * as d3 from 'd3';
import './style.css';
import { aggregate, loadIndex, loadOverview, loadTrust, TRUST, toCSV, cellsCSV, ymLabel, ymYear, ymMonth, MONTHS } from './data.js';
import { drawCalendar, drawAnomaly, drawSeason, drawAnnual, monthlyMedians, valueAt, fmtN } from './charts.js';
import { completeYears, trend, outlook, level, criticalPeriod } from './analytics.js';
import { downloadPNG } from './export.js';
import { fetchLive, renderLiveCard, liveComparison, liveCSV, ageBin, popupHtml, AGE_BINS } from './live.js';
import { parseGeoJSON } from './geojson.js';
import { renderMethod, renderAbout } from './pages.js';

window.L = L;
await import('leaflet-draw');

const PRESETS = [
  { id: 'blacksummer', name: 'Black Summer — NSW & VIC coast', bbox: { s: -38.0, n: -28.5, w: 146.5, e: 153.7 }, focus: 19 * 12 + 11 },
  { id: 'kangaroo', name: 'Kangaroo Island, SA', bbox: { s: -36.1, n: -35.55, w: 136.5, e: 138.15 }, focus: 20 * 12 + 0 },
  { id: 'bluemtns', name: 'Blue Mountains & Sydney', bbox: { s: -34.5, n: -33.0, w: 149.8, e: 151.4 }, focus: 19 * 12 + 11 },
  { id: 'topend', name: 'Top End (Kakadu), NT', bbox: { s: -14.5, n: -12.0, w: 131.5, e: 133.5 } },
  { id: 'kimberley', name: 'Kimberley, WA', bbox: { s: -18.5, n: -14.0, w: 124.0, e: 129.0 } },
  { id: 'tasmania', name: 'Tasmania', bbox: { s: -43.7, n: -40.6, w: 144.5, e: 148.5 } },
  { id: 'australia', name: 'All of Australia', bbox: { s: -44, n: -9, w: 112, e: 154 } },
];
const SERIES_NAME = {
  harm: 'Harmonised VIIRS-equivalent detections', modis: 'Raw MODIS detections',
  snpp: 'Raw VIIRS S-NPP detections', n20: 'Raw VIIRS NOAA-20 detections',
};
const SHAPE_STYLE = { color: '#e8590c', weight: 2, fillOpacity: 0.05 };

const state = {
  area: null, label: '', presetId: null, agg: null, series: 'harm', mode: 'count', selected: null,
  from: null, to: null, pendingRange: null,
  live: null, liveOn: true, liveToken: 0,
};

// ---------------------------------------------------------------- map
const map = L.map('map', { zoomSnap: 0.25, minZoom: 3, maxBounds: [[-50, 100], [0, 170]] }).fitBounds([[-44, 112], [-10, 154]]);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 13,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · Fire data: NASA FIRMS',
}).addTo(map);

const fireRamp = (t) => d3.interpolateInferno(0.12 + 0.83 * t);
const layersCtl = L.control.layers(null, null, { collapsed: true, position: 'topright' }).addTo(map);

// live fires layer (last 7 days, from /api/recent)
map.createPane('livePane');
map.getPane('livePane').style.zIndex = 450;
// One canvas per map tile; scales to ~100k points (a Leaflet marker per point would not).
const LiveDots = L.GridLayer.extend({
  // Leaflet 1.9's GridLayer.redraw() uses the unrounded map zoom; with fractional zoom (zoomSnap 0.25)
  // it builds tiles on a misaligned grid and most stay blank. _resetView() rounds the tile zoom correctly.
  redraw() {
    if (this._map) { this._removeAllTiles(); this._resetView(); }
    return this;
  },
  createTile(coords) {
    const tile = document.createElement('canvas');
    const size = this.getTileSize();
    tile.width = size.x; tile.height = size.y;
    const pts = state.live?.pts;
    if (!pts) return tile;
    const ctx = tile.getContext('2d');
    const nw = coords.scaleBy(size);
    const r = coords.z >= 8 ? 5 : coords.z >= 6 ? 4 : 3;
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(43,29,20,0.75)';
    // oldest first so the newest detections draw on top
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      if (!p.good) continue;
      const q = map.project([p.lat, p.lon], coords.z).subtract(nw);
      if (q.x < -r || q.y < -r || q.x > size.x + r || q.y > size.y + r) continue;
      ctx.beginPath();
      ctx.arc(q.x, q.y, r, 0, 2 * Math.PI);
      ctx.fillStyle = ageBin(p.ageH).color;
      ctx.fill();
      ctx.stroke();
    }
    return tile;
  },
});
const liveLayer = new LiveDots({ pane: 'livePane' }).addTo(map);
let drawing = false;
map.on('draw:drawstart', () => { drawing = true; });
map.on('draw:drawstop', () => { setTimeout(() => { drawing = false; }, 0); });
map.on('click', (e) => {
  if (drawing || !state.liveOn || !state.live) return;
  const c = map.latLngToContainerPoint(e.latlng);
  let best = null, bestD = 64; // within 8 px
  for (const p of state.live.pts) {
    if (!p.good) continue;
    const q = map.latLngToContainerPoint([p.lat, p.lon]);
    const d = (q.x - c.x) ** 2 + (q.y - c.y) ** 2;
    if (d < bestD) { bestD = d; best = p; }
  }
  if (best) L.popup().setLatLng([best.lat, best.lon]).setContent(popupHtml(best)).openOn(map);
});
layersCtl.addOverlay(liveLayer, 'Live fires — last 7 days');
map.on('overlayadd overlayremove', (e) => {
  if (e.layer !== liveLayer) return;
  state.liveOn = e.type === 'overlayadd';
  const t = document.getElementById('live-map-toggle');
  if (t) t.checked = state.liveOn;
  updateLiveLegend();
});

loadOverview().then((ov) => {
  const res = ov.res;
  const maxV = d3.max(ov.cells, (c) => c[2]);
  const scale = d3.scaleLog().domain([1, maxV]).range([0, 1]).clamp(true);
  const cells = ov.cells.map(([qy, qx, h]) => ({ s: qy * res, w: qx * res, c: fireRamp(scale(h)) }));
  const Overview = L.GridLayer.extend({
    createTile(coords) {
      const tile = document.createElement('canvas');
      const size = this.getTileSize();
      tile.width = size.x; tile.height = size.y;
      const ctx = tile.getContext('2d');
      const nwPoint = coords.scaleBy(size);
      const z = coords.z;
      const b = L.latLngBounds(map.unproject(nwPoint, z), map.unproject(nwPoint.add(size), z));
      ctx.globalAlpha = 0.5;
      for (const c of cells) {
        if (c.s > b.getNorth() || c.s + res < b.getSouth() || c.w > b.getEast() || c.w + res < b.getWest()) continue;
        const p1 = map.project([c.s + res, c.w], z).subtract(nwPoint);
        const p2 = map.project([c.s, c.w + res], z).subtract(nwPoint);
        ctx.fillStyle = c.c;
        ctx.fillRect(Math.floor(p1.x), Math.floor(p1.y), Math.ceil(p2.x - p1.x), Math.ceil(p2.y - p1.y));
      }
      return tile;
    },
  });
  const layer = new Overview({ pane: 'overlayPane', opacity: 0.85 });
  layer.addTo(map);
  layersCtl.addOverlay(layer, 'All-time fire density (harmonised)');
  loadTrust().then((t) => {
    trustByTile = Object.fromEntries(t.tiles.map((c) => [c.tile, c]));
    render();
    const trustLayer = L.layerGroup(t.tiles.map((c) => L.rectangle([[c.lat0, c.lon0], [c.lat0 + 1, c.lon0 + 1]], {
      stroke: false, fillColor: TRUST[c.class].color, fillOpacity: 0.55,
    }).bindTooltip(`${TRUST[c.class].label}<br>Typical error ${Math.round(c.err * 100)}%`, { sticky: true })));
    layersCtl.addOverlay(trustLayer, 'Harmonisation trust (1° tiles)');
  });
  document.getElementById('map-legend').innerHTML =
    `<span>All-time detections per 0.25°</span><i style="background:linear-gradient(90deg,${d3.range(0, 1.01, 0.2).map(fireRamp).join(',')})"></i><span class="lg-ends"><b>1</b><b>${d3.format('.2s')(maxV)}</b></span><div id="live-legend"></div>`;
  updateLiveLegend();
});

function updateLiveLegend() {
  const el = document.getElementById('live-legend');
  if (!el) return;
  el.innerHTML = state.liveOn && state.live
    ? `<span>Live fires (last 7 days)</span><span class="live-keys">${AGE_BINS.map((b) => `<i class="ldot" style="background:${b.color}"></i>${b.label}`).join(' ')}</span>`
    : '';
}

function drawLiveMarkers() {
  liveLayer.redraw();
  updateLiveLegend();
}

async function loadLive() {
  const token = ++state.liveToken;
  const el = document.getElementById('live');
  el.innerHTML = '<span class="spinner"></span> Loading live detections from NASA FIRMS…';
  state.live = null;
  liveLayer.redraw();
  renderStatus(); // archive-based status until live data arrives
  try {
    const live = await fetchLive(state.area);
    if (token !== state.liveToken) return; // a newer area was selected meanwhile
    state.live = live;
    drawLiveMarkers();
    renderLive();
  } catch (err) {
    if (token !== state.liveToken) return;
    el.innerHTML = `<p class="hint">Live data is unavailable right now (${String(err.message).slice(0, 120)}). The historical calendar below is unaffected.</p>`;
    renderStatus();
  }
}

function renderLive() {
  if (!state.live || !state.agg) return;
  const meds = monthlyMedians(state.agg, 'harm');
  const monthIdx = new Date(`${state.live.to}T00:00:00Z`).getUTCMonth();
  renderLiveCard(document.getElementById('live'), state.live, {
    typicalMonth: meds[monthIdx].median, monthIdx, mapOn: state.liveOn,
    onToggleMap: (on) => { if (on) liveLayer.addTo(map); else map.removeLayer(liveLayer); },
  });
  renderStatus();
}

// ---------------------------------------------------------------- early-warning status banner
const STATUS_LEVELS = [
  { min: 2, key: 'veryhigh', icon: '▲▲', label: 'Very high' },
  { min: 1.5, key: 'elevated', icon: '▲', label: 'Elevated' },
  { min: 0.67, key: 'normal', icon: '●', label: 'Normal' },
  { min: 0, key: 'below', icon: '▼', label: 'Below normal' },
];
const monthRange = (cp) => (cp.len === 1 ? MONTHS[cp.start] : `${MONTHS[cp.start]}–${MONTHS[cp.months[cp.len - 1]]}`);

/** One-line status: how unusual is right now, and where are we relative to the critical fire period? */
function renderStatus() {
  const el = document.getElementById('status');
  const { agg } = state;
  if (!agg) return;
  const meds = monthlyMedians(agg, 'harm');
  const nowDate = state.live ? new Date(`${state.live.to}T00:00:00Z`) : new Date(`${agg.lastDate}T00:00:00Z`);
  const m = nowDate.getUTCMonth();

  // 1. how is now tracking? Prefer live (freshest); fall back to the archive's in-progress month pace.
  let ratio = null, basis = '', typical = 0, now = 0;
  if (state.live) {
    const c = liveComparison(state.live, meds[m].median, m);
    ratio = c.ratio; typical = c.typicalPeriod; now = c.n20eq;
    basis = `the last ${c.nDays} days (live NASA FIRMS)`;
  } else {
    const o = outlook(agg, 'harm');
    if (o.current) {
      ratio = (o.current.pace + 1) / (meds[m].median + 1); typical = meds[m].median; now = o.current.pace;
      basis = `${MONTHS[m]} so far (to ${agg.lastDate})`;
    }
  }
  const quiet = typical < 3 && now < 3;
  const lv = ratio == null ? null : quiet ? { key: 'quiet', icon: '○', label: 'Quiet' } : STATUS_LEVELS.find((l) => ratio >= l.min);
  const head = lv
    ? `<span class="status-badge">${lv.icon} ${lv.label}</span> <span>${quiet
      ? `Little or no fire over ${basis}, which is normal here for this time of year.`
      : `Fire activity over ${basis} is <b>${ratioText(ratio)}</b>${ratio >= 1 ? '' : ' of'} a typical ${MONTHS[m]}.`}</span>`
    : '<span class="status-badge">… Checking</span> <span>Waiting for live data.</span>';

  // 2. critical period
  const cp = criticalPeriod(agg, 'harm');
  let cpText;
  if (!cp) cpText = 'This area has too little fire on record to define a critical period.';
  else if (cp.diffuse) cpText = 'Fire here is spread across most of the year. There is no single critical period.';
  else {
    const pos = cp.months.indexOf(m);
    const until = (cp.start - m + 12) % 12;
    const when = pos >= 0
      ? `It is <b>in progress</b> (month ${pos + 1} of ${cp.len}).`
      : until === 1 ? 'It <b>starts next month</b>.' : `It starts in ${until} months.`;
    cpText = `Critical period: <b>${monthRange(cp)}</b>, which holds ${cp.pct}% of all fire on record here. ${when}`;
  }
  el.className = `status status-${lv ? lv.key : 'pending'}`;
  el.innerHTML = `<div class="status-line">${head}</div><div class="status-line status-cp">${cpText}</div>`;
}

const drawn = new L.FeatureGroup().addTo(map);
map.addControl(new L.Control.Draw({
  position: 'topleft',
  draw: {
    polyline: false, marker: false, circlemarker: false,
    // showArea: false — leaflet-draw 1.0.4's readableArea() assigns an undeclared variable and throws in strict-mode bundles
    rectangle: { shapeOptions: SHAPE_STYLE, showArea: false },
    polygon: { shapeOptions: SHAPE_STYLE, allowIntersection: false },
    circle: { shapeOptions: SHAPE_STYLE, metric: true },
  },
  edit: { featureGroup: drawn, edit: false, remove: false },
}));

/** Circle as a polygon (good enough at these scales). */
function circleArea(lat, lon, rKm) {
  const poly = d3.range(64).map((i) => {
    const t = (i / 64) * 2 * Math.PI;
    return [lat + (rKm / 110.574) * Math.cos(t), lon + (rKm / (111.32 * Math.cos((lat * Math.PI) / 180))) * Math.sin(t)];
  });
  const lats = poly.map((p) => p[0]), lons = poly.map((p) => p[1]);
  return {
    bbox: { s: d3.min(lats), n: d3.max(lats), w: d3.min(lons), e: d3.max(lons) },
    poly, circle: { lat, lon, r: rKm },
  };
}

map.on(L.Draw.Event.CREATED, (e) => {
  if (e.layerType === 'circle') {
    const c = e.layer.getLatLng(), r = e.layer.getRadius() / 1000;
    return setArea(circleArea(c.lat, c.lng, r), `Circle, ${Math.round(r)} km around ${c.lat.toFixed(2)}°, ${c.lng.toFixed(2)}°`, null, false);
  }
  const ll = e.layer.getLatLngs()[0];
  const b = e.layer.getBounds();
  const bbox = { s: b.getSouth(), n: b.getNorth(), w: b.getWest(), e: b.getEast() };
  const isRect = e.layerType === 'rectangle';
  setArea({ bbox, poly: isRect ? null : ll.map((p) => [p.lat, p.lng]) }, isRect ? 'Drawn rectangle' : 'Drawn polygon', null, false);
});

function showShape(area) {
  drawn.clearLayers();
  const shape = area.circle
    ? L.circle([area.circle.lat, area.circle.lon], { ...SHAPE_STYLE, radius: area.circle.r * 1000 })
    : area.polys
      ? L.polygon(area.polys.map((p) => [p.outer, ...p.holes]), SHAPE_STYLE)
      : area.poly
      ? L.polygon(area.poly, SHAPE_STYLE)
      : L.rectangle([[area.bbox.s, area.bbox.w], [area.bbox.n, area.bbox.e]], SHAPE_STYLE);
  drawn.addLayer(shape);
  if (area.circle) drawn.addLayer(L.circleMarker([area.circle.lat, area.circle.lon], { radius: 3, color: '#e8590c', fillOpacity: 1 }));
  return shape;
}

// ---------------------------------------------------------------- selection UI
const presetsEl = document.getElementById('presets');
for (const p of PRESETS) {
  const b = document.createElement('button');
  b.textContent = p.name;
  b.dataset.id = p.id;
  b.onclick = () => setArea({ bbox: p.bbox }, p.name, p.focus, true, p.id);
  presetsEl.appendChild(b);
}

const bboxForm = document.getElementById('bbox-form');
const pointForm = document.getElementById('point-form');
document.getElementById('input-seg').addEventListener('click', (e) => {
  const v = e.target.dataset?.v;
  if (!v) return;
  e.currentTarget.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  pointForm.hidden = v !== 'point';
  bboxForm.hidden = v !== 'box';
});

bboxForm.onsubmit = (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(bboxForm));
  const bbox = { s: +f.s, n: +f.n, w: +f.w, e: +f.e };
  if (bbox.s >= bbox.n || bbox.w >= bbox.e) return alert('Min must be smaller than max.');
  setArea({ bbox }, `Box ${bbox.s}°, ${bbox.w}° → ${bbox.n}°, ${bbox.e}°`, null, true);
};

pointForm.onsubmit = (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(pointForm));
  const lat = +f.lat, lon = +f.lon, r = +f.r;
  setArea(circleArea(lat, lon, r), `${r} km around ${lat.toFixed(3)}°, ${lon.toFixed(3)}°`, null, true);
};

function fillForms(area) {
  const b = area.bbox;
  for (const k of ['s', 'n', 'w', 'e']) bboxForm.elements[k].value = b[k].toFixed(2);
  const c = area.circle ?? { lat: (b.s + b.n) / 2, lon: (b.w + b.e) / 2, r: null };
  pointForm.elements.lat.value = c.lat.toFixed(3);
  pointForm.elements.lon.value = c.lon.toFixed(3);
  if (c.r) pointForm.elements.r.value = Math.round(c.r);
}

function areaKm2(area) {
  if (area.circle) return Math.PI * area.circle.r ** 2;
  const { s, n, w, e } = area.bbox;
  const R = 6371;
  const box = (Math.PI / 180) * R * R * Math.abs(Math.sin((n * Math.PI) / 180) - Math.sin((s * Math.PI) / 180)) * Math.abs(e - w);
  const ringKm2 = (ring) => {
    const pts = ring.map(([la, lo]) => [lo * Math.cos((la * Math.PI) / 180) * 111.32, la * 110.57]);
    let a = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
    return Math.abs(a / 2);
  };
  if (area.polys) return d3.sum(area.polys, (p) => ringKm2(p.outer) - d3.sum(p.holes, ringKm2));
  if (!area.poly) return box;
  return ringKm2(area.poly);
}

// ---------------------------------------------------------------- GeoJSON boundary upload (file picker or drop on map)
const geoMsg = document.getElementById('geo-msg');
async function loadBoundaryFile(file) {
  if (!file) return;
  if (file.size > 25e6) { geoMsg.textContent = 'That file is over 25 MB. Please simplify it first (e.g. at mapshaper.org).'; return; }
  try {
    const g = parseGeoJSON(JSON.parse(await file.text()));
    const parts = g.polys.length;
    geoMsg.textContent = `Loaded ${parts} polygon${parts > 1 ? 's' : ''} from ${file.name}.`;
    await setArea({ bbox: g.bbox, polys: g.polys }, `Uploaded: ${g.name ?? file.name.replace(/\.(geo)?json$/i, '')}`, null, true);
  } catch (err) {
    geoMsg.textContent = err instanceof SyntaxError ? `${file.name} is not valid JSON.` : err.message;
  }
}
document.getElementById('geo-file').addEventListener('change', (e) => { loadBoundaryFile(e.target.files[0]); e.target.value = ''; });
const mapEl = document.getElementById('map');
mapEl.addEventListener('dragover', (e) => { e.preventDefault(); mapEl.classList.add('drop'); });
mapEl.addEventListener('dragleave', () => mapEl.classList.remove('drop'));
mapEl.addEventListener('drop', (e) => {
  e.preventDefault();
  mapEl.classList.remove('drop');
  loadBoundaryFile(e.dataTransfer.files[0]);
});

async function setArea(area, label, focusYm, fit, presetId = null) {
  state.area = area;
  state.label = label;
  state.presetId = presetId;
  const shape = showShape(area);
  if (fit) map.fitBounds(shape.getBounds(), { padding: [20, 20], maxZoom: 9 });
  fillForms(area);
  presetsEl.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.id === presetId));
  const info = document.getElementById('area-info');
  info.innerHTML = '<span class="spinner"></span> Loading…';

  state.agg = await aggregate(area);
  const { agg } = state;
  if (state.from == null) { state.from = agg.ym0; state.to = agg.ym1; }
  if (state.pendingRange) { [state.from, state.to] = state.pendingRange; state.pendingRange = null; }
  setRange(state.from, state.to, false);
  const lastComplete = agg.partialLast ? agg.ym1 - 1 : agg.ym1;
  state.selected = clampSel(focusYm ?? Math.min(lastComplete, state.to));
  info.innerHTML = `<b>${label}</b><br>${d3.format(',.0f')(areaKm2(area))} km² · ${agg.cells.toLocaleString()} active 0.1° cells`;
  updateHash();
  state.live = null; // don't show the previous area's live data while the new one loads
  document.getElementById('results').hidden = false; // unhide first so charts measure their real width
  render();
  loadLive();
}

// ---------------------------------------------------------------- date range
const sel = (id) => document.getElementById(id);
const ymOf = (y, m) => (y - 2000) * 12 + m;
const ymKey = (ym) => `${ymYear(ym)}-${String(ymMonth(ym) + 1).padStart(2, '0')}`;
const parseYm = (s) => { const [y, m] = s.split('-').map(Number); return ymOf(y, m - 1); };

async function initRangeControls() {
  const idx = await loadIndex();
  const years = d3.range(ymYear(idx.ym_first), ymYear(idx.ym_last) + 1);
  for (const id of ['from-m', 'to-m']) sel(id).innerHTML = MONTHS.map((m, i) => `<option value="${i}">${m}</option>`).join('');
  for (const id of ['from-y', 'to-y']) sel(id).innerHTML = years.map((y) => `<option>${y}</option>`).join('');
  const onChange = (which) => () => {
    let from = ymOf(+sel('from-y').value, +sel('from-m').value);
    let to = ymOf(+sel('to-y').value, +sel('to-m').value);
    if (from > to) { if (which === 'from') to = from; else from = to; }
    setRange(from, to, true);
  };
  for (const id of ['from-m', 'from-y']) sel(id).onchange = onChange('from');
  for (const id of ['to-m', 'to-y']) sel(id).onchange = onChange('to');
  sel('range-quick').addEventListener('click', (e) => {
    const q = e.target.dataset?.q;
    if (!q || !state.agg) return;
    const { ym0, ym1 } = state.agg;
    const ranges = {
      all: [ym0, ym1],
      '10y': [ymOf(ymYear(ym1) - 10, 0), ym1],
      modis: [ym0, ymOf(2011, 11)],
      viirs: [ymOf(2012, 0), ym1],
    };
    setRange(...ranges[q], true);
  });
}

function setRange(from, to, rerender) {
  const agg = state.agg;
  if (agg) { from = Math.max(agg.ym0, Math.min(agg.ym1, from)); to = Math.max(from, Math.min(agg.ym1, to)); }
  state.from = from; state.to = to;
  sel('from-m').value = ymMonth(from); sel('from-y').value = ymYear(from);
  sel('to-m').value = ymMonth(to); sel('to-y').value = ymYear(to);
  if (agg) {
    const { ym0, ym1 } = agg;
    const active = from === ym0 && to === ym1 ? 'all'
      : from === ymOf(ymYear(ym1) - 10, 0) && to === ym1 ? '10y'
        : from === ym0 && to === ymOf(2011, 11) ? 'modis'
          : from === ymOf(2012, 0) && to === ym1 ? 'viirs' : null;
    sel('range-quick').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.q === active));
  }
  if (rerender && agg) {
    state.selected = clampSel(state.selected);
    updateHash();
    render();
  }
}

function clampSel(ym) {
  const agg = state.agg;
  const lastComplete = agg.partialLast ? agg.ym1 - 1 : agg.ym1;
  if (ym == null || ym < state.from || ym > state.to) ym = Math.min(state.to, lastComplete);
  return Math.max(state.from, ym);
}

function updateHash() {
  const b = state.area.bbox;
  const q = new URLSearchParams();
  if (state.presetId) q.set('preset', state.presetId);
  else if (state.area.circle) q.set('pt', [state.area.circle.lat, state.area.circle.lon, state.area.circle.r].map((v) => +v.toFixed(3)).join(','));
  else if (state.area.poly) q.set('poly', state.area.poly.map((p) => p.map((v) => v.toFixed(3)).join(':')).join(';'));
  else q.set('bbox', [b.s, b.n, b.w, b.e].map((v) => v.toFixed(3)).join(','));
  if (state.agg && (state.from !== state.agg.ym0 || state.to !== state.agg.ym1)) {
    q.set('from', ymKey(state.from));
    q.set('to', ymKey(state.to));
  }
  history.replaceState(null, '', `#/?${q}`);
}

// ---------------------------------------------------------------- results controls
function segment(id, key) {
  const el = document.getElementById(id);
  el.addEventListener('click', (e) => {
    const v = e.target.dataset?.v;
    if (!v) return;
    state[key] = v;
    el.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
    render();
  });
}
segment('metric-seg', 'series');
segment('mode-seg', 'mode');

const slug = () => state.label.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').toLowerCase();
const rangeSlug = () => `${ymKey(state.from)}_${ymKey(state.to)}`;
const rangeText = () => `${ymLabel(state.from)} – ${state.to === state.agg.ym1 && state.agg.partialLast ? state.agg.lastDate : ymLabel(state.to)}`;

function saveText(text, filename) {
  const blob = new Blob([text], { type: 'text/csv' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const csvMenu = document.getElementById('csv-menu');
document.getElementById('csv-btn').onclick = (e) => { e.stopPropagation(); csvMenu.hidden = !csvMenu.hidden; };
document.addEventListener('click', () => { csvMenu.hidden = true; });
csvMenu.addEventListener('click', (e) => {
  const kind = e.target.dataset?.csv;
  if (!kind) return;
  const { agg, from, to, label } = state;
  if (kind === 'monthly') saveText(toCSV(agg, label, from, to, monthlyMedians(agg, 'harm')), `firewatch_${slug()}_${rangeSlug()}_monthly.csv`);
  else if (kind === 'cells') saveText(cellsCSV(agg, label, from, to), `firewatch_${slug()}_${rangeSlug()}_cells.csv`);
  else if (kind === 'live') {
    if (!state.live) return alert('Live data has not loaded yet.');
    saveText(liveCSV(state.live, label), `firewatch_${slug()}_live_${state.live.from}_${state.live.to}.csv`);
  }
});

document.querySelectorAll('button.png').forEach((btn) => {
  btn.onclick = () => {
    const which = btn.dataset.png;
    const titles = {
      calendar: 'Burning-activity calendar',
      anomaly: document.getElementById('anom-title').textContent,
      season: 'Seasonal profile',
      annual: 'Annual totals',
    };
    const svgs = which === 'calendar'
      ? [document.querySelector('#calendar svg'), document.querySelector('#cal-legend svg')]
      : [document.querySelector(`#${which} svg`)];
    downloadPNG(svgs, {
      title: `${state.label} — ${titles[which]}`,
      subtitle: `${SERIES_NAME[state.series]}${state.mode === 'anom' && which === 'calendar' ? ' (anomaly vs typical month)' : ''} · ${rangeText()}`,
      filename: `firewatch_${slug()}_${which}.png`,
    });
  };
});

function select(ym) {
  state.selected = clampSel(ym);
  render();
}

// ---------------------------------------------------------------- render
function render() {
  const { agg, series, mode, selected, from, to } = state;
  if (!agg) return;
  document.getElementById('area-title').textContent = state.label;
  document.getElementById('area-sub').textContent = `${SERIES_NAME[series]} per month, ${rangeText()}. Click any month to compare it with its history.`;
  document.getElementById('cal-hint').textContent = mode === 'anom' ? '· colour = this month vs the median for that calendar month' : '· colour = detections per month';
  const yrs = completeYears(agg, series, from, to);
  const tr = trend(yrs);
  renderStats(tr, yrs);
  renderStatus();
  renderLive();
  renderOutlook();
  drawCalendar(document.getElementById('calendar'), document.getElementById('cal-legend'), agg, { series, mode, selected, onSelect: select, from, to });
  drawAnomaly(document.getElementById('anomaly'), document.getElementById('anom-title'), agg, { series, selected });
  drawSeason(document.getElementById('season'), agg, { series, selected });
  drawAnnual(document.getElementById('annual'), agg, { series, selected, onSelect: select, from, to, trend: tr });
}

let trustByTile = null;
const SNPP_START_YM = 12 * 12 + 1; // Feb 2012: before this the harmonised series is MODIS × k

/** 90% range for a MODIS-era harmonised month: each cell's value × its 1° tile's out-of-sample lo/hi multipliers (trust.json). */
function bandFor(ym) {
  const { agg, series } = state;
  if (series !== 'harm' || ym >= SNPP_START_YM || !trustByTile) return null;
  let lo = 0, hi = 0, tot = 0;
  for (const c of agg.cellList) {
    const i = c.yms.indexOf(ym);
    if (i < 0) continue;
    const v = c.h[i], t = trustByTile[`${Math.floor(c.cy / 10)}_${Math.floor(c.cx / 10)}`];
    tot += v; lo += v * (t ? t.lo : 1); hi += v * (t ? t.hi : 1);
  }
  return tot > 0 ? { lo, hi } : null;
}

const ratioText = (r) => (r >= 1 ? `${r.toFixed(1)}×` : `${Math.round(r * 100)}%`);

function renderStats(tr, yrs) {
  const { agg, series, selected, from, to } = state;
  let total = 0, recM = { v: -1 };
  for (let ym = from; ym <= to; ym++) {
    const v = valueAt(agg, series, ym - agg.ym0);
    if (v == null) continue;
    total += v;
    if (v > recM.v) recM = { v, ym };
  }
  const recY = d3.greatest(yrs, (d) => d.t);
  const meds = monthlyMedians(agg, series);
  const peak = d3.maxIndex(meds, (d) => d.median);
  const vSel = valueAt(agg, series, selected - agg.ym0) ?? 0;
  const ratio = (vSel + 1) / (meds[ymMonth(selected)].median + 1);
  const band = bandFor(selected);
  let trendTile;
  if (!tr) trendTile = ['Trend', '—', 'needs 8+ complete years in range'];
  else {
    const sig = tr.p < 0.05;
    const dir = tr.slope > 0 ? 'rising' : 'falling';
    trendTile = [`Trend ${tr.y0}–${tr.y1}`, (() => { const v = Math.abs(tr.pctPerYear) < 0.05 ? 0 : tr.pctPerYear; return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}%/yr`; })(),
      sig ? `${dir}, significant (p = ${tr.p.toFixed(3)})` : `no significant trend (p = ${tr.p.toFixed(2)})`];
  }
  const tiles = [
    ['Total detections (hot pixels)', fmtN(total), rangeText()],
    ['Typical peak month', MONTHS[peak], `median ${fmtN(meds[peak].median)} · includes planned burns &amp; crop fires`],
    ['Record year', recY ? recY.y : '—', recY ? `${fmtN(recY.t)} detections (complete years)` : 'no complete year in range'],
    ['Record month', recM.ym != null ? ymLabel(recM.ym) : '—', `${fmtN(recM.v)} detections`],
    [ymLabel(selected), fmtN(vSel), `${ratioText(ratio)} of typical ${MONTHS[ymMonth(selected)]}${band ? ` · 90% range ${fmtN(band.lo)}–${fmtN(band.hi)}` : ''}`],
    trendTile,
  ];
  document.getElementById('stats').innerHTML = tiles
    .map(([k, v, s], i) => `<div class="stat${i === 4 ? ' hl' : ''}"${i === 5 ? ' title="Theil–Sen slope of annual totals, relative to the median year; significance from the Mann–Kendall test"' : ''}><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join('');

  // plain-English summary
  const mSel = MONTHS[ymMonth(selected)];
  const recRatio = recM.ym != null ? (recM.v + 1) / (meds[ymMonth(recM.ym)].median + 1) : null;
  const parts = [`Fire activity in <b>${state.label}</b> usually peaks in <b>${MONTHS[peak]}</b>.`];
  if (recY) parts.push(`The most active complete year in this range was <b>${recY.y}</b> (${fmtN(recY.t)} detections).`);
  if (recRatio) parts.push(`The single biggest month was <b>${ymLabel(recM.ym)}</b>, ${ratioText(recRatio)} a typical ${MONTHS[ymMonth(recM.ym)]}.`);
  parts.push(`<b>${ymLabel(selected)}</b> had ${fmtN(vSel)} detections, ${ratioText(ratio)} of a typical ${mSel}${band ? ` (90% range ${fmtN(band.lo)}–${fmtN(band.hi)}, as it predates VIIRS)` : ''}.`);
  if (tr) parts.push(tr.p < 0.05
    ? `Since ${tr.y0}, activity has been <b>${tr.slope > 0 ? 'rising' : 'falling'}</b> by about ${Math.abs(tr.pctPerYear).toFixed(1)}% a year (significant).`
    : `There is no significant long-term trend since ${tr.y0}.`);
  document.getElementById('summary').innerHTML = parts.join(' ');
}

const LEVEL_TEXT = { high: 'Often severe', moderate: 'Sometimes severe', low: 'Rarely severe' };

function renderOutlook() {
  const { agg, series } = state;
  const o = outlook(agg, series);
  const cards = o.months.map((mo, i) => {
    const lv = level(mo.pHigh);
    const isNow = i === 0 && o.current;
    const head = isNow
      ? `<div class="ol-when">${ymLabel(mo.ym)} <span class="ol-tag">in progress</span></div>
         <div class="ol-now">${fmtN(o.current.soFar)} so far <span class="muted">(1–${o.current.day} ${MONTHS[mo.m]})</span><br>
         on pace for ~${fmtN(o.current.pace)} · <b>${ratioText((o.current.pace + 1) / (mo.median + 1))}</b> of typical</div>`
      : `<div class="ol-when">${ymLabel(mo.ym)}</div>`;
    return `<div class="ol-card ol-${lv}">
      ${head}
      <div class="ol-chip">${LEVEL_TEXT[lv]}</div>
      <div class="ol-row"><span>Typical</span><b>${fmtN(mo.median)}</b></div>
      <div class="ol-row"><span>Usual range</span><b>${fmtN(mo.p25)}–${fmtN(mo.p75)}</b></div>
      <div class="ol-row"><span>Severe month in</span><b>${mo.nHigh} of ${mo.n} years</b></div>
      <div class="ol-row"><span>Worst on record</span><b>${mo.top ? `${mo.top.y} (${fmtN(mo.top.v)})` : '—'}</b></div>
    </div>`;
  }).join('');
  const r = o.recent;
  const word = r.ratio >= 1.5 ? 'above normal' : r.ratio <= 0.67 ? 'below normal' : 'near normal';
  document.getElementById('outlook').innerHTML = `
    <div class="ol-grid">${cards}</div>
    <p class="ol-foot"><b>Recent conditions:</b> ${ymLabel(r.from)} – ${ymLabel(r.to)} had ${fmtN(r.v)} detections,
      <b>${ratioText(r.ratio)}</b> of typical (${word}).
      <span class="muted">“Severe” = above this area's 90th-percentile month (${fmtN(o.high)} detections). Likelihood: often ≥ 40% of years, sometimes 15–40%, rarely &lt; 15%.</span></p>`;
}

let rt;
addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(render, 150); });

// ---------------------------------------------------------------- routing
function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const [path, query] = h.split('?');
  const name = path === 'method' ? 'method' : path === 'about' ? 'about' : 'explore';
  for (const v of ['explore', 'method', 'about']) document.getElementById(`view-${v}`).hidden = v !== name;
  document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('on', a.dataset.route === name));
  if (name === 'method') renderMethod(document.getElementById('view-method'));
  if (name === 'about') renderAbout(document.getElementById('view-about'));
  if (name === 'explore') {
    map.invalidateSize();
    if (!state.area) initialArea(new URLSearchParams(query ?? ''));
  }
  scrollTo(0, 0);
}

function initialArea(q) {
  if (q.get('from') && q.get('to')) state.pendingRange = [parseYm(q.get('from')), parseYm(q.get('to'))];
  if (q.get('pt')) {
    const [lat, lon, r] = q.get('pt').split(',').map(Number);
    return setArea(circleArea(lat, lon, r), `${r} km around ${lat.toFixed(3)}°, ${lon.toFixed(3)}°`, null, true);
  }
  if (q.get('bbox')) {
    const [s, n, w, e] = q.get('bbox').split(',').map(Number);
    return setArea({ bbox: { s, n, w, e } }, 'Shared area', null, true);
  }
  if (q.get('poly')) {
    const poly = q.get('poly').split(';').map((p) => p.split(':').map(Number));
    const lats = poly.map((p) => p[0]), lons = poly.map((p) => p[1]);
    const bbox = { s: Math.min(...lats), n: Math.max(...lats), w: Math.min(...lons), e: Math.max(...lons) };
    return setArea({ bbox, poly }, 'Shared polygon', null, true);
  }
  const p = PRESETS.find((pp) => pp.id === q.get('preset')) ?? PRESETS[0];
  setArea({ bbox: p.bbox }, p.name, p.focus, true, p.id);
}

await initRangeControls();
addEventListener('hashchange', route);
route();
