// Data loading + area aggregation. All files are static JSON produced by pipeline/04_export.py.
const BASE = `${import.meta.env.BASE_URL}data/`;
const tileCache = new Map();

export const SRC_NAMES = ['MODIS (scaled to VIIRS)', 'VIIRS S-NPP', 'VIIRS NOAA-20 (calibrated)'];
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const ymYear = (ym) => 2000 + Math.floor(ym / 12);
export const ymMonth = (ym) => ym % 12; // 0-based
export const ymLabel = (ym) => `${MONTHS[ymMonth(ym)]} ${ymYear(ym)}`;

let indexPromise;
export function loadIndex() {
  indexPromise ??= fetch(`${BASE}index.json`).then((r) => r.json());
  return indexPromise;
}
export const loadOverview = () => fetch(`${BASE}overview.json`).then((r) => r.json());
export const loadValidation = () => fetch(`${BASE}validation.json`).then((r) => r.json());

function loadTile(ty, tx) {
  const key = `${ty}_${tx}`;
  if (!tileCache.has(key)) {
    tileCache.set(key, fetch(`${BASE}tiles/${key}.json`).then((r) => r.json()));
  }
  return tileCache.get(key);
}

// Ray-casting point-in-polygon; poly = [[lat, lon], ...]
function inPoly(lat, lon, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i], [yj, xj] = poly[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Aggregate all 0.1° cells whose centre lies inside `area`.
 * area = { bbox: {s, n, w, e}, poly?: [[lat, lon], ...] }
 * Returns { ym0, ym1, harm[], modis[], snpp[], n20[], src[], cells, partialLast, lastDate }
 */
export async function aggregate(area) {
  const idx = await loadIndex();
  const { s, n, w, e } = area.bbox;
  const have = new Set(idx.tiles.map(([ty, tx]) => `${ty}_${tx}`));
  const jobs = [];
  for (let ty = Math.floor(s); ty <= Math.floor(n - 1e-9); ty++) {
    for (let tx = Math.floor(w); tx <= Math.floor(e - 1e-9); tx++) {
      if (have.has(`${ty}_${tx}`)) jobs.push(loadTile(ty, tx));
    }
  }
  const tiles = await Promise.all(jobs);
  const ym0 = idx.ym_first, ym1 = idx.ym_last, len = ym1 - ym0 + 1;
  const out = {
    ym0, ym1,
    harm: new Float64Array(len), modis: new Float64Array(len),
    snpp: new Float64Array(len), n20: new Float64Array(len),
    src: idx.src_by_ym, cells: 0, partialLast: idx.partial_last_month, lastDate: idx.last_detection_date,
  };
  for (const tile of tiles) {
    for (const [cy, cx, yms, h, m, sn, nn] of tile.cells) {
      const lat = (cy + 0.5) / 10, lon = (cx + 0.5) / 10;
      if (lat < s || lat > n || lon < w || lon > e) continue;
      if (area.poly && !inPoly(lat, lon, area.poly)) continue;
      out.cells++;
      for (let i = 0; i < yms.length; i++) {
        const k = yms[i] - ym0;
        if (k < 0 || k >= len) continue;
        out.harm[k] += h[i]; out.modis[k] += m[i]; out.snpp[k] += sn[i]; out.n20[k] += nn[i];
      }
    }
  }
  return out;
}

// Which months is a sensor actually operating? (null = no data, distinct from 0 = no fires)
export function available(series, ym) {
  if (series === 'snpp') return ym >= 12 * 12; // Jan 2012 (partial)
  if (series === 'n20') return ym >= 18 * 12 + 3;
  return true;
}

export function toCSV(agg, areaLabel) {
  const rows = [
    `# Firewatch Analytics export — ${areaLabel}`,
    '# harmonised = VIIRS S-NPP-equivalent fire detections; source = sensor used for the harmonised value',
    '# Data: NASA FIRMS MODIS C6.1, VIIRS S-NPP 375m, VIIRS NOAA-20 375m (type=0 vegetation fires, nominal/high confidence)',
    'year,month,harmonised,source,modis_raw,viirs_snpp_raw,viirs_noaa20_raw',
  ];
  for (let ym = agg.ym0; ym <= agg.ym1; ym++) {
    const k = ym - agg.ym0;
    rows.push([
      ymYear(ym), ymMonth(ym) + 1, agg.harm[k].toFixed(1), SRC_NAMES[agg.src[k]],
      agg.modis[k], available('snpp', ym) ? agg.snpp[k] : '', available('n20', ym) ? agg.n20[k] : '',
    ].join(','));
  }
  return rows.join('\n');
}
