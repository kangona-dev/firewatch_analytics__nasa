import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet-draw/dist/leaflet.draw.css';
import * as d3 from 'd3';
import './style.css';
import { aggregate, loadIndex, loadOverview, toCSV, ymLabel, ymYear, ymMonth, MONTHS } from './data.js';
import { drawCalendar, drawAnomaly, drawSeason, drawAnnual, monthlyMedians, valueAt, fmtN } from './charts.js';
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

const state = { area: null, label: '', agg: null, series: 'harm', mode: 'count', selected: null, index: null };

// ---------------------------------------------------------------- map
const map = L.map('map', { zoomSnap: 0.25, minZoom: 3, maxBounds: [[-50, 100], [0, 170]] }).fitBounds([[-44, 112], [-10, 154]]);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 13,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · Fire data: NASA FIRMS',
}).addTo(map);

const fireRamp = (t) => d3.interpolateInferno(0.12 + 0.83 * t);

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
  L.control.layers(null, { 'All-time fire density (harmonised)': layer }, { collapsed: true, position: 'topright' }).addTo(map);
  document.getElementById('map-legend').innerHTML =
    `<span>All-time detections per 0.25°</span><i style="background:linear-gradient(90deg,${d3.range(0, 1.01, 0.2).map(fireRamp).join(',')})"></i><span class="lg-ends"><b>1</b><b>${d3.format('.2s')(maxV)}</b></span>`;
});

const drawn = new L.FeatureGroup().addTo(map);
map.addControl(new L.Control.Draw({
  position: 'topleft',
  draw: {
    polyline: false, circle: false, marker: false, circlemarker: false,
    // showArea: false — leaflet-draw 1.0.4's readableArea() assigns an undeclared variable and throws in strict-mode bundles
    rectangle: { shapeOptions: { color: '#e8590c', weight: 2 }, showArea: false },
    polygon: { shapeOptions: { color: '#e8590c', weight: 2 }, allowIntersection: false },
  },
  edit: { featureGroup: drawn, edit: false, remove: false },
}));

map.on(L.Draw.Event.CREATED, (e) => {
  const ll = e.layer.getLatLngs()[0];
  const b = e.layer.getBounds();
  const bbox = { s: b.getSouth(), n: b.getNorth(), w: b.getWest(), e: b.getEast() };
  const isRect = e.layerType === 'rectangle';
  setArea({ bbox, poly: isRect ? null : ll.map((p) => [p.lat, p.lng]) }, isRect ? 'Drawn rectangle' : 'Drawn polygon', null, false);
});

function showShape(area) {
  drawn.clearLayers();
  const style = { color: '#e8590c', weight: 2, fillOpacity: 0.05 };
  const shape = area.poly
    ? L.polygon(area.poly, style)
    : L.rectangle([[area.bbox.s, area.bbox.w], [area.bbox.n, area.bbox.e]], style);
  drawn.addLayer(shape);
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

const form = document.getElementById('bbox-form');
form.onsubmit = (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(form));
  const bbox = { s: +f.s, n: +f.n, w: +f.w, e: +f.e };
  if (bbox.s >= bbox.n || bbox.w >= bbox.e) return alert('Min must be smaller than max.');
  setArea({ bbox }, `Box ${bbox.s}°, ${bbox.w}° → ${bbox.n}°, ${bbox.e}°`, null, true);
};

function fillForm(b) {
  for (const k of ['s', 'n', 'w', 'e']) form.elements[k].value = b[k].toFixed(2);
}

function areaKm2(area) {
  const { s, n, w, e } = area.bbox;
  const R = 6371;
  const box = (Math.PI / 180) * R * R * Math.abs(Math.sin((n * Math.PI) / 180) - Math.sin((s * Math.PI) / 180)) * Math.abs(e - w);
  if (!area.poly) return box;
  // shoelace on an equal-area-ish projection (fine for display)
  const pts = area.poly.map(([la, lo]) => [lo * Math.cos((la * Math.PI) / 180) * 111.32, la * 110.57]);
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
  return Math.abs(a / 2);
}

async function setArea(area, label, focusYm, fit, presetId = null) {
  state.area = area;
  state.label = label;
  const shape = showShape(area);
  if (fit) map.fitBounds(shape.getBounds(), { padding: [20, 20], maxZoom: 9 });
  fillForm(area.bbox);
  presetsEl.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.id === presetId));
  const info = document.getElementById('area-info');
  info.innerHTML = '<span class="spinner"></span> Loading…';

  state.index ??= await loadIndex();
  state.agg = await aggregate(area);
  const lastComplete = state.agg.partialLast ? state.agg.ym1 - 1 : state.agg.ym1;
  state.selected = focusYm ?? lastComplete;
  info.innerHTML = `<b>${label}</b><br>${d3.format(',.0f')(areaKm2(area))} km² · ${state.agg.cells.toLocaleString()} active 0.1° cells`;
  updateHash(presetId);
  render();
  document.getElementById('results').hidden = false;
}

function updateHash(presetId) {
  const b = state.area.bbox;
  const q = new URLSearchParams();
  if (presetId) q.set('preset', presetId);
  else if (state.area.poly) q.set('poly', state.area.poly.map((p) => p.map((v) => v.toFixed(3)).join(':')).join(';'));
  else q.set('bbox', [b.s, b.n, b.w, b.e].map((v) => v.toFixed(3)).join(','));
  history.replaceState(null, '', `#/?${q}`);
}

// ---------------------------------------------------------------- render results
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

document.getElementById('csv-btn').onclick = () => {
  const blob = new Blob([toCSV(state.agg, state.label)], { type: 'text/csv' });
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: `firewatch_${state.label.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}.csv`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
};

function select(ym) {
  state.selected = ym;
  render();
}

function render() {
  const { agg, series, mode, selected } = state;
  if (!agg) return;
  const seriesName = { harm: 'harmonised VIIRS-equivalent detections', modis: 'raw MODIS detections', snpp: 'raw VIIRS S-NPP detections', n20: 'raw VIIRS NOAA-20 detections' }[series];
  document.getElementById('area-title').textContent = state.label;
  document.getElementById('area-sub').textContent = `Monthly ${seriesName}, ${ymLabel(agg.ym0)} – ${agg.lastDate}. Click any month to compare it with its history.`;
  document.getElementById('cal-hint').textContent = mode === 'anom' ? '· colour = how this month compares with the median for that calendar month' : '· colour = detections per month';
  renderStats();
  drawCalendar(document.getElementById('calendar'), document.getElementById('cal-legend'), agg, { series, mode, selected, onSelect: select });
  drawAnomaly(document.getElementById('anomaly'), document.getElementById('anom-title'), agg, { series, selected });
  drawSeason(document.getElementById('season'), agg, { series, selected });
  drawAnnual(document.getElementById('annual'), agg, { series, selected, onSelect: select });
}

function renderStats() {
  const { agg, series, selected } = state;
  let total = 0, recM = { v: -1 }, years = new Map();
  for (let k = 0; k < agg.harm.length; k++) {
    const v = valueAt(agg, series, k);
    if (v == null) continue;
    const ym = agg.ym0 + k;
    total += v;
    if (v > recM.v) recM = { v, ym };
    years.set(ymYear(ym), (years.get(ymYear(ym)) ?? 0) + v);
  }
  // record year among complete years only
  const y0 = ymYear(agg.ym0), y1 = ymYear(agg.ym1);
  let recY = { v: -1 };
  for (const [y, v] of years) if (y > y0 && y < y1 && v > recY.v) recY = { y, v };
  const meds = monthlyMedians(agg, series);
  const peak = d3.maxIndex(meds, (d) => d.median);
  const vSel = valueAt(agg, series, selected - agg.ym0) ?? 0;
  const ratio = (vSel + 1) / (meds[ymMonth(selected)].median + 1);
  const tiles = [
    ['Total detections', fmtN(total), `${ymYear(agg.ym0)}–${y1}`],
    ['Peak fire month', MONTHS[peak], `median ${fmtN(meds[peak].median)} detections`],
    ['Record year', recY.y ?? '—', recY.y ? `${fmtN(recY.v)} detections` : ''],
    ['Record month', recM.ym != null ? ymLabel(recM.ym) : '—', `${fmtN(recM.v)} detections`],
    [ymLabel(selected), fmtN(vSel), `${ratio >= 1 ? ratio.toFixed(1) + '×' : Math.round(ratio * 100) + '%'} of typical ${MONTHS[ymMonth(selected)]}`],
  ];
  document.getElementById('stats').innerHTML = tiles
    .map(([k, v, s], i) => `<div class="stat${i === 4 ? ' hl' : ''}"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join('');
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
  const preset = PRESETS.find((p) => p.id === q.get('preset'));
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
  const p = preset ?? PRESETS[0];
  setArea({ bbox: p.bbox }, p.name, p.focus, true, p.id);
}

addEventListener('hashchange', route);
route();
